"""New offline fixtures only; never trigger a native compaction or model."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock
import uuid

HERE = Path(__file__).parent


class ContextGuardTests(unittest.TestCase):
    def test_python_node_boundary_preserves_waiting_status_and_failure_reason(self):
        spec = importlib.util.spec_from_file_location('precompact_boundary', Path.home() / '.codex/hooks/pre-compaction-snapshot.py')
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        self.store.mkdir(parents=True)
        directory = self.home / 'handoff-snapshots' / self.session / 'fixture'
        directory.mkdir(parents=True)
        event = {**self.event, 'turn_id': str(uuid.uuid4())}
        manifest = dict(status='PASS', session_id=self.session, cwd=str(self.cwd), snapshot_path=str(directory),
                        working_state={'source': str(self.store / 'working.md')})
        for expected in ({'status': 'waiting_for_origin', 'successor_thread_id': None},
                         {'status': 'fallback_required', 'successor_thread_id': None, 'reason_code': 'navigation_failed'}):
            completed = subprocess.CompletedProcess([], 0, stdout=json.dumps(expected), stderr='')
            with self.subTest(expected=expected), mock.patch.object(helper, '_verified', return_value=True), \
                 mock.patch.object(helper, '_desktop_process', return_value=completed):
                actual = helper._desktop_successor(event, manifest, handoff_root=self.store, codex_home=self.home)
            self.assertEqual(actual, expected)

    def test_precompact_waiting_notice_matches_deferred_visible_switch(self):
        spec = importlib.util.spec_from_file_location('precompact_notice', Path.home() / '.codex/hooks/pre-compaction-snapshot.py')
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        with mock.patch.object(helper, 'capture_snapshot', return_value={'status': 'PASS', 'snapshot_path': str(self.root)}), \
             mock.patch.object(helper, '_desktop_successor', return_value={'status': 'waiting_for_origin'}):
            result = helper.handle_event({})
        self.assertIn('Weiterleitung läuft', result['systemMessage'])
        self.assertNotIn('wurde geöffnet', result['systemMessage'])
        self.assertIs(result['continue'], False)

    def test_visible_handoff_requests_final_user_message_and_no_more_work(self):
        from types import SimpleNamespace
        self.usage(800)
        real_helpers = self.guard._helpers(self.home)
        self.store.mkdir(parents=True)
        helpers = SimpleNamespace(_local=lambda _: True, _atomic_json=lambda *a: None,
                                  _transition_message=real_helpers._transition_message,
                                  _desktop_successor=lambda *a, **kw: {'status': 'waiting_for_origin'})
        usage = dict(used_tokens=800, model_context_window=1000, limit_tokens=1000, threshold_percent=80)
        with mock.patch.object(self.guard, '_helpers', return_value=helpers), \
             mock.patch.object(self.guard, '_usage', return_value=(self.transcript, usage)), \
             mock.patch.object(self.guard, '_capture', return_value={'snapshot_path': str(self.root), 'status': 'PASS'}):
            result = self.handle()
        self.assertIn('Weiterleitung läuft', result['systemMessage'])
        context = result['hookSpecificOutput']['additionalContext']
        self.assertIn('Schlussantwort', context)
        self.assertIn('Keine weiteren Werkzeuge', context)
        self.assertNotIn('waiting_for_origin', context)
        self.assertNotIn('Details:', context)

    def setUp(self):
        spec = importlib.util.spec_from_file_location('context_guard', HERE / 'context-handoff-guard.py')
        self.guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.guard)
        self.temporary = tempfile.TemporaryDirectory(prefix='thehive-context-fixture-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / 'codex'
        self.cwd = self.root / 'workspace'
        self.store = self.cwd / 'work' / 'handoff'
        self.cwd.mkdir()
        (self.home / 'sessions').mkdir(parents=True)
        (self.home / 'hooks').mkdir()
        shutil.copyfile(Path.home() / '.codex/hooks/pre-compaction-snapshot.py',
                        self.home / 'hooks/pre-compaction-snapshot.py')
        self.session = str(uuid.uuid4())
        self.transcript = self.home / 'sessions' / ('rollout-fixture-' + self.session + '.jsonl')
        self.event = dict(hook_event_name='PostToolUse', session_id=self.session,
                          cwd=str(self.cwd), transcript_path=str(self.transcript), turn_id=str(uuid.uuid4()),
                          tool_use_id='fixture-tool-call', tool_name='Bash')

    def usage(self, used, window=1000, lifetime=900000, announced=True):
        rows = [dict(type='session_meta', payload=dict(id=self.session, source='cli')),
                dict(type='event_msg', timestamp='2026-10-26T11:50:00Z', payload=dict(type='token_count',
                     info=dict(model_context_window=window, total_token_usage=dict(total_tokens=lifetime),
                               last_token_usage=dict(total_tokens=used)))),
                dict(type='event_msg', payload=dict(type='task_started', turn_id=self.event['turn_id']))]
        if announced:
            rows.append(dict(type='response_item', payload=dict(type='message', role='assistant', phase='commentary',
                        content=[dict(type='output_text', text=self.guard.ANNOUNCEMENT)])))
        self.transcript.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')

    def checkpoint(self, *, bind_task=True):
        source = """
const {saveCheckpoint}=require(process.argv[1]);
const r=saveCheckpoint(process.argv[2],{format_version:1,project_id:'Fixture',session_id:process.argv[3],expected_parent:null,
chat_task:{source_ref:'human',next_step:{text:'Continue fixture task',task_id:'next',success_criterion:'Fixture proof'}},
patch:{goal:'OFFLINE_FIXTURE_ONLY',status:'planned',last_section:'Fixture',git:{workspace:process.argv[4]},sources:{human:{reference:'Synthetic offline fixture'}},
tasks:{next:{text:'Continue fixture task',status:'planned'}},next_step:{text:'Continue fixture task',task_id:'next',success_criterion:'Fixture proof'}}});
console.log(JSON.stringify({checkpoint_id:r.checkpoint_id,file:r.file,sha256:r.sha256}));
"""
        if not bind_task:
            source = source.replace("chat_task:{source_ref:'human',next_step:{text:'Continue fixture task',task_id:'next',success_criterion:'Fixture proof'}},", '')
        result = subprocess.run(['node', '-e', source, str(HERE / 'handoff-store.cjs'), str(self.store), self.session, str(self.cwd)],
                                check=True, capture_output=True, text=True, timeout=10)
        return json.loads(result.stdout)

    def handle(self):
        return self.guard.handle_event(self.event, codex_home=self.home, handoff_root=self.store)

    def test_threshold_announces_before_snapshot_or_app_and_then_completes(self):
        self.usage(850, announced=False)
        self.checkpoint()
        with mock.patch.object(self.guard, '_capture') as capture:
            result = self.handle()
        capture.assert_not_called()
        self.assertNotIn('continue', result)
        self.assertIn(self.guard.ANNOUNCEMENT, result['hookSpecificOutput']['additionalContext'])
        file = self.home / 'handoff-snapshots' / self.session / 'context-observation.json'
        record = json.loads(file.read_text(encoding='utf-8'))
        self.assertEqual(record['decision'], 'announcement_pending')
        self.assertEqual(record['announcement']['turn_id'], self.event['turn_id'])
        self.assertFalse(list(file.parent.glob('context-*/manifest.json')))
        with self.transcript.open('a', encoding='utf-8') as h:
            h.write(json.dumps(dict(type='response_item', payload=dict(type='message', role='assistant', phase='commentary',
                        content=[dict(type='output_text', text=self.guard.ANNOUNCEMENT)]))) + '\n')
        complete = self.handle()
        self.assertIs(complete.get('continue'), False)
        self.assertIn('Sicherung bestaetigt', complete['stopReason'])

    def test_announcement_from_another_turn_cannot_authorize_transition(self):
        self.usage(850)
        self.event['turn_id'] = str(uuid.uuid4())
        with mock.patch.object(self.guard, '_capture') as capture:
            result = self.handle()
        capture.assert_not_called()
        self.assertIn('commentary', result['hookSpecificOutput']['additionalContext'])

    def test_status_reports_real_state_reason_and_exactly_one_manual_link(self):
        helper = self.guard._helpers(self.home)
        url = 'codex://threads/new?path=C%3A%5CFixture'
        for reason, expected in [('new_user_message_after_snapshot', 'neue Nachricht'),
                                 ('app_access_failed', 'Zugriff auf die App'),
                                 ('navigation_failed', 'nicht geöffnet')]:
            with self.subTest(reason=reason):
                text = helper._transition_message(dict(status='fallback_required', reason_code=reason, manual_start_url=url))
                self.assertIn('Weiterleitung fehlgeschlagen', text)
                self.assertIn(expected, text)
                self.assertEqual(text.count('](' + url + ')'), 1)
                self.assertNotIn(reason, text)
        text = helper._transition_message(dict(status='successor_visible'))
        self.assertNotIn('wurde geöffnet', text)
        text = helper._transition_message(dict(status='successor_visible', navigation_confirmed=True))
        self.assertIn('wurde geöffnet', text)

    def test_unbound_chat_still_saves_snapshot_without_foreign_project_order(self):
        self.usage(850)
        self.checkpoint(bind_task=False)
        result = self.handle()
        self.assertIn('Sicherung bestaetigt', result['stopReason'])
        manifest = json.loads((self.home / 'handoff-snapshots' / self.session / 'context-latest.json').read_text())
        self.assertEqual(manifest['status'], 'PASS')
        starter = (Path(manifest['snapshot_path']) / 'successor-start.txt').read_text(encoding='utf-8')
        self.assertIn('Keine automatische Fortsetzung', starter)
        self.assertNotIn('Continue fixture task', starter)

    def test_current_context_not_lifetime_and_exact_threshold(self):
        self.usage(799)
        self.assertEqual(self.handle(), {})
        self.usage(800)
        result = self.handle()
        self.assertIs(result.get('continue'), False)
        self.assertIn('NICHT bestaetigt', result['stopReason'])  # Missing fixture checkpoint must fail safe.

    def test_first_snapshot_after_parallel_project_checkpoint_uses_own_history(self):
        self.usage(850)
        own = self.checkpoint()
        source = """
const {saveCheckpoint}=require(process.argv[1]);
saveCheckpoint(process.argv[2],{format_version:1,project_id:'Fixture',session_id:process.argv[3],expected_parent:process.argv[4],
patch:{last_section:'Parallel new regression'}});
"""
        subprocess.run(['node', '-e', source, str(HERE / 'handoff-store.cjs'), str(self.store),
                        str(uuid.uuid4()), own['checkpoint_id']], check=True, capture_output=True, timeout=10)
        index_before = (self.store / 'index.json').read_bytes()
        current_before = (self.store / 'Fixture/current.md').read_bytes()
        result = self.handle()
        self.assertIn('Sicherung bestaetigt', result['stopReason'])
        manifest = json.loads((self.home / 'handoff-snapshots' / self.session / 'context-latest.json').read_text())
        self.assertEqual(manifest['checkpoint_id'], own['checkpoint_id'])
        start = (Path(manifest['snapshot_path']) / 'successor-start.txt').read_text(encoding='utf-8')
        self.assertIn(str(self.store / 'Fixture/history'), start)
        self.assertEqual((self.store / 'index.json').read_bytes(), index_before)
        self.assertEqual((self.store / 'Fixture/current.md').read_bytes(), current_before)

    def test_smaller_configured_compact_limit_is_used(self):
        self.usage(399)
        (self.home / 'config.toml').write_text('model_auto_compact_token_limit = 500\n', encoding='utf-8')
        self.assertEqual(self.handle(), {})
        self.usage(400)
        self.assertIs(self.handle().get('continue'), False)

    def test_snapshot_verified_three_fields_and_no_models_or_chat(self):
        self.usage(850)
        cp = self.checkpoint()
        original = self.transcript.read_bytes()
        result = self.handle()
        self.assertIs(result.get('continue'), False)
        self.assertIn('Sicherung bestaetigt', result['stopReason'])
        manifest = json.loads((self.home / 'handoff-snapshots' / self.session / 'context-latest.json').read_text())
        self.assertEqual(manifest['status'], 'PASS')
        self.assertEqual(manifest['trigger'], 'context_usage')
        self.assertEqual(manifest['checkpoint_id'], cp['checkpoint_id'])
        self.assertFalse(manifest['model_called'])
        self.assertFalse(manifest['chat_created'])
        directory = Path(manifest['snapshot_path'])
        self.assertEqual((directory / 'transcript.jsonl').read_bytes(), original)
        self.assertEqual((directory / 'working.md').read_bytes(), Path(cp['file']).read_bytes())
        start = (directory / 'successor-start.txt').read_text(encoding='utf-8').splitlines()
        immutable = self.guard._checkpoint(self.store, self.session, self.cwd)['file']
        self.assertIn(str(self.store / 'Fixture/history'), immutable)
        self.assertEqual(start, ['Projekt-ID: Fixture', 'Handoff-Datei: ' + immutable,
                                 'Naechster offener Arbeitsschritt: Continue fixture task'])
        self.assertNotIn('OFFLINE_FIXTURE_ONLY', '\n'.join(start))
        self.assertEqual(self.handle(), result)
        self.assertEqual(len(list((self.home / 'handoff-snapshots' / self.session).glob('context-*/manifest.json'))), 1)

    def test_foreign_session_or_path_never_claims_usage_or_copies(self):
        self.usage(800)
        self.event['session_id'] = str(uuid.uuid4())
        self.assertNotIn('continue', self.handle())
        self.event['session_id'] = self.session
        outside = self.root / ('rollout-' + self.session + '.jsonl')
        outside.write_bytes(self.transcript.read_bytes())
        self.event['transcript_path'] = str(outside)
        self.assertNotIn('continue', self.handle())
        self.assertFalse(list((self.home / 'handoff-snapshots').glob('**/transcript.jsonl')))

    def test_missing_usage_and_subagent_skip_without_false_trigger(self):
        self.usage(800)
        self.event['subagent_id'] = 'fixture-child'
        self.assertEqual(self.handle(), {})
        del self.event['subagent_id']
        self.usage(None)
        self.assertNotIn('continue', self.handle())

    def test_compacted_marker_invalidates_prior_usage(self):
        self.usage(900)
        with self.transcript.open('a', encoding='utf-8') as h:
            h.write(json.dumps(dict(type='compacted', payload={})) + '\n')
        self.assertNotIn('continue', self.handle())

    def test_changed_working_copy_fails_safe_and_no_success_manifest(self):
        self.usage(800)
        self.checkpoint()
        (self.store / (self.session + '-working.md')).write_text('Unverified change', encoding='utf-8')
        result = self.handle()
        self.assertIs(result.get('continue'), False)
        self.assertIn('NICHT bestaetigt', result['stopReason'])
        self.assertFalse((self.home / 'handoff-snapshots' / self.session / 'context-latest.json').exists())

    def test_records_execution_below_threshold_without_content_or_snapshot(self):
        self.usage(300)
        self.event['tool_input'] = {'command': 'PRIVATE_FIXTURE_COMMAND'}
        self.event['tool_response'] = 'PRIVATE_FIXTURE_RESPONSE'
        self.assertEqual(self.handle(), {})
        file = self.home / 'handoff-snapshots' / self.session / 'context-observation.json'
        self.assertTrue(file.is_file(), 'A real invocation must leave a compact observable record')
        observed = json.loads(file.read_text(encoding='utf-8'))
        self.assertEqual(observed['decision'], 'below_threshold')
        self.assertEqual(observed['native_hook_event'], 'PostToolUse')
        self.assertEqual(observed['tool_use_id'], 'fixture-tool-call')
        self.assertEqual(observed['used_tokens'], 300)
        self.assertEqual(observed['limit_tokens'], 1000)
        self.assertNotIn('PRIVATE_FIXTURE', file.read_text(encoding='utf-8'))
        self.assertFalse(list(file.parent.glob('context-*/manifest.json')))

    def test_missing_usage_records_unavailable_instead_of_claiming_measurement(self):
        self.usage(None)
        self.assertNotIn('continue', self.handle())
        file = self.home / 'handoff-snapshots' / self.session / 'context-observation.json'
        self.assertTrue(file.is_file(), 'Unreadable usage must remain distinguishable from a skipped hook')
        observed = json.loads(file.read_text(encoding='utf-8'))
        self.assertEqual(observed['decision'], 'usage_unavailable')
        self.assertNotIn('used_tokens', observed)

    def test_user_prompt_is_not_a_second_context_monitor(self):
        self.usage(850)
        self.checkpoint()
        self.event['hook_event_name'] = 'UserPromptSubmit'
        self.assertEqual(self.handle(), {})
        self.assertFalse((self.home / 'handoff-snapshots').exists())

    def test_appended_messages_reuse_first_verified_snapshot(self):
        self.usage(850)
        self.checkpoint()
        first = self.handle()
        latest = self.home / 'handoff-snapshots' / self.session / 'context-latest.json'
        saved = latest.read_bytes()
        with self.transcript.open('a', encoding='utf-8') as handle:
            handle.write(json.dumps({'type': 'response_item', 'payload': {'role': 'user', 'content': 'fixture resume question'}}) + '\n')
        self.event['turn_id'] = str(uuid.uuid4())
        self.event['tool_use_id'] = 'fixture-followup-tool'
        pending = self.handle()
        self.assertNotIn('continue', pending)
        self.assertIn('commentary', pending['hookSpecificOutput']['additionalContext'])
        with self.transcript.open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(dict(type='event_msg', payload=dict(type='task_started', turn_id=self.event['turn_id']))) + '\n')
            handle.write(json.dumps(dict(type='response_item', payload=dict(role='assistant', phase='commentary',
                         content=[dict(type='output_text', text=self.guard.ANNOUNCEMENT)]))) + '\n')
        self.assertIs(self.handle().get('continue'), False)
        self.assertEqual(latest.read_bytes(), saved)
        self.assertEqual(len(list(latest.parent.glob('context-*/manifest.json'))), 1)

    def test_new_usage_same_checkpoint_does_not_restart_capture(self):
        self.usage(850)
        self.checkpoint()
        first = self.handle()
        latest = self.home / 'handoff-snapshots' / self.session / 'context-latest.json'
        saved = latest.read_bytes()
        with self.transcript.open('a', encoding='utf-8') as handle:
            handle.write(json.dumps({'type': 'event_msg', 'timestamp': '2026-10-26T11:51:00Z', 'payload': {
                'type': 'token_count', 'info': {'model_context_window': 1000, 'last_token_usage': {'total_tokens': 860}}}}) + '\n')
        self.assertEqual(self.handle(), first)
        self.assertEqual(latest.read_bytes(), saved)
        self.assertEqual(len(list(latest.parent.glob('context-*/manifest.json'))), 1)

    def test_changed_resume_file_is_never_claimed_verified(self):
        self.usage(850)
        cp = self.checkpoint()
        original = Path(cp['file']).read_bytes()
        self.handle()
        latest = self.home / 'handoff-snapshots' / self.session / 'context-latest.json'
        manifest = json.loads(latest.read_text())
        (Path(manifest['snapshot_path']) / 'successor-start.txt').write_text('WRONG PROJECT', encoding='utf-8')
        result = self.handle()
        self.assertIs(result.get('continue'), False)
        self.assertIn('NICHT bestaetigt', result['stopReason'])
        self.assertEqual(Path(cp['file']).read_bytes(), original)
        self.assertEqual(len(list(latest.parent.glob('context-*/manifest.json'))), 1)

    def test_failed_copy_is_not_retried_for_same_checkpoint(self):
        self.usage(850)
        cp = self.checkpoint()
        original = Path(cp['file']).read_bytes()
        helpers = self.guard._helpers(self.home)
        with mock.patch.object(self.guard, '_helpers', return_value=helpers):
            with mock.patch.object(helpers, '_copy_prefix', side_effect=OSError('fixture disk write failure')) as copy:
                first = self.handle()
                second = self.handle()
        self.assertIs(first.get('continue'), False)
        self.assertIs(second.get('continue'), False)
        self.assertIn('NICHT bestaetigt', second['stopReason'])
        self.assertEqual(copy.call_count, 1)
        self.assertEqual(Path(cp['file']).read_bytes(), original)
        self.assertFalse((self.home / 'handoff-snapshots' / self.session / 'context-latest.json').exists())

    def test_invalid_attempt_metadata_still_returns_safe_stop(self):
        self.usage(850)
        self.checkpoint()
        parent = self.home / 'handoff-snapshots' / self.session
        parent.mkdir(parents=True)
        (parent / 'context-last-attempt.json').write_text('[]', encoding='utf-8')
        result = self.handle()
        self.assertIs(result.get('continue'), False)
        self.assertIn('NICHT bestaetigt', result['stopReason'])
        self.assertFalse((parent / 'context-latest.json').exists())

    def test_usage_failure_records_bounded_reason_without_private_error(self):
        self.usage(300)
        with mock.patch.object(self.guard, '_usage', side_effect=OSError('PRIVATE_FIXTURE_SOURCE_DETAILS')):
            self.assertNotIn('continue', self.handle())
        file = self.home / 'handoff-snapshots' / self.session / 'context-observation.json'
        observed = json.loads(file.read_text(encoding='utf-8'))
        self.assertEqual(observed.get('usage_error_code'), 'source_unreadable')
        self.assertNotIn('PRIVATE_FIXTURE', file.read_text(encoding='utf-8'))

    def test_missing_usage_records_specific_safe_reason(self):
        self.usage(None)
        self.handle()
        file = self.home / 'handoff-snapshots' / self.session / 'context-observation.json'
        observed = json.loads(file.read_text(encoding='utf-8'))
        self.assertEqual(observed.get('usage_error_code'), 'usage_signal_missing')

    @unittest.skipUnless(os.name == 'nt', 'Windows extended path regression')
    def test_windows_extended_transcript_below_threshold(self):
        self.usage(300)
        self.event['transcript_path'] = '\\\\?\\' + str(self.transcript)
        self.assertEqual(self.handle(), {})

    @unittest.skipUnless(os.name == 'nt', 'Windows extended path regression')
    def test_windows_extended_transcript_saves_at_threshold(self):
        self.usage(800)
        self.checkpoint()
        self.event['transcript_path'] = '\\\\?\\' + str(self.transcript)
        result = self.handle()
        self.assertIs(result.get('continue'), False)
        self.assertIn('Sicherung bestaetigt', result['stopReason'])

    @unittest.skipUnless(os.name == 'nt', 'Windows extended path regression')
    def test_windows_extended_foreign_path_and_unc_stay_rejected(self):
        self.usage(800)
        outside = self.root / ('rollout-' + self.session + '.jsonl')
        outside.write_bytes(self.transcript.read_bytes())
        for value in ('\\\\?\\' + str(outside), '\\\\?\\UNC\\fixture.invalid\\share\\rollout-' + self.session + '.jsonl'):
            with self.subTest(path_kind='outside' if value.endswith(str(outside)) else 'UNC'):
                self.event['transcript_path'] = value
                self.assertNotIn('continue', self.handle())
        self.assertFalse(list((self.home / 'handoff-snapshots').glob('**/transcript.jsonl')))


if __name__ == '__main__':
    unittest.main()
