"""Offline learning recovery fixtures; never invoke Dream or models."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).parent


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('learning_recovery', HERE / 'learning-lock-recovery.py')
        self.api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.api)
        self.temp = tempfile.TemporaryDirectory(prefix='learning-recovery-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        child = subprocess.run([sys.executable, '-c', 'import os;print(os.getpid())'], capture_output=True, text=True, check=True)
        self.pid = int(child.stdout)
        self.owner = {'pid': self.pid, 'started_at': '2026-10-30T04:00:00Z', 'host': socket.gethostname()}
        self.lock = self.root / 'run.lock'
        self.lock.write_text(json.dumps(self.owner), encoding='utf-8')
        self.status = self.root / 'status.json'
        self.status.write_bytes(b'{"status":"applying","report_dir":"retained-report"}\n')

    @unittest.skipUnless(os.name == 'nt', 'Native CIM reader is Windows-only')
    def test_native_process_inventory_is_complete_and_contains_no_command_lines(self):
        rows = self.api.processes()
        self.assertTrue(any(row['pid'] == os.getpid() for row in rows))
        for row in rows:
            self.assertEqual(set(row), {'pid', 'ppid', 'potential', 'unknown'})
        self.assertIsInstance(self.api.quiescent(self.pid, rows), bool)

    def test_dead_owner_with_complete_quiet_snapshot_archives_evidence(self):
        with mock.patch.object(self.api, 'processes', return_value=[]):
            result = self.api.recover(self.root)
        self.assertEqual(result['status'], 'recovered')
        self.assertFalse(self.lock.exists())
        self.assertEqual(Path(result['archived_status']).read_bytes(), self.status.read_bytes())
        self.assertTrue((self.root / 'lock-recovery.json').is_file())

    def test_descendant_disconnected_worker_or_unknown_runtime_keeps_lock(self):
        rows = [
            [{'pid': 100, 'ppid': self.pid, 'potential': False, 'unknown': False}],
            [{'pid': 100, 'ppid': 999, 'potential': True, 'unknown': False}],
            [{'pid': 100, 'ppid': 999, 'potential': False, 'unknown': True}],
            [{'pid': 100}],
        ]
        original = self.lock.read_bytes()
        for snapshot in rows:
            with self.subTest(snapshot=snapshot), mock.patch.object(self.api, 'processes', return_value=snapshot):
                self.assertEqual(self.api.recover(self.root)['status'], 'locked')
                self.assertEqual(self.lock.read_bytes(), original)
                self.assertFalse((self.root / 'lock-recovery.json').exists())

    def test_live_foreign_or_malformed_owner_does_not_start_inspection(self):
        for owner in ({**self.owner, 'pid': os.getpid()}, {**self.owner, 'host': 'foreign'}, None):
            self.lock.write_text(json.dumps(owner) if owner else 'incomplete JSON', encoding='utf-8')
            before = self.lock.read_bytes()
            with self.subTest(owner=owner), mock.patch.object(self.api, 'processes') as probe:
                self.assertEqual(self.api.recover(self.root)['status'], 'locked')
                probe.assert_not_called()
                self.assertEqual(self.lock.read_bytes(), before)

    def test_probe_failure_preserves_lock_status_and_existing_reports(self):
        before = self.lock.read_bytes(), self.status.read_bytes()
        with mock.patch.object(self.api, 'processes', side_effect=ValueError('unavailable')):
            with self.assertRaises(ValueError):
                self.api.recover(self.root)
        self.assertEqual((self.lock.read_bytes(), self.status.read_bytes()), before)

    def test_two_recoveries_never_archive_a_new_live_owner(self):
        with mock.patch.object(self.api, 'processes', return_value=[]):
            first = self.api.recover(self.root)
        self.assertEqual(first['status'], 'recovered')
        owner = json.dumps({**self.owner, 'pid': os.getpid()})
        self.lock.write_text(owner, encoding='utf-8')
        with mock.patch.object(self.api, 'processes') as probe:
            self.assertEqual(self.api.recover(self.root)['status'], 'locked')
            probe.assert_not_called()
        self.assertEqual(self.lock.read_text(encoding='utf-8'), owner)


if __name__ == '__main__':
    unittest.main()
