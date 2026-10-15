from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('migration', Path(__file__).with_name('migrate-execution-profiles.py'))
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def resource(self, **fields):
        return dict(id='workspace', pool='pool', profile='v1', state='suspended',
                    desiredState='suspended', version='observed', identity={'incarnation': 'worker'},
                    execution=None, bindingGeneration=1, **fields)

    def test_release_migrate_and_resume_after_controller_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database, pools, ledger = root/'state.sqlite', root/'pools.json', root/'ledger.json'
            db = sqlite3.connect(database)
            self.addCleanup(db.close)
            db.execute('CREATE TABLE agent_runtime_workspaces(workspace_id TEXT PRIMARY KEY,pool_id TEXT,profile_id TEXT,admission_revision INTEGER,lifecycle_request_json TEXT)')
            db.execute('INSERT INTO agent_runtime_workspaces VALUES (?,?,?,?,?)', ('workspace','pool','v1',7,'{"profile":"v1"}'))
            db.commit()
            pools.write_text(json.dumps({'defaultPoolId':'pool','pools':[{'id':'pool','profile':'v2','url':'http://controller','tokenFile':'unused'}]}))
            current = self.resource()
            calls = []
            fail_once = [True]
            def request(pool, path, body=None, **kwargs):
                calls.append(path)
                if path.endswith('/migration'):
                    return 200, {'profile':current['profile'],'profileHash':'hash','revision':11,'epoch':4,'bindingGeneration':current['bindingGeneration'],'state':current['state']}
                if path.endswith('/state'):
                    self.assertEqual(kwargs, {'method':'PUT','version':'observed'})
                    self.assertEqual(body, {'desiredState':'released'})
                    current.update(state='released',desiredState='released',version='released',identity=None)
                    return 202, dict(current)
                if path.startswith('/v1/workspaces/'):
                    self.assertNotIn('?', path)
                    return 200, dict(current)
                if path == '/v1/profile-migrations':
                    self.assertEqual(body['expectedRevision'], 11)
                    if current['profile'] != 'v2':
                        current['bindingGeneration'] += 1
                    current['profile']='v2'
                    if fail_once[0]:
                        fail_once[0]=False
                        raise migration.MigrationError('simulated response loss after commit')
                    return 200, {}
                self.fail(path)
            with patch.object(migration, 'request', request):
                with self.assertRaises(migration.MigrationError):
                    migration.apply(database,pools,ledger,'v1','v2')
                self.assertEqual(db.execute('SELECT profile_id FROM agent_runtime_workspaces').fetchone()[0], 'v1')
                original_save = migration.save
                def fail_after_database_commit(path, value):
                    if any(entry.get('done') for entry in value.get('workspaces', {}).values()):
                        raise migration.MigrationError('simulated stop after database commit')
                    original_save(path, value)
                with patch.object(migration, 'save', fail_after_database_commit):
                    with self.assertRaises(migration.MigrationError):
                        migration.apply(database,pools,ledger,'v1','v2')
                self.assertEqual(db.execute('SELECT profile_id,admission_revision,lifecycle_request_json FROM agent_runtime_workspaces').fetchone(), ('v2',7,None))
                migration.apply(database,pools,ledger,'v1','v2')
                self.assertEqual(calls.count('/v1/workspaces/workspace/state'),1)
                with closing(sqlite3.connect(ledger.with_suffix('.sqlite-backup'))) as backup:
                    self.assertEqual(backup.execute('SELECT profile_id FROM agent_runtime_workspaces').fetchone()[0],'v1')
                db.execute('UPDATE agent_runtime_workspaces SET admission_revision=20')
                db.commit()
                migration.apply(database,pools,ledger,'v1','v2')
                completed = json.loads(ledger.read_text())
                for entry in completed['workspaces'].values():
                    entry['migration'].pop('expectedBindingGeneration')
                    entry['migration'].pop('operationId')
                ledger.write_text(json.dumps(completed))
                with patch.object(migration, 'request', side_effect=AssertionError('Completed legacy ledger must remain a no-op')):
                    migration.apply(database,pools,ledger,'v1','v2')

    def test_release_conflict_does_not_retry_a_newer_allocation(self):
        entry = {'before': {'workspace_id':'workspace','admission_revision':7}}
        current = self.resource()
        writes = []
        def request(pool, path, body=None, **kwargs):
            if path.endswith('/state'):
                writes.append(kwargs['version'])
                return 412, None
            return 200, dict(current)
        with patch.object(migration, 'request', request):
            with self.assertRaisesRegex(migration.MigrationError, '412'):
                migration.migrate_controller({'id':'pool'},entry,lambda:None,'v1','v2',1)
            current['version'] = 'newer'
            with self.assertRaisesRegex(migration.MigrationError, 'superseded'):
                migration.migrate_controller({'id':'pool'},entry,lambda:None,'v1','v2',1)
        self.assertEqual(writes, ['observed'])

    def test_lost_release_response_reconciles_observed_release(self):
        entry = {'before': {'workspace_id':'workspace','admission_revision':7}}
        current = self.resource()
        writes = []
        def request(pool, path, body=None, **kwargs):
            if path.endswith('/state'):
                writes.append(body)
                current.update(state='released',desiredState='released',version='released',identity=None)
                raise migration.MigrationError('response lost')
            if path.endswith('/migration'):
                return 200, {'profile':current['profile'],'profileHash':'hash','revision':11,'epoch':4,'bindingGeneration':current['bindingGeneration'],'state':'released'}
            if path == '/v1/profile-migrations':
                if current['profile'] != 'v2':
                    current['bindingGeneration'] += 1
                current['profile']='v2'
                return 200, {}
            return 200, dict(current)
        with patch.object(migration, 'request', request):
            with self.assertRaises(migration.MigrationError):
                migration.migrate_controller({'id':'pool'},entry,lambda:None,'v1','v2',1)
            self.assertEqual(migration.migrate_controller({'id':'pool'},entry,lambda:None,'v1','v2',1),7)
        self.assertEqual(writes,[{'desiredState':'released'}])

    def test_lost_release_response_then_busy_worker_can_retry_after_restart(self):
        entry = {'before': {'workspace_id':'workspace','admission_revision':7}}
        current = self.resource()
        writes = []
        def request(pool, path, body=None, **kwargs):
            if path.endswith('/state'):
                writes.append(kwargs['version'])
                if len(writes) == 1:
                    current.update(state='failed',desiredState='released',version='accepted',error={'code':'worker_busy','retryable':True})
                    raise migration.MigrationError('response lost')
                current.update(state='released',desiredState='released',version='retried',identity=None,error=None)
                return 202, dict(current)
            if path.endswith('/migration'):
                return 200, {'profile':current['profile'],'profileHash':'hash','revision':11,'epoch':4,'bindingGeneration':current['bindingGeneration'],'state':'released'}
            if path == '/v1/profile-migrations':
                if current['profile'] != 'v2':
                    current['bindingGeneration'] += 1
                current['profile']='v2'
                return 200, {}
            return 200, dict(current)
        with patch.object(migration, 'request', request):
            with self.assertRaises(migration.MigrationError):
                migration.migrate_controller({'id':'pool'},entry,lambda:None,'v1','v2',1)
            self.assertEqual(migration.migrate_controller({'id':'pool'},entry,lambda:None,'v1','v2',1),7)
        self.assertEqual(writes,['observed','accepted'])

    def test_queued_release_replays_after_submission_failure_and_ledger_reload(self):
        entry = {'before': {'workspace_id':'workspace','admission_revision':7}}
        current = self.resource()
        versions = []
        submission_available = False
        def request(pool, path, body=None, **kwargs):
            if path.endswith('/state'):
                versions.append(kwargs['version'])
                self.assertEqual(body, {'desiredState':'released'})
                if not submission_available:
                    current.update(desiredState='released',version='queued-version',progress={'step':'queued'},execution=None)
                    return 503, None
                current.update(state='released',desiredState='released',version='queued-version',identity=None,progress=None)
                return 202, dict(current)
            if path.endswith('/migration'):
                return 200, {'profile':current['profile'],'profileHash':'hash','revision':11,'epoch':4,'bindingGeneration':current['bindingGeneration'],'state':'released'}
            if path == '/v1/profile-migrations':
                if current['profile'] != 'v2':
                    current['bindingGeneration'] += 1
                current['profile']='v2'
                return 200, {}
            return 200, dict(current)
        saved = None
        def persist():
            nonlocal saved
            saved = json.dumps(entry)
        with patch.object(migration, 'request', request), patch.object(migration.time, 'sleep', side_effect=AssertionError('Queued submission must be replayed before waiting')):
            with self.assertRaisesRegex(migration.MigrationError, '503'):
                migration.migrate_controller({'id':'pool'},entry,persist,'v1','v2',1)
            entry = json.loads(saved)
            submission_available = True
            self.assertEqual(migration.migrate_controller({'id':'pool'},entry,persist,'v1','v2',1),7)
        self.assertEqual(versions,['observed','queued-version'])

    def test_failed_release_with_null_error_fails_with_migration_error(self):
        entry = {'before': {'workspace_id':'workspace','admission_revision':7}}
        current = self.resource()
        current.update(state='failed',desiredState='released',error=None)
        with patch.object(migration, 'request', return_value=(200,current)) as request:
            with self.assertRaisesRegex(migration.MigrationError, 'not retryable'):
                migration.migrate_controller({'id':'pool'},entry,lambda:None,'v1','v2',1)
        self.assertEqual(request.call_args_list[0].args[1], '/v1/workspaces/workspace')
        self.assertTrue(all(call.kwargs.get('method') != 'PUT' for call in request.call_args_list))

    def test_failed_release_is_reported_without_polling_internal_tasks(self):
        entry = {'before': {'workspace_id':'workspace','admission_revision':7}}
        current = self.resource()
        paths = []
        def request(pool, path, body=None, **kwargs):
            paths.append(path)
            if path.endswith('/state'):
                current.update(state='failed',desiredState='released',version='accepted',error={'code':'worker_busy','retryable':True})
                return 202, dict(current)
            return 200, dict(current)
        with patch.object(migration, 'request', request):
            with self.assertRaisesRegex(migration.MigrationError, 'release failed'):
                migration.migrate_controller({'id':'pool'},entry,lambda:None,'v1','v2',1)
        self.assertTrue(all(path.startswith('/v1/workspaces/') for path in paths))

    def test_fresh_install_skips_without_creating_database_or_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'pools').write_text(json.dumps({'defaultPoolId':'p','pools':[{'id':'p','profile':'v2','url':'http://x','tokenFile':'unused'}]}))
            with patch.object(migration,'request') as controller:
                migration.apply(root/'db',root/'pools',root/'ledger','v1','v2')
                controller.assert_not_called()
            self.assertFalse((root/'db').exists())
            self.assertFalse((root/'ledger').exists())
            (root/'ledger').with_suffix('.sqlite-backup').touch()
            with self.assertRaises(migration.MigrationError):
                migration.apply(root/'db',root/'pools',root/'ledger','v1','v2')

    def test_no_controller_allocation_preserves_higher_database_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            db=sqlite3.connect(root/'db')
            db.execute('CREATE TABLE agent_runtime_workspaces(workspace_id TEXT,pool_id TEXT,profile_id TEXT,admission_revision INTEGER,lifecycle_request_json TEXT)')
            db.execute('INSERT INTO agent_runtime_workspaces VALUES (?,?,?,?,?)',('new',None,None,23,'old'))
            db.commit()
            (root/'pools').write_text(json.dumps({'defaultPoolId':'p','pools':[{'id':'p','profile':'v2','url':'http://x','tokenFile':'unused'}]}))
            with patch.object(migration,'request',return_value=(404,None)) as controller:
                with patch.object(migration,'save',side_effect=migration.MigrationError('crash before first ledger')):
                    with self.assertRaises(migration.MigrationError):
                        migration.apply(root/'db',root/'pools',root/'ledger','v1','v2')
                self.assertFalse((root/'ledger').exists())
                self.assertTrue((root/'ledger').with_suffix('.sqlite-backup').exists())
                controller.assert_not_called()
                # Also model a partial temporary backup left by an earlier crash.
                (root/'ledger').with_suffix('.sqlite-backup.pending').write_bytes(b'partial')
                migration.apply(root/'db',root/'pools',root/'ledger','v1','v2')
                self.assertFalse((root/'ledger').with_suffix('.sqlite-backup.pending').exists())
            self.assertEqual(db.execute('SELECT pool_id,profile_id,admission_revision,lifecycle_request_json FROM agent_runtime_workspaces').fetchone(),('p','v2',23,None))
            db.close()


class BindingGenerationTests(unittest.TestCase):
    def setUp(self):
        self.current = {'id':'workspace','pool':'pool','profile':'v1','state':'released',
                        'desiredState':'released','identity':None,'execution':None,'version':'resource'}
        self.generation = 1
        self.last_migration = None
        self.posts = []
        self.lose_response = False
        self.reject_submission = False
        self.entry = {'before': {'workspace_id':'workspace','admission_revision':7}}
        self.saved = None
        api = patch.object(migration, 'request', self.request)
        api.start()
        self.addCleanup(api.stop)

    def persist(self):
        self.saved = json.dumps(self.entry)

    def run_migration(self):
        return migration.migrate_controller({'id':'pool'},self.entry,self.persist,'v1','v2',1)

    def request(self, pool, path, body=None, **kwargs):
        if path.endswith('/migration'):
            return 200, {'profile':self.current['profile'],'profileHash':self.current['profile'],
                         'revision':11,'epoch':4,'state':'released','bindingGeneration':self.generation}
        if path == '/v1/profile-migrations':
            self.posts.append(dict(body))
            if self.reject_submission:
                return 503, None
            if (self.last_migration == body and self.generation == body['expectedBindingGeneration'] + 1
                    and self.current['profile'] == body['toProfile']):
                return 200, {}
            if self.generation != body['expectedBindingGeneration'] or self.current['profile'] != body['fromProfile']:
                return 409, None
            self.current['profile'] = body['toProfile']
            self.generation += 1
            self.last_migration = dict(body)
            if self.lose_response:
                self.lose_response = False
                raise migration.MigrationError('response lost after profile commit')
            return 200, {}
        return 200, dict(self.current)

    def test_identity_persisted_before_submission_and_reused_after_rejection(self):
        self.reject_submission = True
        with self.assertRaisesRegex(migration.MigrationError, '503'):
            self.run_migration()
        self.assertEqual(json.loads(self.saved)['migration'],self.posts[0])
        self.assertEqual(str(migration.uuid.UUID(self.posts[0]['operationId'])),self.posts[0]['operationId'])
        self.entry = json.loads(self.saved)
        self.reject_submission = False
        self.assertEqual(self.run_migration(),7)
        self.assertEqual(self.posts[0],self.posts[1])
        self.assertEqual(self.generation,2)

    def test_lost_response_replays_same_operation_from_legacy_generation_zero(self):
        self.generation = 0
        self.lose_response = True
        with self.assertRaises(migration.MigrationError):
            self.run_migration()
        self.entry = json.loads(self.saved)
        self.assertEqual(self.run_migration(),7)
        self.assertEqual(self.posts[0],self.posts[1])
        self.assertEqual(self.posts[0]['expectedBindingGeneration'],0)
        self.assertEqual(self.generation,1)

    def test_return_to_source_rejects_delayed_retry_without_overriding_rollback(self):
        self.lose_response = True
        with self.assertRaises(migration.MigrationError):
            self.run_migration()
        original = dict(self.entry['migration'])
        rollback = {**original,'operationId':'rollback','fromProfile':'v2','toProfile':'v1','expectedBindingGeneration':2}
        self.assertEqual(self.request({'id':'pool'},'/v1/profile-migrations',rollback)[0],200)
        with self.assertRaisesRegex(migration.MigrationError, 'changed after migration was prepared'):
            self.run_migration()
        self.assertEqual(self.current['profile'],'v1')
        self.assertEqual(self.generation,3)
        self.assertEqual(self.entry['migration'],original)
        self.assertEqual(self.posts,[original,rollback])

    def test_return_to_target_does_not_adopt_a_newer_binding(self):
        self.lose_response = True
        with self.assertRaises(migration.MigrationError):
            self.run_migration()
        original = dict(self.entry['migration'])
        rollback = {**original,'operationId':'rollback','fromProfile':'v2','toProfile':'v1','expectedBindingGeneration':2}
        replacement = {**original,'operationId':'replacement','expectedBindingGeneration':3}
        self.request({'id':'pool'},'/v1/profile-migrations',rollback)
        self.request({'id':'pool'},'/v1/profile-migrations',replacement)
        with self.assertRaisesRegex(migration.MigrationError, 'target controller state changed'):
            self.run_migration()
        self.assertEqual(self.generation,4)
        self.assertEqual(self.posts,[original,rollback,replacement])

    def test_target_generation_alone_does_not_prove_operation_identity(self):
        self.reject_submission = True
        with self.assertRaises(migration.MigrationError):
            self.run_migration()
        self.reject_submission = False
        different = {**self.entry['migration'],'operationId':'different-maintainer'}
        self.request({'id':'pool'},'/v1/profile-migrations',different)
        with self.assertRaisesRegex(migration.MigrationError, 'no longer owns the target binding'):
            self.run_migration()
        self.assertEqual(self.last_migration,different)
        self.assertEqual(self.generation,2)

    def test_unfinished_legacy_prepared_migration_is_not_upgraded_by_guessing(self):
        self.entry['migration'] = {'workspaceId':'workspace','fromProfile':'v1','toProfile':'v2',
                                   'expectedProfileHash':'v1','expectedRevision':11,'expectedEpoch':4}
        with self.assertRaisesRegex(migration.MigrationError, 'prepared legacy migration'):
            self.run_migration()
        self.assertEqual(self.posts,[])
        self.assertEqual(self.generation,1)


class MigrationChainTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.database, self.pools = self.root/'db', self.root/'pools'
        self.legacy, self.latest = self.root/'v2.json', self.root/'v3.json'
        self.pools.write_text(json.dumps({'defaultPoolId':'p','pools':[
            {'id':'p','profile':'v3','url':'http://controller','tokenFile':'unused'}]}))
        self.controllers = {}
        self.migrations = []
        self.api = patch.object(migration, 'request', self.request)
        self.api.start()
        self.addCleanup(self.api.stop)

    def seed(self, profiles):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('CREATE TABLE agent_runtime_workspaces(workspace_id TEXT PRIMARY KEY,pool_id TEXT,profile_id TEXT,admission_revision INTEGER,lifecycle_request_json TEXT)')
            for index, profile in enumerate(profiles):
                workspace = str(index)
                db.execute('INSERT INTO agent_runtime_workspaces VALUES (?,?,?,?,?)', (workspace,'p',profile,7,None))
                self.controllers[workspace] = {'phase':'released','epoch':2,'profileHash':profile,'bindingGeneration':1,
                    'request':{'workspaceId':workspace,'profile':profile,'revision':7,'operationId':'old'},
                    'completedOperation':'old'}

    def request(self, pool, path, body=None, **kwargs):
        if path.startswith('/v1/workspaces/'):
            workspace = path.split('/')[3]
            current = self.controllers[workspace]
            if path.endswith('/migration'):
                return 200, {'profile':current['request']['profile'],'profileHash':current['profileHash'],
                             'revision':current['request']['revision'],'epoch':current['epoch'],'state':current['phase'],'bindingGeneration':current['bindingGeneration']}
            return 200, {'id':workspace,'pool':'p','profile':current['request']['profile'],'version':'version',
                         'state':current['phase'],'desiredState':'released','identity':None,'execution':None}
        if path == '/v1/profile-migrations':
            current = self.controllers[body['workspaceId']]
            self.assertEqual(current['request']['profile'],body['fromProfile'])
            self.migrations.append((body['workspaceId'],body['fromProfile'],body['toProfile']))
            self.assertEqual(current['bindingGeneration'], body['expectedBindingGeneration'])
            self.assertTrue(body['operationId'])
            current['bindingGeneration'] += 1
            current['request']['profile'] = body['toProfile']
            current['profileHash'] = body['toProfile']
            return 200,json.loads(json.dumps(current))
        self.fail('unexpected controller request '+path)

    def run_legacy(self):
        migration.apply(self.database,self.pools,self.legacy,'v1','v2',successors=['v3'])

    def run_latest(self):
        migration.apply(self.database,self.pools,self.latest,'v2','v3')

    def test_fresh_install_then_v3_restart_without_legacy_ledger(self):
        self.run_legacy()
        self.run_latest()
        self.assertFalse(self.database.exists())
        self.assertFalse(self.legacy.exists())
        self.seed(['v3'])
        self.run_legacy()
        self.run_latest()
        self.assertEqual(self.migrations, [])
        self.run_legacy()
        self.run_latest()

    def test_current_v2_migrates_only_latest_step(self):
        self.seed(['v2'])
        self.run_legacy()
        self.run_latest()
        self.assertEqual(self.migrations,[('0','v2','v3')])

    def test_consistent_pre_v2_restore_and_mixed_chain(self):
        self.seed(['v1','v2','v3'])
        self.run_legacy()
        self.run_latest()
        self.run_legacy()
        self.run_latest()
        self.assertEqual(self.migrations,[('0','v1','v2'),('0','v2','v3'),('1','v2','v3')])
        with closing(sqlite3.connect(self.database)) as db, db:
            self.assertEqual(db.execute('SELECT DISTINCT profile_id FROM agent_runtime_workspaces').fetchall(),[('v3',)])
        with closing(sqlite3.connect(self.legacy.with_suffix('.sqlite-backup'))) as db:
            self.assertEqual(db.execute('SELECT profile_id FROM agent_runtime_workspaces WHERE workspace_id="0"').fetchone(),('v1',))

    def test_completed_legacy_rejects_stale_restore_and_unknown_profile(self):
        self.seed(['v1'])
        self.run_legacy()
        original = self.legacy.read_bytes()
        for profile in ('v1','unknown'):
            with self.subTest(profile=profile), closing(sqlite3.connect(self.database)) as db, db:
                db.execute('UPDATE agent_runtime_workspaces SET profile_id=?',(profile,))
                db.commit()
                with self.assertRaises(migration.MigrationError):
                    self.run_legacy()
                self.assertEqual(self.legacy.read_bytes(),original)
        self.assertEqual(len(self.migrations),1)

    def test_unknown_profile_rejected_before_any_controller_mutation(self):
        self.seed(['v1','unknown'])
        with self.assertRaises(migration.MigrationError):
            self.run_legacy()
        self.assertEqual(self.migrations,[])

    def test_inconsistent_controller_restore_fails_closed(self):
        self.seed(['v1'])
        self.controllers['0']['request']['profile'] = 'v3'
        with self.assertRaises(migration.MigrationError):
            self.run_legacy()
        self.assertEqual(self.migrations,[])

    def test_interrupted_legacy_record_accepts_known_successor_without_downgrade(self):
        self.seed(['v1'])
        save = migration.save
        def stop_after_db_commit(path,value):
            if path == self.legacy and any(e.get('done') for e in value.get('workspaces',{}).values()):
                raise migration.MigrationError('interrupted after db commit')
            save(path,value)
        with patch.object(migration,'save',stop_after_db_commit):
            with self.assertRaises(migration.MigrationError):
                self.run_legacy()
        self.run_latest()
        self.run_legacy()
        self.assertTrue(json.loads(self.legacy.read_text())['complete'])
        self.assertEqual(self.migrations,[('0','v1','v2'),('0','v2','v3')])

    def test_successor_must_not_discard_unfinished_or_conflicting_legacy_record(self):
        self.seed(['v1'])
        with patch.object(migration,'migrate_controller',side_effect=migration.MigrationError('before migration')):
            with self.assertRaises(migration.MigrationError):
                self.run_legacy()
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE agent_runtime_workspaces SET profile_id='v3'")
        with self.assertRaisesRegex(migration.MigrationError,'conflicts with legacy'):
            self.run_legacy()


if __name__ == '__main__':
    unittest.main()
