"""Bounded local context snapshot hook with the existing desktop adapter.

token_count is a version-dependent local fallback, not a stable Codex API.
The native synchronous PreCompact hook remains the final safety boundary.
"""
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib
import uuid

THRESHOLD_PERCENT = 80
MAX_TAIL = 1024 * 1024
MAX_EVENT = 65536
ANNOUNCEMENT = 'Die automatische Chatweiterleitung wird jetzt aktiviert. Ich sichere den Arbeitsstand; danach endet dieser Lauf. Falls der automatische Wechsel scheitert, kannst du den neuen Chat selbst starten.'
HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE.parent / 'handoff'
USAGE_ERRORS = {
    'Local transcript path unavailable.': 'transcript_path_unavailable',
    'Transcript is outside the local session area.': 'transcript_outside_allowed_area',
    'Transcript does not belong to this session.': 'transcript_session_name_mismatch',
    'Transcript session identity differs.': 'transcript_session_identity_mismatch',
    'Subagent transcript is not a main-chat context signal.': 'subagent_transcript',
    'No valid current token_count in the bounded transcript tail.': 'usage_signal_missing',
    'Context configuration cannot be read safely.': 'config_source_unsafe',
    'Invalid profile context configuration.': 'config_profile_invalid',
    'Invalid active profile context configuration.': 'config_profile_invalid',
}


def _positive(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _observe(event, home, helpers, decision, usage=None, error_code=None, announcement=None):
    """One bounded last-invocation record; never log prompts, inputs or outputs."""
    try:
        directory = home / 'handoff-snapshots' / event['session_id']
        if not helpers._local(home) or not directory.resolve().is_relative_to(home):
            return
        directory.mkdir(parents=True, exist_ok=True)
        record = dict(schema_version=1, observed_at_utc=datetime.now(timezone.utc).isoformat(),
                      session_id=event['session_id'], native_hook_event=event['hook_event_name'],
                      decision=decision, script_pid=os.getpid(),
                      guard_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
        source_path = event.get('transcript_path')
        record['transcript_windows_extended'] = isinstance(source_path, str) and source_path.startswith('\\\\?\\')
        if error_code is not None:
            record['usage_error_code'] = error_code
        if announcement is not None:
            record['announcement'] = announcement
        for key in ('turn_id', 'tool_use_id', 'tool_name'):
            if isinstance(event.get(key), str):
                record[key] = event[key][:160]
        if usage is not None:
            for key in ('used_tokens', 'model_context_window', 'limit_tokens', 'threshold_percent'):
                record[key] = usage[key]
        helpers._atomic_json(directory / 'context-observation.json', record)
    except (OSError, ValueError, TypeError, KeyError):
        # Diagnostic failure must not weaken the existing save/stop decision.
        pass


def _helpers(home):
    source = (home / 'hooks' / 'pre-compaction-snapshot.py').resolve(strict=True)
    if not source.is_relative_to(home):
        raise ValueError('Snapshot helper escaped CODEX_HOME.')
    spec = importlib.util.spec_from_file_location('thehive_existing_snapshot', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _announcement_seen(event, transcript):
    """Require the actual assistant commentary in this turn before transition."""
    with transcript.open('rb') as handle:
        size = os.fstat(handle.fileno()).st_size
        handle.seek(max(0, size - MAX_TAIL))
        lines = handle.read(MAX_TAIL).splitlines()
    in_turn, seen = False, False
    for line in lines:
        try:
            row = json.loads(line)
        except (ValueError, UnicodeError):
            continue
        payload = row.get('payload', {})
        if not isinstance(payload, dict):
            continue
        if row.get('type') == 'event_msg' and payload.get('type') in ('task_started', 'turn_started'):
            in_turn = payload.get('turn_id') == event.get('turn_id')
            seen = False
        if (in_turn and row.get('type') == 'response_item' and payload.get('role') == 'assistant'
                and payload.get('phase') == 'commentary'):
            text = ''.join(item.get('text', '') for item in payload.get('content', []) if isinstance(item, dict))
            if ANNOUNCEMENT in text:
                seen = True
    return seen


def _request_announcement(event, home, helpers, transcript, usage):
    if not isinstance(event.get('turn_id'), str) or str(uuid.UUID(event['turn_id'])) != event['turn_id']:
        raise ValueError('Actual turn required for visible announcement.')
    minimal = {key: event[key] for key in ('session_id', 'turn_id', 'cwd', 'hook_event_name')}
    minimal['transcript_path'] = str(transcript)
    _observe(event, home, helpers, 'announcement_pending', usage, announcement=minimal)
    record = home / 'handoff-snapshots' / event['session_id'] / 'context-observation.json'
    # This is feedback to the running model, not an invisible promise of a host UI.
    instruction = ('Vor einem Chatwechsel zuerst JETZT im commentary-Kanal exakt diese sichtbare Nachricht senden: '
                   + ANNOUNCEMENT + '\nDanach ausschliesslich den vorhandenen lokalen Abschluss ausfuehren: '
                   + 'PowerShell: & "' + sys.executable + '" "' + str(Path(__file__).resolve()) + '" --complete-announcement "' + str(record) + '". '
                   'Keine Facharbeit dazwischen. Dessen Ausgabe enthaelt die abschliessende Nutzermeldung; '
                   'nur diese Meldung ausgeben, keine Diagnosedetails. Ohne vorherige sichtbare Ankuendigung kein Wechsel.')
    return {'systemMessage': 'Chatweiterleitung wartet auf sichtbare Ankündigung.',
            'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': instruction}}


def _compact_limit(home, cwd, window):
    config = {}
    for root in (home, cwd / '.codex'):
        candidate = root / 'config.toml'
        if candidate.exists():
            file = candidate.resolve(strict=True)
            if not file.is_relative_to(root.resolve()) or file.stat().st_size > MAX_TAIL:
                raise ValueError('Context configuration cannot be read safely.')
            config.update(tomllib.loads(file.read_text(encoding='utf-8-sig')))
    profiles = config.get('profiles', {})
    if not isinstance(profiles, dict):
        raise ValueError('Invalid profile context configuration.')
    active = profiles.get(config.get('profile'), {})
    if not isinstance(active, dict):
        raise ValueError('Invalid active profile context configuration.')
    limit = active.get('model_auto_compact_token_limit', config.get('model_auto_compact_token_limit'))
    return min(window, limit) if _positive(limit) else window


def _usage(event, home, cwd, helpers):
    value = event.get('transcript_path') or ''
    # The Windows host supplies canonical \\?\C:\ paths. Normalize only that
    # drive namespace before comparing against the unchanged local roots.
    # Extended UNC/device paths are not normalized and remain rejected.
    if (os.name == 'nt' and isinstance(value, str) and value.startswith('\\\\?\\')
            and len(value) >= 7 and value[4].isascii() and value[4].isalpha()
            and value[5:7] in (':\\', ':/')):
        value = value[4:]
    file = Path(value)
    if not file.is_absolute() or not helpers._local(file):
        raise ValueError('Local transcript path unavailable.')
    file = file.resolve(strict=True)
    allowed = [(home / name).resolve() for name in ('sessions', 'archived_sessions')]
    if (any(not root.is_relative_to(home) for root in allowed)
            or not any(file.is_relative_to(root) for root in allowed) or not helpers._local(file)):
        raise ValueError('Transcript is outside the local session area.')
    if not file.name.endswith(event['session_id'] + '.jsonl'):
        raise ValueError('Transcript does not belong to this session.')
    with file.open('rb') as handle:
        header = json.loads(handle.readline(MAX_TAIL + 1))
        metadata = header.get('payload', {})
        if header.get('type') != 'session_meta' or metadata.get('id') != event['session_id']:
            raise ValueError('Transcript session identity differs.')
        if isinstance(metadata.get('source'), dict) and 'subagent' in metadata['source']:
            raise ValueError('Subagent transcript is not a main-chat context signal.')
        size = os.fstat(handle.fileno()).st_size
        handle.seek(max(0, size - MAX_TAIL))
        tail = handle.read(MAX_TAIL)
    latest = None
    for line in tail.splitlines():
        try:
            row = json.loads(line)
        except (ValueError, UnicodeError):
            continue
        if not isinstance(row, dict):
            continue
        if row.get('type') == 'compacted':
            latest = None
        payload = row.get('payload')
        if (row.get('type') == 'event_msg' and isinstance(payload, dict)
                and payload.get('type') == 'token_count' and isinstance(payload.get('info'), dict)):
            info = payload['info']
            last = info.get('last_token_usage')
            used = last.get('total_tokens') if isinstance(last, dict) else None
            window = info.get('model_context_window')
            # Never use total_token_usage: that is cumulative lifetime consumption.
            latest = (dict(used_tokens=used, model_context_window=window, timestamp=row.get('timestamp'))
                      if _positive(used) and _positive(window) else None)
    if latest is None:
        raise ValueError('No valid current token_count in the bounded transcript tail.')
    latest['limit_tokens'] = _compact_limit(home, cwd, latest['model_context_window'])
    latest['threshold_percent'] = THRESHOLD_PERCENT
    return file, latest


def _checkpoint(root, session, workspace=None):
    # Reuse the existing validator, lock and parent/hash verification. Node is a
    # local file reader here; no Codex process, prompt or model is started.
    code = """
const {resumeBoundCheckpoint,chatTaskForCheckpoint}=require(process.argv[1]);
const {checkpoint:r}=resumeBoundCheckpoint(process.argv[2],{session_id:process.argv[3],workspace:process.argv[4]});
let continuation;try{continuation=chatTaskForCheckpoint(r,process.argv[3]);}catch{}
console.log(JSON.stringify({project_id:r.project_id,checkpoint_id:r.checkpoint_id,
file:r.file,sha256:r.sha256,chat_task_status:continuation?'bound':'unbound',
next_step:continuation?continuation.next_step.text:'Keine automatische Fortsetzung: Chat-Auftrag im gesicherten Ursprung pruefen und ausdruecklich binden.'}));
"""
    result = subprocess.run(['node', '-e', code, str(HERE / 'handoff-store.cjs'), str(root), session, str(workspace or '')],
                            capture_output=True, text=True, encoding='utf-8', timeout=8,
                            creationflags=0x08000000 if os.name == 'nt' else 0)
    if result.returncode or len(result.stdout) > MAX_EVENT:
        raise ValueError('Indexed checkpoint unavailable or inconsistent; no alternate project loaded.')
    record = json.loads(result.stdout)
    if not all(isinstance(record.get(key), str) and record[key] for key in
               ('project_id', 'checkpoint_id', 'file', 'sha256', 'next_step')):
        raise ValueError('Checkpoint summary is incomplete.')
    return record


def _capture(event, home, root, transcript, usage, helpers):
    checkpoint = _checkpoint(root, event['session_id'], event['cwd'])
    working = root / (event['session_id'] + '-working.md')
    if helpers._digest(working) != checkpoint['sha256']:
        raise ValueError('Working projection differs from the verified session checkpoint.')
    start = ('Projekt-ID: ' + checkpoint['project_id'] + '\nHandoff-Datei: ' + checkpoint['file']
             + '\nNaechster offener Arbeitsschritt: ' + ' '.join(checkpoint['next_step'].split()) + '\n')
    if len(start) > 3000:
        raise ValueError('Next step too long for the minimal three-field starter.')
    parent = home / 'handoff-snapshots' / event['session_id']
    if not parent.resolve().is_relative_to(home):
        raise ValueError('Snapshot area escaped CODEX_HOME.')
    parent.mkdir(parents=True, exist_ok=True)
    lock = parent / 'context.lock'
    nonce = uuid.uuid4().hex
    with lock.open('x', encoding='ascii') as handle:
        handle.write(nonce)
    attempt = None
    attempt_file = parent / 'context-last-attempt.json'
    try:
        latest = parent / 'context-latest.json'
        if latest.is_file():
            cached = helpers._json_file(latest)
            directory = Path(cached['snapshot_path']).resolve(strict=True)
            if cached.get('checkpoint_id') == checkpoint['checkpoint_id']:
                # The checkpoint is the durable state key. Later messages/token
                # reports do not authorize another capture of this stopped run.
                if not (directory.is_relative_to(parent.resolve())
                        and cached.get('session_id') == event['session_id']
                        and cached.get('project_id') == checkpoint['project_id']
                        and Path(cached['transcript']['source']).resolve(strict=True) == transcript
                        and helpers._verified(cached)
                        and transcript.stat().st_size >= cached['transcript']['bytes']
                        and helpers._digest(transcript, cached['transcript']['bytes']) == cached['transcript']['sha256']
                        and (directory / 'successor-start.txt').read_text(encoding='utf-8') == start):
                    raise ValueError('Previously saved checkpoint or resume file is no longer verified.')
                return cached
        if attempt_file.is_file():
            previous = helpers._json_file(attempt_file)
            if not isinstance(previous, dict):
                raise ValueError('Capture attempt metadata must be an object.')
            if (previous.get('session_id') == event['session_id']
                    and previous.get('checkpoint_id') == checkpoint['checkpoint_id']):
                raise ValueError('Capture already attempted for this checkpoint; inspect the existing local attempt.')
        attempt = dict(schema_version=1, status='attempted', session_id=event['session_id'],
                       project_id=checkpoint['project_id'], checkpoint_id=checkpoint['checkpoint_id'])
        helpers._atomic_json(attempt_file, attempt)
        directory = parent / ('context-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        directory.mkdir(exist_ok=False)
        attempt['snapshot_path'] = str(directory)
        helpers._atomic_json(attempt_file, attempt)
        manifest = dict(schema_version=1, status='ERROR', session_id=event['session_id'],
                        cwd=str(event['cwd']), trigger='context_usage', native_hook_event=event['hook_event_name'],
                        context_usage=usage, checkpoint_id=checkpoint['checkpoint_id'],
                        project_id=checkpoint['project_id'], snapshot_path=str(directory),
                        model_called=False, network_requested=False, chat_created=False,
                        automatic_chat_creation_supported=False)
        # An interrupted/failed attempt must retain an explicit ERROR record.
        helpers._atomic_json(directory / 'manifest.json', manifest)
        manifest['transcript'] = helpers._copy_prefix(transcript, directory / 'transcript.jsonl',
                                                     [(home / 'sessions').resolve(), (home / 'archived_sessions').resolve()],
                                                     helpers.MAX_TRANSCRIPT_BYTES)
        manifest['working_state'] = helpers._copy_prefix(working, directory / 'working.md', [root], helpers.MAX_WORKING_BYTES)
        if manifest['working_state']['sha256'] != checkpoint['sha256']:
            raise ValueError('Working projection changed during capture.')
        starter = directory / 'successor-start.txt'
        with starter.open('x', encoding='utf-8', newline='\n') as handle:
            handle.write(start)
            handle.flush()
            os.fsync(handle.fileno())
        if starter.read_text(encoding='utf-8') != start:
            raise ValueError('Starter read-back differs.')
        manifest['status'] = 'PASS'
        manifest['completed_at_utc'] = datetime.now(timezone.utc).isoformat()
        if not helpers._verified(manifest):
            raise ValueError('Snapshot read-back verification failed.')
        helpers._atomic_json(directory / 'manifest.json', manifest)
        helpers._atomic_json(latest, manifest)
        attempt['status'] = 'verified'
        helpers._atomic_json(attempt_file, attempt)
        return manifest
    except (OSError, ValueError, TypeError, KeyError):
        if attempt is not None:
            attempt['status'] = 'failed'
            try:
                helpers._atomic_json(attempt_file, attempt)
            except OSError:
                pass  # Keep the initial attempt marker if the disk is unavailable.
        raise
    finally:
        if lock.is_file() and lock.read_text(encoding='ascii') == nonce:
            lock.unlink()


def handle_event(event, *, codex_home=None, handoff_root=None):
    if not isinstance(event, dict):
        return {'systemMessage': 'Kontextwaechter: ungueltige Eingabe; PreCompact-Status separat pruefen.'}
    # Never intercept a new user message with this optional context monitor.
    # A future authorized binding uses PostToolUse only; PreCompact is separate.
    if event.get('hook_event_name') != 'PostToolUse' or event.get('subagent_id') or event.get('agent_id'):
        return {}
    home, helpers = None, None
    try:
        session = event.get('session_id')
        if not isinstance(session, str) or str(uuid.UUID(session)) != session:
            raise ValueError('Canonical main-session identity unavailable.')
        home = Path(codex_home or os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
        cwd = Path(event.get('cwd') or '')
        if (not home.is_absolute() or not cwd.is_absolute()
                or str(home).startswith(('\\\\', '//')) or str(cwd).startswith(('\\\\', '//'))):
            raise ValueError('Absolute local session paths unavailable.')
        home, cwd = home.resolve(strict=True), cwd.resolve(strict=True)
        helpers = _helpers(home)
        if not helpers._local(home) or not helpers._local(cwd):
            raise ValueError('Remote paths are not context snapshot sources.')
        transcript, usage = _usage(event, home, cwd, helpers)
    except (OSError, ValueError, TypeError, KeyError, UnicodeError) as exc:
        if home is not None and helpers is not None:
            _observe(event, home, helpers, 'usage_unavailable',
                     error_code=USAGE_ERRORS.get(str(exc), 'source_unreadable'))
        return {'systemMessage': 'Kontextauslastung nicht verlaesslich lesbar; keine Prozentbehauptung. PreCompact-Status separat pruefen.'}
    if usage['used_tokens'] * 100 < usage['limit_tokens'] * THRESHOLD_PERCENT:
        _observe(event, home, helpers, 'below_threshold', usage)
        return {}
    try:
        if not _announcement_seen(event, transcript):
            return _request_announcement(event, home, helpers, transcript, usage)
    except (OSError, ValueError, TypeError, KeyError):
        return {'systemMessage': 'Chatweiterleitung wartet: sichtbare Vorankündigung nicht gebunden. Kein automatischer Wechsel gestartet.'}
    snapshot_saved = False
    try:
        root = Path(handoff_root or DEFAULT_ROOT).resolve(strict=True)
        manifest = _capture(event, home, root, transcript, usage, helpers)
        snapshot_saved = True
        _observe(event, home, helpers, 'stop_saved', usage)
        launch = getattr(helpers, '_desktop_successor', None)
        desktop = (launch(event, manifest, handoff_root=root, codex_home=home) if callable(launch)
                   else {'status': 'fallback_required', 'successor_thread_id': None})
        reason = (f'Kontextschwelle {THRESHOLD_PERCENT}% erreicht; lokale Sicherung bestaetigt. Keine weitere Facharbeit im Ursprung. '
                  'Dreifeld-Start: ' + str(Path(manifest['snapshot_path']) / 'successor-start.txt')
                  + '.')
        notice = getattr(helpers, '_transition_notice', lambda _: '')(desktop)
        if notice:
            reason += ' ' + notice
        elif desktop.get('successor_thread_id'):
            reason += ' Vorhandener Nachfolger: ' + desktop['successor_thread_id'] + '.'
        elif desktop['status'] in ('creation_pending', 'creation_unknown'):
            reason += ' Erstellung ausstehend oder unklar; Status pruefen und keinen zweiten Nachfolger anlegen.'
        else:
            reason += ' Desktop-Uebernahme nicht bestaetigt; vorhandenen Dreifeld-Start fuer manuelle Fortsetzung nutzen.'
        reason += ' Alten Chat erst nach Uebernahme archivieren.'
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        _observe(event, home, helpers, 'stop_unverified', usage)
        reason = (f'Kontextschwelle {THRESHOLD_PERCENT}% erreicht; lokale Sicherung NICHT bestaetigt. Alter Durchlauf vorsorglich '
                  'gestoppt. Arbeitsstand/Index lokal pruefen, keinen Nachfolger blind duplizieren, alten Chat nicht archivieren.')
    status = desktop.get('status', 'fallback_required') if 'desktop' in locals() else 'fallback_required'
    visible = helpers._transition_message(desktop if 'desktop' in locals() else {}, snapshot_saved)
    instruction = ('Gib JETZT als Schlussantwort ausschliesslich die folgende Uebergabemeldung aus. '
                   'Keine weiteren Werkzeuge, keine Facharbeit und keine neue Planung im Ursprung. '
                   'Behaupte weder erfolgreichen Chatstart noch Archivierung ohne Beleg. '
                   + visible)
    return {'continue': False, 'stopReason': reason, 'systemMessage': visible,
            'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': instruction}}


def main():
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--complete-announcement':
            file = Path(sys.argv[2]).resolve(strict=True)
            if file.name != 'context-observation.json' or file.stat().st_size > MAX_EVENT:
                raise ValueError('Invalid announcement record.')
            record = json.loads(file.read_text(encoding='utf-8'))
            event = record.get('announcement', {})
            home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))).resolve(strict=True)
            if (record.get('decision') != 'announcement_pending'
                    or record.get('guard_sha256') != hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
                    or event.get('session_id') != os.environ.get('CODEX_THREAD_ID')
                    or file != home / 'handoff-snapshots' / event['session_id'] / 'context-observation.json'
                    or Path(event['cwd']).resolve(strict=True) != Path.cwd().resolve(strict=True)):
                raise ValueError('Announcement caller mismatch.')
            raw = json.dumps(event).encode('utf-8')
        elif len(sys.argv) == 1:
            raw = sys.stdin.buffer.read(MAX_EVENT + 1)
        else:
            raise ValueError('Unsupported context guard arguments.')
        if len(raw) > MAX_EVENT:
            raise ValueError('Hook input exceeds limit.')
        result = handle_event(json.loads(raw))
    except (OSError, ValueError, TypeError, KeyError, UnicodeError):
        result = {'systemMessage': 'Kontextwaechter-Eingabe unlesbar; PreCompact-Status separat pruefen.'}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
