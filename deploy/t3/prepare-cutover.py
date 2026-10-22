#!/usr/bin/env python3
"""Render native workspace PVCs from ready snapshots without changing the source database."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()[:32]


def quantity(value):
    match = re.fullmatch(r'([1-9][0-9]*)(Ki|Mi|Gi|Ti|Pi)?', value)
    if not match:
        raise ValueError('Storage quantities must be positive binary quantities.')
    return int(match[1]) * 1024 ** [None, 'Ki', 'Mi', 'Gi', 'Ti', 'Pi'].index(match[2])


def render(database, configuration, snapshots):
    pools = {pool['id']: pool for pool in configuration['pools']}
    if len(pools) != len(configuration['pools']):
        raise ValueError('Pool identifiers must be unique.')
    snapshot_by_claim = {}
    for snapshot in snapshots['items']:
        key = (snapshot['metadata']['namespace'], snapshot.get('spec', {}).get('source', {}).get('persistentVolumeClaimName'))
        if key[1] is None:
            continue
        if key in snapshot_by_claim:
            raise ValueError('Provide exactly one snapshot per source workspace claim.')
        snapshot_by_claim[key] = snapshot
    uri = Path(database).resolve().as_uri() + '?mode=ro'
    with sqlite3.connect(uri, uri=True) as connection:
        connection.execute('PRAGMA query_only = ON')
        rows = connection.execute('SELECT workspace_id, pool_id, profile_id FROM agent_runtime_workspaces ORDER BY workspace_id').fetchall()
    items = []
    for workspace, pool_id, profile in rows:
        pool = pools.get(pool_id or configuration['defaultPoolId'])
        if pool is None:
            raise ValueError('Every existing workspace pool must be present in the native configuration.')
        if profile is not None and profile != pool['profile']:
            raise ValueError('Preserve existing profile identifiers during cutover.')
        legacy_name = 'ar-ws-' + digest(json.dumps(workspace, ensure_ascii=False, separators=(',', ':')))
        snapshot = snapshot_by_claim.get((pool['namespace'], legacy_name))
        if snapshot is None:
            raise ValueError(f'Missing snapshot for retained workspace {workspace}. No manifests produced.')
        status = snapshot.get('status', {})
        if snapshot['metadata'].get('deletionTimestamp') or not status.get('readyToUse') or not status.get('boundVolumeSnapshotContentName'):
            raise ValueError('All snapshots must be ready, bound, and not deleting.')
        if quantity(status['restoreSize']) > quantity(pool['storage']['size']):
            raise ValueError('The native workspace size is smaller than the snapshot restore size.')
        key = digest(workspace)
        spec = {
            'accessModes': ['ReadWriteOnce'],
            'resources': {'requests': {'storage': pool['storage']['size']}},
            'dataSource': {'apiGroup': 'snapshot.storage.k8s.io', 'kind': 'VolumeSnapshot', 'name': snapshot['metadata']['name']},
        }
        if 'storageClassName' in pool['storage']:
            spec['storageClassName'] = pool['storage']['storageClassName']
        items.append({'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim', 'metadata': {
            'name': 't3-ws-' + key, 'namespace': pool['namespace'],
            'labels': {'app.kubernetes.io/managed-by': 't3-code', 't3.codes/workspace': key},
            'annotations': {'t3.codes/workspace': workspace},
        }, 'spec': spec})
    return {'apiVersion': 'v1', 'kind': 'List', 'items': items}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--pools', required=True)
    parser.add_argument('--snapshots', required=True, help='JSON List of ready VolumeSnapshots, one per legacy workspace PVC')
    args = parser.parse_args()
    try:
        result = render(args.database, json.loads(Path(args.pools).read_text()), json.loads(Path(args.snapshots).read_text()))
    except (ValueError, KeyError, sqlite3.Error, OSError) as error:
        print(f'Cannot prepare native cutover: {error}', file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result, indent=2))
