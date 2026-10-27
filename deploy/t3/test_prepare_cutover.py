import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('cutover', Path(__file__).with_name('prepare-cutover.py'))
cutover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutover)


class CutoverTests(unittest.TestCase):
    def test_clones_each_root_independently_without_changing_sqlite(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'state.sqlite'
            with sqlite3.connect(database) as connection:
                connection.execute('CREATE TABLE agent_runtime_workspaces (workspace_id TEXT, pool_id TEXT, profile_id TEXT)')
                connection.executemany('INSERT INTO agent_runtime_workspaces VALUES (?, ?, ?)', [('t3:one', 'pool', 'v1'), ('t3:two', 'pool', 'v1')])
            before = database.read_bytes()
            pools = {'defaultPoolId': 'pool', 'pools': [{'id': 'pool', 'profile': 'v1', 'namespace': 't3', 'storage': {'size': '20Gi', 'storageClassName': 'retained'}}]}
            snapshots = {'items': [{'metadata': {'name': workspace[-3:], 'namespace': 't3'}, 'spec': {'source': {'persistentVolumeClaimName': 'ar-ws-' + cutover.digest(json.dumps(workspace))}}, 'status': {'readyToUse': True, 'boundVolumeSnapshotContentName': workspace[-3:], 'restoreSize': '10Gi'}} for workspace in ['t3:one', 't3:two']]}
            result = cutover.render(database, pools, snapshots)
            self.assertEqual(len(result['items']), 2)
            self.assertNotEqual(result['items'][0]['metadata']['name'], result['items'][1]['metadata']['name'])
            self.assertEqual(result['items'][0]['spec']['dataSource']['name'], 'one')
            self.assertEqual(database.read_bytes(), before)
            snapshots['items'][0]['status']['readyToUse'] = False
            with self.assertRaises(ValueError):
                cutover.render(database, pools, snapshots)
            snapshots['items'].pop(0)
            with self.assertRaises(ValueError):
                cutover.render(database, pools, snapshots)


if __name__ == '__main__':
    unittest.main()
