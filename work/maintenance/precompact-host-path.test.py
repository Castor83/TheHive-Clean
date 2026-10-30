"""Isolated PreCompact fixtures; never request a real compaction or model."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

SCRIPT = Path(__file__).resolve().parent / "fixtures/pre-compaction-snapshot.py"


class PreCompactHostPathTests(unittest.TestCase):
    def setUp(self):
        """Create temporary home/workspace paths, transcript, working file and hook event."""
        spec = importlib.util.spec_from_file_location('snapshot_fixture', SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.tmp = tempfile.TemporaryDirectory(prefix='thehive-precompact-fixture-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / 'codex'
        self.cwd = self.root / 'workspace'
        self.sid = str(uuid.uuid4())
        (self.home / 'sessions').mkdir(parents=True)
        (self.cwd / 'work/handoff').mkdir(parents=True)
        self.transcript = self.home / 'sessions' / ('rollout-' + self.sid + '.jsonl')
        self.transcript.write_text('PRIVATE_SYNTHETIC_TRANSCRIPT\n', encoding='utf-8')
        self.working = self.cwd / 'work/handoff' / (self.sid + '-working.md')
        self.working.write_text('Synthetic existing checked checkpoint\n', encoding='utf-8')
        self.event = dict(hook_event_name='PreCompact', trigger='auto', session_id=self.sid,
                          turn_id=str(uuid.uuid4()), cwd=str(self.cwd), transcript_path=str(self.transcript))

    def capture(self):
        """Return a snapshot result using only the temporary Codex home and event."""
        return self.module.capture_snapshot(self.event, codex_home=self.home)

    @unittest.skipUnless(os.name == 'nt', 'Windows native path form')
    def test_native_extended_paths_save_verify_and_reuse(self):
        """Verify Windows extended drive paths support exact snapshot copies and reuse."""
        self.event['transcript_path'] = '\\\\?\\' + str(self.transcript)
        self.event['cwd'] = '\\\\?\\' + str(self.cwd)
        result = self.capture()
        self.assertEqual(result['status'], 'PASS')
        self.assertTrue(self.module._verified(result))
        self.assertEqual(self.capture()['snapshot_path'], result['snapshot_path'])
        self.assertEqual((Path(result['snapshot_path']) / 'transcript.jsonl').read_bytes(), self.transcript.read_bytes())

    @unittest.skipUnless(os.name == 'nt', 'Windows native path form')
    def test_extended_foreign_and_unc_paths_are_rejected(self):
        """Verify extended foreign and UNC transcript paths cannot produce a PASS snapshot."""
        outside = self.root / 'foreign.jsonl'
        outside.write_text('FOREIGN', encoding='utf-8')
        for value in ('\\\\?\\' + str(outside), '\\\\?\\UNC\\fixture.invalid\\share\\source.jsonl'):
            self.event['transcript_path'] = value
            self.assertNotEqual(self.capture()['status'], 'PASS')

    def test_protocol_stops_before_compaction_for_success_and_failure(self):
        """Verify the isolated CLI returns continue:false for both valid and missing sources."""
        for valid in (True, False):
            if not valid:
                self.event['transcript_path'] = str(self.root / 'missing.jsonl')
            result = subprocess.run([str(Path(os.sys.executable)), str(SCRIPT)],
                input=json.dumps(self.event), text=True, capture_output=True,
                env={**os.environ, 'CODEX_HOME': str(self.home)}, timeout=10)
            self.assertEqual(result.returncode, 0)
            output = json.loads(result.stdout)
            self.assertIs(output.get('continue'), False)
            self.assertEqual('NICHT' in output['stopReason'], not valid)


if __name__ == '__main__':
    unittest.main()
