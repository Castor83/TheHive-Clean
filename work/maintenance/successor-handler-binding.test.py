"""Isolated handler integration. No real desktop chat or compaction is requested."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock
import uuid

HERE = Path(__file__).resolve().parent
CANDIDATE = HERE.parent / 'verification/precompact-reviewed-source-20261027.py'


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SnapshotDesktopBindingTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = load(CANDIDATE, 'snapshot_binding_candidate')
        self.tmp = tempfile.TemporaryDirectory(prefix='thehive-handler-binding-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home, self.cwd = self.root / 'codex', self.root / 'workspace'
        (self.home / 'sessions').mkdir(parents=True)
        (self.cwd / 'work/handoff').mkdir(parents=True)
        self.sid, self.tid, self.successor = (str(uuid.uuid4()) for _ in range(3))
        self.transcript = self.home / 'sessions' / ('rollout-' + self.sid + '.jsonl')
        self.transcript.write_text('OFFLINE_OPAQUE_TRANSCRIPT\n', encoding='utf-8')
        self.working = self.cwd / 'work/handoff' / (self.sid + '-working.md')
        self.working.write_text('OFFLINE_EXISTING_WORKING_STATE\n', encoding='utf-8')
        self.event = dict(hook_event_name='PreCompact', trigger='auto', session_id=self.sid,
                          turn_id=self.tid, cwd=str(self.cwd), transcript_path=str(self.transcript))

    def capture(self):
        result = self.snapshot.capture_snapshot(self.event, codex_home=self.home)
        self.assertEqual(result['status'], 'PASS')
        return result

    def process_result(self):
        return subprocess.CompletedProcess([], 0, json.dumps(dict(
            status='successor_created', successor_thread_id=self.successor)), '')

    def test_verified_snapshot_invokes_bounded_adapter_with_only_binding_fields(self):
        manifest = self.capture()
        with mock.patch.object(self.snapshot, '_desktop_process', return_value=self.process_result()) as run:
            result = self.snapshot._desktop_successor(self.event, manifest, codex_home=self.home)
        self.assertEqual(result['successor_thread_id'], self.successor)
        args, kwargs = run.call_args
        self.assertEqual(Path(args[0][1]).name, 'handoff-desktop.cjs')
        self.assertLessEqual(kwargs['timeout'], 7)
        payload = json.loads(kwargs['input'])
        self.assertEqual(set(payload), {'session_id', 'turn_id', 'cwd', 'handoff_root', 'snapshot_path'})
        self.assertEqual(payload['session_id'], self.sid)
        self.assertEqual(Path(payload['handoff_root']), self.cwd / 'work/handoff')
        receipt = json.loads((Path(manifest['snapshot_path']) / 'desktop-transition.json').read_text())
        self.assertEqual(receipt['successor_thread_id'], self.successor)
        self.assertTrue(self.snapshot._verified(manifest))

    def test_partial_or_tampered_snapshot_never_contacts_desktop(self):
        manifest = self.capture()
        with mock.patch.object(self.snapshot, '_desktop_process') as run:
            for status in ('PARTIAL', 'ERROR'):
                result = self.snapshot._desktop_successor(self.event, {**manifest, 'status': status}, codex_home=self.home)
                self.assertEqual(result['status'], 'fallback_required')
            (Path(manifest['snapshot_path']) / 'working.md').write_text('TAMPERED', encoding='utf-8')
            self.assertEqual(self.snapshot._desktop_successor(self.event, manifest, codex_home=self.home)['status'], 'fallback_required')
        run.assert_not_called()

    def test_timeout_retains_verified_snapshot_and_manual_resume(self):
        manifest = self.capture()
        with mock.patch.object(self.snapshot, '_desktop_process', side_effect=subprocess.TimeoutExpired('node', 7)):
            result = self.snapshot._desktop_successor(self.event, manifest, codex_home=self.home)
        self.assertEqual(result['status'], 'fallback_required')
        self.assertTrue(self.snapshot._verified(manifest))
        self.assertTrue((Path(manifest['snapshot_path']) / 'resume.md').is_file())

    def test_adapter_failure_writes_snapshot_bound_fallback_receipt(self):
        manifest = self.capture()
        failed = subprocess.CompletedProcess([], 1, '', 'PRIVATE_FAILURE_DETAIL')
        with mock.patch.object(self.snapshot, '_desktop_process', return_value=failed):
            result = self.snapshot._desktop_successor(self.event, manifest, codex_home=self.home)
        receipt = (Path(manifest['snapshot_path']) / 'desktop-transition.json').read_text()
        self.assertEqual(json.loads(receipt)['status'], 'fallback_required')
        self.assertNotIn('PRIVATE_FAILURE_DETAIL', receipt)
        self.assertEqual(result['status'], 'fallback_required')
        self.assertTrue(self.snapshot._verified(manifest))

    def test_invalid_successor_identity_does_not_claim_creation(self):
        manifest = self.capture()
        bad = subprocess.CompletedProcess([], 0, '{"status":"successor_created","successor_thread_id":"wrong"}', '')
        with mock.patch.object(self.snapshot, '_desktop_process', return_value=bad):
            result = self.snapshot._desktop_successor(self.event, manifest, codex_home=self.home)
        self.assertEqual(result['status'], 'fallback_required')

    def test_new_message_reason_is_preserved_and_explained_without_message_content(self):
        self.capture()
        completed = subprocess.CompletedProcess([], 0, json.dumps({
            'status': 'fallback_required', 'successor_thread_id': None,
            'reason_code': 'new_user_message_after_snapshot', 'private_text': 'NEVER_COPY_THIS'}), '')
        with mock.patch.object(self.snapshot, '_desktop_process', return_value=completed):
            output = self.snapshot.handle_event(self.event, codex_home=self.home)
        self.assertIn('Neuere Benutzernachricht', output['stopReason'])
        self.assertNotIn('NEVER_COPY_THIS', output['stopReason'])
        receipt = json.loads((Path(self.capture()['snapshot_path']) / 'desktop-transition.json').read_text())
        self.assertEqual(receipt['reason_code'], 'new_user_message_after_snapshot')

    def test_unknown_reason_is_not_copied_into_transition_receipt(self):
        manifest = self.capture()
        completed = subprocess.CompletedProcess([], 0, json.dumps({
            'status': 'fallback_required', 'reason_code': 'PRIVATE_UNKNOWN_DETAIL'}), '')
        with mock.patch.object(self.snapshot, '_desktop_process', return_value=completed):
            result = self.snapshot._desktop_successor(self.event, manifest, codex_home=self.home)
        self.assertNotIn('reason_code', result)

    def test_non_object_desktop_output_keeps_the_verified_manual_fallback(self):
        manifest = self.capture()
        for raw in ('[]', 'null', 'true', '42'):
            with self.subTest(raw=raw):
                with mock.patch.object(self.snapshot, '_desktop_process',
                        return_value=subprocess.CompletedProcess([], 0, raw, '')):
                    result = self.snapshot._desktop_successor(self.event, manifest, codex_home=self.home)
                self.assertEqual(result['status'], 'fallback_required')
                self.assertTrue(self.snapshot._verified(manifest))

    def test_non_string_successor_and_turn_keep_snapshot_and_stop(self):
        manifest = self.capture()
        for value in (42, [], {}, True):
            with self.subTest(value=value):
                raw = json.dumps(dict(status='successor_created', successor_thread_id=value))
                with mock.patch.object(self.snapshot, '_desktop_process',
                        return_value=subprocess.CompletedProcess([], 0, raw, '')):
                    result = self.snapshot._desktop_successor(self.event, manifest, codex_home=self.home)
                self.assertEqual(result['status'], 'fallback_required')
        for value in (42, [], {}, None):
            with self.subTest(turn=value), mock.patch.object(self.snapshot, '_desktop_process') as run:
                result = self.snapshot._desktop_successor({**self.event, 'turn_id': value}, manifest, codex_home=self.home)
                self.assertEqual(result['status'], 'fallback_required')
                run.assert_not_called()

    def test_malformed_operator_policy_keeps_precompact_stop_protocol(self):
        policy = self.root / 'policy.json'
        for value in ([], None, {'projects': []}, {'projects': 'wrong'}):
            with self.subTest(value=value):
                policy.write_text(json.dumps(value), encoding='utf-8')
                with mock.patch.object(self.snapshot, '_AUTOMATION_POLICY', policy):
                    result = self.snapshot.handle_event(self.event, codex_home=self.home)
                self.assertIs(result['continue'], False)

    def test_malformed_central_index_is_a_safe_snapshot_failure(self):
        store = self.root / 'central/work/handoff'
        store.mkdir(parents=True)
        policy = self.root / 'policy.json'
        policy.write_text(json.dumps(dict(projects=dict(Fixture=dict(
            workspace=str(self.cwd), handoff_root=str(store))))), encoding='utf-8')
        for value in ([], {'projects': []}, {'projects': {'Fixture': []}}):
            with self.subTest(value=value):
                (store / 'index.json').write_text(json.dumps(value), encoding='utf-8')
                with mock.patch.object(self.snapshot, '_AUTOMATION_POLICY', policy):
                    result = self.snapshot.handle_event(self.event, codex_home=self.home)
                self.assertIs(result['continue'], False)

    def test_precompact_calls_desktop_only_after_pass_and_preserves_stop(self):
        with mock.patch.object(self.snapshot, '_desktop_successor', return_value=dict(
                status='successor_created', successor_thread_id=self.successor)) as successor:
            result = self.snapshot.handle_event(self.event, codex_home=self.home)
            self.assertIs(result['continue'], False)
            self.assertIn(self.successor, result['stopReason'])
            successor.assert_called_once()
            self.event['transcript_path'] = str(self.root / 'missing.jsonl')
            self.event['turn_id'] = str(uuid.uuid4())
            result = self.snapshot.handle_event(self.event, codex_home=self.home)
            self.assertIs(result['continue'], False)
            self.assertEqual(successor.call_count, 1)

    def test_registered_central_store_is_separate_from_workspace(self):
        central = self.root / 'central-vault'
        store = central / 'work/handoff'
        store.mkdir(parents=True)
        (store / 'index.json').write_text(json.dumps(dict(projects=dict(
            Fixture=dict(session_id=self.sid)))), encoding='utf-8')
        policy = self.root / 'policy.json'
        policy.write_text(json.dumps(dict(enabled=False, projects=dict(Fixture=dict(
            workspace=str(self.cwd), handoff_root=str(store))))), encoding='utf-8')
        self.working.unlink()
        (store / self.working.name).write_text('CENTRAL_BOUND_WORKING_STATE', encoding='utf-8')
        with mock.patch.object(self.snapshot, '_AUTOMATION_POLICY', policy, create=True):
            manifest = self.capture()
        self.assertEqual(Path(manifest['working_state']['source']), store / self.working.name)
        self.assertEqual(Path(manifest['cwd']), self.cwd)

    def test_wrong_workspace_cannot_select_another_central_checkpoint(self):
        policy = self.root / 'policy.json'
        policy.write_text(json.dumps(dict(projects=dict(Fixture=dict(
            workspace=str(self.root / 'other'), handoff_root=str(self.root / 'central/work/handoff'))))), encoding='utf-8')
        with mock.patch.object(self.snapshot, '_AUTOMATION_POLICY', policy, create=True):
            root, _, _ = self.snapshot._checkpoint(self.cwd, self.sid)
        self.assertEqual(root, self.cwd)

    def test_precompact_agent_identity_is_skipped_without_a_snapshot(self):
        self.event['agent_id'] = 'offline-subagent'
        result = self.snapshot.capture_snapshot(self.event, codex_home=self.home)
        self.assertEqual(result['status'], 'SKIPPED')
        self.assertFalse((self.home / 'handoff-snapshots' / self.sid).exists())

    def test_global_policy_captures_separate_projects_from_one_central_store(self):
        store = self.root / 'central/work/handoff'
        store.mkdir(parents=True)
        other = self.root / 'other-workspace'
        other.mkdir()
        other_id = str(uuid.uuid4())
        (store / 'index.json').write_text(json.dumps(dict(projects=dict(
            Fixture=dict(session_id=self.sid), Other=dict(session_id=other_id)))), encoding='utf-8')
        for sid in (self.sid, other_id):
            (store / (sid + '-working.md')).write_text('CENTRAL_' + sid, encoding='utf-8')
        transcript = self.home / 'sessions' / ('rollout-' + other_id + '.jsonl')
        transcript.write_text('SECOND_OFFLINE_TRANSCRIPT', encoding='utf-8')
        policy = self.root / 'policy.json'
        policy.write_text(json.dumps(dict(scope='all_local_projects', handoff_root=str(store), enabled=False)), encoding='utf-8')
        events = (self.event, {**self.event, 'session_id': other_id, 'turn_id': str(uuid.uuid4()),
                  'cwd': str(other), 'transcript_path': str(transcript)})
        with mock.patch.object(self.snapshot, '_AUTOMATION_POLICY', policy):
            for event in events:
                result = self.snapshot.capture_snapshot(event, codex_home=self.home)
                self.assertEqual(result['status'], 'PASS')
                self.assertEqual(Path(result['working_state']['source']).parent, store)
                self.assertEqual(Path(result['cwd']), Path(event['cwd']))

    def test_global_policy_refuses_ambiguous_current_session(self):
        store = self.root / 'central/work/handoff'
        store.mkdir(parents=True)
        (store / 'index.json').write_text(json.dumps(dict(projects=dict(
            First=dict(session_id=self.sid), Second=dict(session_id=self.sid)))), encoding='utf-8')
        policy = self.root / 'policy.json'
        policy.write_text(json.dumps(dict(scope='all_local_projects', handoff_root=str(store))), encoding='utf-8')
        with mock.patch.object(self.snapshot, '_AUTOMATION_POLICY', policy):
            result = self.snapshot.capture_snapshot(self.event, codex_home=self.home)
        self.assertEqual(result['status'], 'ERROR')

    def test_existing_snake_journal_survives_snapshot_and_retains_successor(self):
        pointer = self.cwd / 'work/handoff' / (self.sid + '-status.json')
        raw = json.dumps(dict(origin_thread_id=self.sid, successor_thread_id=self.successor,
                              phase='uptake_confirmed'))
        pointer.write_text(raw, encoding='utf-8')
        result = self.snapshot.capture_snapshot(self.event, codex_home=self.home)
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['successor_thread_id'], self.successor)
        self.assertEqual(pointer.read_text(encoding='utf-8'), raw)
        self.assertEqual((Path(result['snapshot_path']) / 'status.json').read_text(encoding='utf-8'), raw)

    def test_conflicting_journal_aliases_cannot_select_an_origin_or_successor(self):
        pointer = self.cwd / 'work/handoff' / (self.sid + '-status.json')
        for fields in (dict(originThreadId=str(uuid.uuid4()), origin_thread_id=self.sid),
                       dict(originThreadId=self.sid, successorThreadId=self.successor,
                            successor_thread_id=str(uuid.uuid4()))):
            with self.subTest(fields=fields):
                pointer.write_text(json.dumps(fields), encoding='utf-8')
                result = self.snapshot.capture_snapshot(self.event, codex_home=self.home)
                self.assertEqual(result['status'], 'ERROR')


class GuardDesktopBindingTests(unittest.TestCase):
    def setUp(self):
        old = load(HERE / 'context-handoff-guard.test.py', 'guard_fixture_helpers')
        self.base = old.ContextGuardTests('runTest')
        self.base.setUp()
        self.addCleanup(self.base.doCleanups)
        shutil.copyfile(CANDIDATE, self.base.home / 'hooks/pre-compaction-snapshot.py')
        self.snapshot = load(CANDIDATE, 'guard_snapshot_candidate')
        self.base.event['turn_id'] = str(uuid.uuid4())

    def test_threshold_pass_invokes_existing_adapter_and_returns_stop(self):
        self.base.checkpoint()
        self.base.usage(800)
        successor = str(uuid.uuid4())
        with mock.patch.object(self.base.guard, '_helpers', return_value=self.snapshot), mock.patch.object(
                self.snapshot, '_desktop_successor', return_value=dict(status='successor_created', successor_thread_id=successor), create=True) as launch:
            result = self.base.handle()
        self.assertIs(result['continue'], False)
        self.assertIn(successor, result['stopReason'])
        launch.assert_called_once()

    def test_below_threshold_and_subagent_never_launch_successor(self):
        self.base.usage(799)
        with mock.patch.object(self.base.guard, '_helpers', return_value=self.snapshot), mock.patch.object(
                self.snapshot, '_desktop_successor', create=True) as launch:
            self.assertEqual(self.base.handle(), {})
            self.base.event['subagent_id'] = 'offline-child'
            self.base.usage(900)
            self.assertEqual(self.base.handle(), {})
        launch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
