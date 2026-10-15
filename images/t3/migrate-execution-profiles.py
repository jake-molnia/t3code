#!/usr/bin/env python3
"""Run as a web init container while its single Recreate replica is stopped."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request


class MigrationError(Exception):
    pass


def save(path, value):
    temporary = path.with_suffix('.pending')
    with open(temporary, 'w', opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def request(pool, path, body=None, *, method=None, version=None):
    token = Path(pool['tokenFile']).read_text().strip()
    data = None if body is None else json.dumps(body).encode()
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    if version is not None:
        headers['If-Match'] = json.dumps(version)
    outgoing = urllib.request.Request(pool['url'].rstrip('/') + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(outgoing, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        # Never emit endpoint bodies, URLs, credentials or callback state.
        return error.code, None
    except (urllib.error.URLError, TimeoutError) as error:
        raise MigrationError('controller transport unavailable') from error


def state(pool, workspace):
    return request(pool, '/v1/workspaces/' + urllib.parse.quote(workspace, safe=''))


def released(resource):
    return (resource['state'] == 'released' and resource['desiredState'] == 'released'
            and resource.get('identity') is None and resource.get('execution') is None)


def migrate_controller(pool, entry, persist, source, target, timeout):
    workspace = entry['before']['workspace_id']
    path = '/v1/workspaces/' + urllib.parse.quote(workspace, safe='')
    code, current = state(pool, workspace)
    if code == 404 and not entry.get('release') and not entry.get('migration'):
        return entry['before']['admission_revision']
    if code != 200 or current['id'] != workspace or current['pool'] != pool['id']:
        raise MigrationError('workspace controller state cannot be reconciled')
    if current['profile'] == target:
        saved = entry.get('migration')
        info_code, info = request(pool, path + '/migration')
        if (not saved or not released(current) or info_code != 200
                or info['profile'] != target or info['state'] != 'released'
                or info['revision'] != saved['expectedRevision'] or info['epoch'] != saved['expectedEpoch']):
            raise MigrationError('target controller state changed')
        return entry['before']['admission_revision']
    if current['profile'] != source:
        raise MigrationError('controller profile does not match migration source')
    if entry.get('release') and 'version' not in entry['release']:
        raise MigrationError('legacy operation ledger must be completed before switching lifecycle APIs')
    if not released(current):
        receipt = entry.get('release')
        if receipt is None:
            if not current.get('identity'):
                raise MigrationError('workspace has no stable allocation to release')
            receipt = {'version': current['version'], 'identity': current['identity']}
            entry['release'] = receipt
            persist()
        if current.get('identity') != receipt['identity']:
            raise MigrationError('workspace allocation changed')
        if (not receipt.get('acceptedVersion') and current['desiredState'] == 'released'
                and current['version'] != receipt['version']):
            receipt['acceptedVersion'] = current['version']
            persist()
        if current['version'] not in (receipt['version'], receipt.get('acceptedVersion')):
            raise MigrationError('workspace release superseded')
        if current['state'] == 'failed':
            if not (current.get('error') or {}).get('retryable'):
                raise MigrationError('workspace release failed and is not retryable')
            receipt['version'] = current['version']
            receipt.pop('acceptedVersion', None)
            persist()
        if (current['desiredState'] != 'released' or current['state'] == 'failed'
                or (current.get('progress') or {}).get('step') == 'queued'):
            code, accepted = request(pool, path + '/state', {'desiredState': 'released'}, method='PUT', version=current['version'])
            if code not in (200, 202):
                raise MigrationError('release admission rejected (HTTP %s)' % code)
            receipt['acceptedVersion'] = accepted['version']
            persist()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            code, current = state(pool, workspace)
            if code != 200:
                raise MigrationError('workspace release observation unavailable; retry the same ledger')
            if current['profile'] != source or current['desiredState'] != 'released':
                raise MigrationError('workspace release superseded')
            if receipt.get('acceptedVersion') and current['version'] != receipt['acceptedVersion']:
                raise MigrationError('workspace release superseded')
            if released(current):
                break
            if current['state'] == 'failed':
                raise MigrationError('workspace release failed; retry the same ledger')
            time.sleep(1)
        else:
            raise MigrationError('workspace release timed out; retry the same ledger')
    receipt = entry.get('release')
    if receipt and receipt.get('acceptedVersion') and current['version'] != receipt['acceptedVersion']:
        raise MigrationError('workspace release superseded')
    info_code, info = request(pool, path + '/migration')
    if info_code != 200 or info['profile'] != source or info['state'] != 'released':
        raise MigrationError('released workspace migration metadata unavailable')
    migration = {
        'workspaceId': workspace, 'fromProfile': source, 'toProfile': target,
        'expectedProfileHash': info['profileHash'],
        'expectedRevision': info['revision'], 'expectedEpoch': info['epoch'],
    }
    if entry.get('migration') and entry['migration'] != migration:
        raise MigrationError('controller changed after migration was prepared')
    entry['migration'] = migration
    persist()
    code, _ = request(pool, '/v1/profile-migrations', migration)
    if code != 200:
        raise MigrationError('profile migration rejected (HTTP %s)' % code)
    code, migrated = state(pool, workspace)
    if code != 200 or not released(migrated) or migrated['profile'] != target:
        raise MigrationError('profile migration outcome is not established')
    # T3's admission revision is a local activity fence, independent of the controller.
    return entry['before']['admission_revision']


def apply(db_path, pools_path, ledger_path, source, target, timeout=300, successors=()):
    if source == target:
        raise MigrationError('source and target profiles must differ')
    successors = set(successors)
    if source in successors or target in successors:
        raise MigrationError('successor profiles must differ from source and target')
    pools_config = json.loads(pools_path.read_text())
    pools = {pool['id']: pool for pool in pools_config['pools']}
    if any(pool['profile'] not in {target, *successors} for pool in pools.values()):
        raise MigrationError('all pool defaults must name the target or a known successor profile')
    scope = {'database': str(db_path.resolve()), 'source': source, 'target': target,
             'pools': {key: value['url'] for key, value in pools.items()}}
    ledger_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with ledger_path.with_suffix('.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not db_path.exists():
            if ledger_path.exists() or ledger_path.with_suffix('.sqlite-backup').exists():
                raise MigrationError('retained migration state exists but its database is missing')
            print(json.dumps({'status': 'fresh-install', 'profile': target}), flush=True)
            return
        db = sqlite3.connect('file:' + urllib.parse.quote(str(db_path.resolve()), safe='/') + '?mode=rw', uri=True, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            if ledger_path.exists():
                ledger = json.loads(ledger_path.read_text())
                if ledger['scope'] != scope:
                    raise MigrationError('ledger belongs to a different migration')
            else:
                backup = ledger_path.with_suffix('.sqlite-backup')
                # No mutations begin before the ledger exists. An interrupted
                # initial backup can therefore be regenerated on the next init.
                temporary_backup = backup.with_suffix('.sqlite-backup.pending')
                temporary_backup.unlink(missing_ok=True)
                fd = os.open(temporary_backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                destination = sqlite3.connect(temporary_backup)
                try:
                    db.backup(destination)
                finally:
                    destination.close()
                with temporary_backup.open('rb') as stream:
                    os.fsync(stream.fileno())
                os.replace(temporary_backup, backup)
                directory = os.open(backup.parent, os.O_RDONLY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
                ledger = {'scope': scope, 'backup': str(backup), 'workspaces': {}}
                save(ledger_path, ledger)
            rows = db.execute('SELECT workspace_id,pool_id,profile_id,admission_revision,lifecycle_request_json FROM agent_runtime_workspaces').fetchall()
            if any(row['profile_id'] not in {None, source, target, *successors} for row in rows):
                raise MigrationError('workspace has an unexpected execution profile')
            if ledger.get('complete'):
                if db.execute('SELECT 1 FROM agent_runtime_workspaces WHERE profile_id=? LIMIT 1', (source,)).fetchone():
                    raise MigrationError('completed migration has source-profile bindings')
                return
            persist = lambda: save(ledger_path, ledger)
            for row in rows:
                workspace = row['workspace_id']
                if row['profile_id'] in successors:
                    entry = ledger['workspaces'].get(workspace)
                    if entry:
                        after = entry.get('after')
                        if (not after or after['profile_id'] != target
                                or row['pool_id'] != after['pool_id']
                                or row['admission_revision'] < after['admission_revision']):
                            raise MigrationError('successor workspace conflicts with legacy migration')
                        entry['done'] = True
                        persist()
                    continue
                if row['profile_id'] == target and workspace not in ledger['workspaces']:
                    continue
                entry = ledger['workspaces'].setdefault(workspace, {'before': dict(row)})
                persist()
                before = entry['before']
                pool_id = before['pool_id'] or pools_config['defaultPoolId']
                if pool_id not in pools:
                    raise MigrationError('workspace pool is not configured')
                db.execute('BEGIN EXCLUSIVE')
                try:
                    actual = dict(db.execute('SELECT workspace_id,pool_id,profile_id,admission_revision,lifecycle_request_json FROM agent_runtime_workspaces WHERE workspace_id=?', (workspace,)).fetchone())
                    if entry.get('done'):
                        if actual != entry['after']:
                            raise MigrationError('completed workspace changed during maintenance')
                        db.rollback()
                        continue
                    if actual != before:
                        # Commit may have succeeded just before the process stopped.
                        if actual != entry.get('after'):
                            raise MigrationError('workspace database compare-and-swap failed')
                        revision = migrate_controller(pools[pool_id], entry, persist, source, target, timeout)
                        if actual['admission_revision'] < revision:
                            raise MigrationError('database is behind migrated controller')
                        db.rollback()
                    else:
                        revision = migrate_controller(pools[pool_id], entry, persist, source, target, timeout)
                        after = {**before, 'pool_id': pool_id, 'profile_id': target,
                            'admission_revision': max(before['admission_revision'], revision), 'lifecycle_request_json': None}
                        entry['after'] = after
                        persist()
                        changed = db.execute('UPDATE agent_runtime_workspaces SET pool_id=?,profile_id=?,admission_revision=?,lifecycle_request_json=NULL WHERE workspace_id=? AND pool_id IS ? AND profile_id IS ? AND admission_revision=? AND lifecycle_request_json IS ?',
                            (pool_id,target,after['admission_revision'],workspace,before['pool_id'],before['profile_id'],before['admission_revision'],before['lifecycle_request_json']))
                        if changed.rowcount != 1:
                            raise MigrationError('workspace database compare-and-swap failed')
                        db.commit()
                    entry['done'] = True
                    persist()
                    print(json.dumps({'workspaceId': workspace, 'profile': target, 'status': 'migrated'}), flush=True)
                except BaseException:
                    db.rollback()
                    raise
            ledger['complete'] = True
            persist()
        finally:
            db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--pools', type=Path, required=True)
    parser.add_argument('--ledger', type=Path, required=True)
    parser.add_argument('--from-profile', required=True)
    parser.add_argument('--to-profile', required=True)
    parser.add_argument('--successor-profile', action='append', default=[])
    parser.add_argument('--apply', action='store_true', required=True)
    args = parser.parse_args()
    try:
        apply(args.database,args.pools,args.ledger,args.from_profile,args.to_profile,successors=args.successor_profile)
    except Exception as error:
        detail = str(error) if isinstance(error, MigrationError) else type(error).__name__
        parser.exit(1, 'Profile migration stopped: ' + detail + '\n')


if __name__ == '__main__':
    main()
