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
    def test_release_migrate_and_resume_after_controller_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database, pools, ledger = root/'state.sqlite', root/'pools.json', root/'ledger.json'
            db = sqlite3.connect(database)
            db.execute('CREATE TABLE agent_runtime_workspaces(workspace_id TEXT PRIMARY KEY,pool_id TEXT,profile_id TEXT,admission_revision INTEGER,lifecycle_request_json TEXT)')
            db.execute('INSERT INTO agent_runtime_workspaces VALUES (?,?,?,?,?)', ('workspace','pool','v1',7,'{"profile":"v1"}'))
            db.commit()
            pools.write_text(json.dumps({'defaultPoolId':'pool','pools':[{'id':'pool','profile':'v2','url':'http://controller','tokenFile':'unused'}]}))
            current = {'phase':'suspended','request':{'workspaceId':'workspace','revision':10,'operationId':'old','profile':'v1'},'completedOperation':'old','epoch':4,'identity':{'incarnation':'worker'},'handle':{'allocationId':'4'},'profileHash':'original'}
            calls = []
            fail_once = [True]
            def request(pool, path, body=None):
                if path.startswith('/v1/workspaces/'):
                    if ('profile='+current['request']['profile']) not in path:
                        return 503, None
                    return 200, {'state':json.loads(json.dumps(current))}
                calls.append(path)
                if path == '/v1/operations':
                    self.assertEqual(body['revision'], 11)
                    current.update(phase='released',request=body,completedOperation=body['operationId'],identity=None,handle=None)
                    return 202, {'taskId':'task'}
                if path == '/v1/profile-migrations':
                    self.assertEqual(body['expectedRevision'], 11)
                    current['request']['profile']='v2'
                    current['profileHash']='new'
                    if fail_once[0]:
                        fail_once[0]=False
                        raise migration.MigrationError('simulated response loss after commit')
                    return 200, current
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
                self.assertEqual(db.execute('SELECT profile_id,admission_revision,lifecycle_request_json FROM agent_runtime_workspaces').fetchone(), ('v2',11,None))
                migration.apply(database,pools,ledger,'v1','v2')
                self.assertEqual(calls.count('/v1/operations'),1)
                backup=sqlite3.connect(ledger.with_suffix('.sqlite-backup'))
                self.assertEqual(backup.execute('SELECT profile_id FROM agent_runtime_workspaces').fetchone()[0],'v1')
                backup.close()
                # A normal later web run may advance revisions. Its next init is a no-op.
                db.execute('UPDATE agent_runtime_workspaces SET admission_revision=20')
                db.commit()
                migration.apply(database,pools,ledger,'v1','v2')
            db.close()

    def test_failed_owned_release_retries_with_a_new_operation(self):
        for terminal, partial in (('FAILED', False), ('CANCELLED', False), ('FAILED', True)):
            with self.subTest(terminal=terminal, partial=partial):
                current = {'phase':'suspended','request':{'workspaceId':'w','revision':10,'operationId':'old','profile':'v1'},
                    'completedOperation':'old','epoch':4,'identity':{'incarnation':'worker'},
                    'handle':{'allocationId':'4','pvcUid':'retained'},'profileHash':'original'}
                entry = {'before':{'workspace_id':'w','admission_revision':7}}
                submissions=[]
                def request(pool,path,body=None):
                    if path.startswith('/v1/workspaces/'):
                        return 200, {'state':json.loads(json.dumps(current))}
                    if path == '/v1/operations':
                        submissions.append(json.loads(json.dumps(body)))
                        current.update(request=json.loads(json.dumps(body)),taskId='task-'+str(len(submissions)))
                        if partial:
                            current.update(phase='released',identity=None,handle=None)
                        if len(submissions)>1:
                            current.update(phase='released',completedOperation=body['operationId'],identity=None,handle=None)
                        return 202, {'taskId':current['taskId']}
                    if path.startswith('/v1/operations/'):
                        return 200, {'status':terminal}
                    if path == '/v1/profile-migrations':
                        current['request']['profile']='v2'
                        return 200,current
                    self.fail(path)
                with patch.object(migration,'request',request):
                    with self.assertRaises(migration.MigrationError):
                        migration.migrate_controller({},entry,lambda:None,'v1','v2',1)
                    persisted = []
                    def crash_after_persisting_replacement():
                        persisted.append(json.loads(json.dumps(entry)))
                        raise migration.MigrationError('crash before replacement POST')
                    with self.assertRaises(migration.MigrationError):
                        migration.migrate_controller({},entry,crash_after_persisting_replacement,'v1','v2',1)
                    self.assertEqual(len(submissions),1)
                    entry = persisted[-1]
                    planned = json.loads(json.dumps(entry['release']))
                    revision=migration.migrate_controller({},entry,lambda:None,'v1','v2',1)
                self.assertEqual(submissions[1],planned)
                self.assertEqual(revision,12)
                self.assertEqual([r['revision'] for r in submissions],[11,12])
                self.assertNotEqual(submissions[0]['operationId'],submissions[1]['operationId'])
                self.assertEqual(entry['releaseAttempts'][0]['status'],terminal)
                self.assertEqual(entry['releaseAttempts'][0]['request'],submissions[0])

    def test_terminal_preexisting_lifecycle_recovers_without_forcing_quiescence(self):
        for status in ('FAILED', 'CANCELLED'):
            with self.subTest(status=status):
                current={'request':{'workspaceId':'w','revision':40,'operationId':'existing-idle-release','profile':'v1','action':'release_compute'},
                    'taskId':'previous','epoch':4,'profileHash':'original','phase':'running',
                    'completedOperation':'older-ensure', 'identity':{'incarnation':'one'},
                    'handle':{'allocationId':'4','pvcUid':'retained'}}
                entry={'before':{'workspace_id':'w','admission_revision':35}}
                posts=[]
                def request(pool,path,body=None):
                    if path.startswith('/v1/workspaces/'):
                        return 200,{'state':json.loads(json.dumps(current))}
                    if path == '/v1/operations/previous':
                        return 200,{'status':status}
                    if path == '/v1/operations':
                        posts.append(json.loads(json.dumps(body)))
                        self.assertEqual(body['action'],'release_compute')
                        self.assertEqual(body['expectedAllocationId'],'4')
                        self.assertEqual(body['expectedIncarnation'],'one')
                        self.assertEqual(body['expectedGeneration'],4)
                        current.update(request=json.loads(json.dumps(body)),completedOperation=body['operationId'],
                            phase='released',identity=None,handle=None,taskId='migration')
                        return 202,{'taskId':'migration'}
                    if path == '/v1/profile-migrations':
                        current['request']['profile']='v2'
                        return 200,current
                    self.fail(path)
                persisted=[]
                def crash_before_post():
                    persisted.append(json.loads(json.dumps(entry)))
                    raise migration.MigrationError('crash after preparing recovery')
                with patch.object(migration,'request',request):
                    with self.assertRaises(migration.MigrationError):
                        migration.migrate_controller({},entry,crash_before_post,'v1','v2',1)
                    self.assertEqual(posts,[])
                    entry=persisted[-1]
                    planned=json.loads(json.dumps(entry['release']))
                    revision=migration.migrate_controller({},entry,lambda:None,'v1','v2',1)
                self.assertEqual(revision,41)
                self.assertEqual(posts,[planned])
                self.assertFalse(entry['releaseAttempts'][0]['owned'])

    def test_preexisting_operation_requires_terminal_status_and_stable_state(self):
        for scenario in ('RUNNING','QUEUED','SUCCEEDED','unknown','profile','identity','storage','revision'):
            with self.subTest(scenario=scenario):
                current={'request':{'workspaceId':'w','revision':40,'operationId':'existing','profile':'v1'},
                    'taskId':'previous','epoch':4,'profileHash':'original','phase':'running',
                    'completedOperation':'older','identity':{'incarnation':'one'},'handle':{'allocationId':'4','pvcUid':'same'}}
                confirmed=json.loads(json.dumps(current))
                if scenario=='profile': confirmed['profileHash']='changed'
                if scenario=='identity': confirmed['identity']['incarnation']='changed'
                if scenario=='storage': confirmed['handle']['pvcUid']='changed'
                if scenario=='revision': confirmed['request']['revision']=41
                reads=0
                def request(pool,path,body=None):
                    nonlocal reads
                    self.assertIsNone(body,'must not mutate unknown or changed preexisting operation')
                    if path.startswith('/v1/workspaces/'):
                        reads+=1
                        return 200,{'state':json.loads(json.dumps(current if reads==1 else confirmed))}
                    if path == '/v1/operations/previous':
                        if scenario=='unknown': return 503,None
                        return 200,{'status':scenario if scenario in ('RUNNING','QUEUED','SUCCEEDED') else 'FAILED'}
                    self.fail(path)
                entry={'before':{'workspace_id':'w','admission_revision':35}}
                with patch.object(migration,'request',request):
                    with self.assertRaises(migration.MigrationError):
                        migration.migrate_controller({},entry,lambda:None,'v1','v2',1)
                self.assertNotIn('release',entry)

    def test_saved_replacement_rechecks_predecessor_before_post(self):
        for change in ('superseded','identity','storage','profile','running','unknown'):
            with self.subTest(change=change):
                old={'workspaceId':'w','revision':11,'operationId':'failed','profile':'v1','expectedGeneration':4}
                current={'request':old,'taskId':'task','epoch':4,'profileHash':'original','phase':'suspended',
                    'identity':{'incarnation':'one'},'handle':{'allocationId':'4','pvcUid':'same'}}
                replacement={**old,'revision':12,'operationId':'saved-replacement'}
                entry={'before':{'workspace_id':'w','admission_revision':7},'release':replacement,
                    'releaseBasis':json.loads(json.dumps(current)),
                    'releaseAttempts':[{'request':json.loads(json.dumps(old)),'taskId':'task','status':'FAILED'}]}
                if change=='superseded': current['request']={**old,'operationId':'other'}
                if change=='identity': current['identity']={'incarnation':'new'}
                if change=='storage': current['handle']={'allocationId':'4','pvcUid':'replaced'}
                if change=='profile': current['profileHash']='changed'
                def request(pool,path,body=None):
                    self.assertIsNone(body, 'replacement submitted before validating predecessor')
                    if path.startswith('/v1/workspaces/'):
                        return 200, {'state':json.loads(json.dumps(current))}
                    if path.startswith('/v1/operations/'):
                        return (503,None) if change=='unknown' else (200,{'status':'RUNNING' if change=='running' else 'FAILED'})
                    self.fail(path)
                with patch.object(migration,'request',request):
                    with self.assertRaises(migration.MigrationError):
                        migration.migrate_controller({},entry,lambda:None,'v1','v2',1)
                self.assertEqual(entry['release'],replacement)
                self.assertEqual(len(entry['releaseAttempts']),1)

    def test_release_retry_never_duplicates_unknown_or_running_task(self):
        release={'workspaceId':'w','revision':11,'operationId':'owned','profile':'v1','expectedGeneration':4}
        current={'request':release,'taskId':'task','epoch':4,'profileHash':'original','phase':'suspended'}
        for code,status in ((200,'RUNNING'),(200,'QUEUED'),(503,None)):
            with self.subTest(code=code,status=status):
                entry={'release':release.copy()}
                with patch.object(migration,'request',return_value=(code,{'status':status})) as api:
                    if code == 503:
                        with self.assertRaises(migration.MigrationError):
                            migration.retry_failed_release({},entry,current,lambda:None,'v1')
                    else:
                        migration.retry_failed_release({},entry,current,lambda:None,'v1')
                    self.assertEqual(api.call_count,1)
                self.assertEqual(entry['release'],release)
                self.assertNotIn('releaseAttempts',entry)

    def test_release_retry_rejects_changed_allocation(self):
        release={'workspaceId':'w','revision':11,'operationId':'owned','profile':'v1','expectedGeneration':4}
        original={'request':release,'taskId':'task','epoch':4,'profileHash':'original','phase':'suspended',
            'identity':{'incarnation':'one'},'handle':{'allocationId':'4','pvcUid':'same'}}
        for change in ('profile','storage','identity','superseded'):
            with self.subTest(change=change):
                changed=json.loads(json.dumps(original))
                if change=='profile': changed['profileHash']='different'
                if change=='storage': changed['handle']['pvcUid']='replaced'
                if change=='identity': changed['identity']['incarnation']='another'
                if change=='superseded': changed['request']['operationId']='someone-else'
                entry={'before':{'admission_revision':11},'release':release,'releaseBasis':original}
                with patch.object(migration,'request',side_effect=[(200,{'status':'FAILED'}),(200,{'state':changed})]) as api:
                    with self.assertRaises(migration.MigrationError):
                        migration.retry_failed_release({},entry,original,lambda:None,'v1')
                    self.assertEqual(api.call_count,2)
                self.assertNotIn('releaseAttempts',entry)

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
                self.controllers[workspace] = {'phase':'released','epoch':2,'profileHash':profile,
                    'request':{'workspaceId':workspace,'profile':profile,'revision':7,'operationId':'old'},
                    'completedOperation':'old'}

    def request(self, pool, path, body=None):
        if path.startswith('/v1/workspaces/'):
            workspace = path.split('/')[3].split('?')[0]
            current = self.controllers[workspace]
            return (200, {'state':json.loads(json.dumps(current))}) if path.endswith('profile='+current['request']['profile']) else (409,None)
        if path == '/v1/profile-migrations':
            current = self.controllers[body['workspaceId']]
            self.assertEqual(current['request']['profile'],body['fromProfile'])
            self.migrations.append((body['workspaceId'],body['fromProfile'],body['toProfile']))
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
