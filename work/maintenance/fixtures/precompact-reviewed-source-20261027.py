"""Local PreCompact snapshots with a bounded existing desktop handoff.

Installed as a standalone script under CODEX_HOME/hooks. Sources are opaque
files: the transcript format is not treated as a stable parsing interface.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from subprocess import run as _desktop_process
import sys
import uuid

MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024
MAX_WORKING_BYTES = 4 * 1024 * 1024
MAX_EVENT_BYTES = 65536
_DESKTOP_ADAPTER = Path(r'C:\TheHive\work\maintenance\handoff-desktop.cjs')
_AUTOMATION_POLICY = _DESKTOP_ADAPTER.with_name('handoff-automation-policy.json')
_NODE_RUNTIME = Path(r'C:\Program Files\nodejs\node.exe')


def _json_file(path):
    if path.stat().st_size > MAX_WORKING_BYTES:
        raise ValueError('Metadata exceeds limit.')
    return json.loads(path.read_text(encoding='utf-8-sig'))


def _digest(path, size=None):
    result = hashlib.sha256()
    with path.open('rb') as handle:
        remaining = path.stat().st_size if size is None else size
        while remaining:
            chunk = handle.read(min(1024 * 1024, remaining))
            if not chunk:
                raise OSError('Snapshot shorter than expected.')
            result.update(chunk)
            remaining -= len(chunk)
    return result.hexdigest()


def _checkpoint(cwd, session):
    """Reuse a per-origin workspace pointer, never arbitrary file names."""
    pointer = cwd / 'work/handoff' / (session + '-status.json')
    state = _json_file(pointer) if pointer.is_file() else {}
    if not isinstance(state, dict):
        raise ValueError('Workspace pointer must be an object.')
    # Existing manual and desktop writers use both journal conventions. Read
    # aliases into a local view; preserve the original journal's source bytes.
    for canonical, alias in (('originThreadId', 'origin_thread_id'),
                             ('successorThreadId', 'successor_thread_id')):
        values = [state[key] for key in (canonical, alias) if key in state]
        if len(values) == 2 and values[0] != values[1]:
            raise ValueError('Conflicting handoff identity aliases.')
        if values:
            value = values[0]
            if value is not None and (not isinstance(value, str) or str(uuid.UUID(value)) != value):
                raise ValueError('Invalid handoff identity.')
            state[canonical] = value
    if state and state.get('originThreadId') != session:
        raise ValueError('Workspace pointer belongs to another session.')
    root = cwd
    # The central store is separate from the actual project workspace. Only
    # operator-owned exact bindings may select it; ordinary note text cannot.
    try:
        policy = _json_file(_AUTOMATION_POLICY)
        if not isinstance(policy, dict) or not isinstance(policy.get('projects', {}), dict):
            raise ValueError('Operator policy and project bindings must be objects.')
        if policy.get('scope') == 'all_local_projects':
            central = policy.get('handoff_root')
            if not isinstance(central, str) or not central:
                raise ValueError('Global checkpoint store is not configured.')
            store = _path(central)
            if not store.is_absolute() or not _local(store):
                raise ValueError('Global checkpoint store must be local and absolute.')
            store = store.resolve(strict=True)
            if (not _local(store) or store.name != 'handoff' or store.parent.name != 'work'):
                raise ValueError('Global checkpoint store has an invalid location.')
            index = _json_file(store / 'index.json')
            if not isinstance(index, dict) or not isinstance(index.get('projects'), dict):
                raise ValueError('Global checkpoint index must contain a project object.')
            entries = list(index['projects'].values())
            if any(not isinstance(entry, dict) for entry in entries):
                raise ValueError('Global checkpoint entries must be objects.')
            matches = [entry for entry in entries if entry.get('session_id') == session]
            if len(matches) > 1:
                raise ValueError('Ambiguous global checkpoint session.')
            if len(matches) == 1:
                return store.parent.parent, state, pointer
        matches = []
        for project, binding in policy.get('projects', {}).items():
            if not isinstance(binding, dict):
                continue
            workspace = _path(binding['workspace'])
            store = _path(binding['handoff_root'])
            if not workspace.is_absolute() or not store.is_absolute() or not _local(workspace) or not _local(store):
                continue
            if workspace.resolve(strict=True) != cwd:
                continue
            store = store.resolve(strict=True)
            if store.name != 'handoff' or store.parent.name != 'work':
                continue
            index = _json_file(store / 'index.json')
            if not isinstance(index, dict) or not isinstance(index.get('projects'), dict):
                raise ValueError('Central checkpoint index must contain a project object.')
            entry = index['projects'].get(project, {})
            if not isinstance(entry, dict):
                raise ValueError('Central checkpoint entry must be an object.')
            if entry.get('session_id') == session:
                matches.append(store.parent.parent)
        if len(matches) > 1:
            raise ValueError('Ambiguous central checkpoint binding.')
        if len(matches) == 1:
            return matches[0], state, pointer
    except (OSError, KeyError, TypeError):
        pass
    value = state.get('repositoryPath')
    if value:
        candidate = _path(value)
        if not candidate.is_absolute() or not _local(candidate):
            raise ValueError('Checkpoint repository must be local and absolute.')
        candidate = candidate.resolve(strict=True)
        if not candidate.is_dir() or candidate == Path(candidate.anchor) or not _local(candidate):
            raise ValueError('Invalid checkpoint repository.')
        root = candidate
    return root, state, pointer


def _verified(manifest):
    if manifest.get('status') != 'PASS':
        return False
    directory = _path(manifest['snapshot_path'])
    for key, name in [('transcript', 'transcript.jsonl'), ('working_state', 'working.md'),
                      ('handoff_report', 'handoff.md'), ('handoff_status', 'status.json')]:
        entry = manifest.get(key)
        if entry is None:
            continue
        if (entry.get('status') != 'COPIED' or entry.get('file') != name
                or (directory / name).stat().st_size != entry['bytes']
                or _digest(directory / name) != entry['sha256']):
            return False
    return all(key in manifest for key in ('transcript', 'working_state'))


def _atomic_json(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf-8', newline='\n') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _desktop_successor(event, manifest, *, handoff_root=None, codex_home=None):
    """Call the existing adapter only for an independently verified snapshot.

    Desktop errors retain PASS and the local manual recovery. The Node adapter
    separately checks the checkpoint and the exact operator-owned project map.
    """
    result = dict(status='fallback_required', successor_thread_id=None)
    directory = None
    try:
        if (event.get('subagent_id') or event.get('agent_id')
                or event.get('hook_event_name') not in ('PreCompact', 'PostToolUse')
                or not _verified(manifest)):
            return result
        session, turn = event['session_id'], event['turn_id']
        if not isinstance(session, str) or not isinstance(turn, str):
            return result
        if str(uuid.UUID(session)) != session or str(uuid.UUID(turn)) != turn:
            return result
        if manifest.get('session_id') != session:
            return result
        home = _path(codex_home or os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))).resolve(strict=True)
        candidate = _path(manifest['snapshot_path']).resolve(strict=True)
        area = (home / 'handoff-snapshots' / session).resolve(strict=True)
        cwd = _path(event['cwd']).resolve(strict=True)
        if not candidate.is_relative_to(area) or _path(manifest['cwd']).resolve(strict=True) != cwd:
            return result
        root = _path(handoff_root or Path(manifest['working_state']['source']).parent).resolve(strict=True)
        payload = dict(session_id=session, turn_id=turn, cwd=str(cwd),
                       handoff_root=str(root), snapshot_path=str(candidate))
        directory = candidate
        completed = _desktop_process([str(_NODE_RUNTIME), str(_DESKTOP_ADAPTER)],
            input=json.dumps(payload), capture_output=True, text=True, encoding='utf-8',
            timeout=7, env={**os.environ, 'CODEX_HOME': str(home)},
            creationflags=0x08000000 if os.name == 'nt' else 0)
        if completed.returncode != 0 or len(completed.stdout) > MAX_EVENT_BYTES:
            raise ValueError('Desktop adapter result unavailable.')
        received = json.loads(completed.stdout)
        if not isinstance(received, dict):
            raise ValueError('Desktop adapter result must be an object.')
        status, successor = received.get('status'), received.get('successor_thread_id')
        if status not in ('successor_created', 'successor_visible', 'creation_pending', 'creation_unknown', 'fallback_required'):
            raise ValueError('Unknown desktop transition.')
        if successor is not None and (not isinstance(successor, str) or str(uuid.UUID(successor)) != successor or successor == session):
            raise ValueError('Invalid desktop successor identity.')
        if status in ('successor_created', 'successor_visible') and successor is None:
            raise ValueError('Missing desktop successor identity.')
        result = dict(status=status, successor_thread_id=successor)
        if received.get('reason_code') in ('new_user_message_after_snapshot', 'snapshot_unverifiable'):
            result['reason_code'] = received['reason_code']
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        pass
    if directory is not None:
        try:
            _atomic_json(directory / 'desktop-transition.json', {
                **result, 'session_id': event['session_id'], 'turn_id': event.get('turn_id'),
                'checked_at_utc': datetime.now(timezone.utc).isoformat(), 'snapshot_status': 'PASS'})
        except (OSError, ValueError, TypeError):
            pass
    return result


def _local(path):
    """Refuse explicit UNC paths; this is not an OS network sandbox."""
    value = str(path)
    if value.startswith('\\\\?\\'):
        return bool(re.match(r'^[A-Za-z]:[\\/]', value[4:]))
    return not value.startswith(('\\\\', '//'))


def _path(value):
    """Normalize only the equivalent Windows drive namespace, never UNC."""
    value = os.fspath(value)
    if (os.name == 'nt' and isinstance(value, str) and value.startswith('\\\\?\\')
            and len(value) >= 7 and value[4].isascii() and value[4].isalpha()
            and value[5:7] in (':\\', ':/')):
        value = value[4:]
    return Path(value)


def _copy_prefix(source, destination, allowed_roots, limit):
    source = _path(source)
    if not source.is_absolute() or not _local(source):
        raise ValueError('Source must be an absolute local path.')
    resolved = source.resolve(strict=True)
    if not _local(resolved) or not any(resolved.is_relative_to(root) for root in allowed_roots):
        raise ValueError('Resolved source is outside its allowed area.')
    if not resolved.is_file():
        raise ValueError('Source is not a regular file.')
    digest = hashlib.sha256()
    with resolved.open('rb') as original:
        size = os.fstat(original.fileno()).st_size
        if size > limit:
            raise ValueError('Source exceeds the byte limit; no truncated backup.')
        with destination.open('xb') as copied:
            remaining = size
            while remaining:
                chunk = original.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise OSError('Source became shorter during backup.')
                copied.write(chunk)
                digest.update(chunk)
                remaining -= len(chunk)
            copied.flush()
            os.fsync(copied.fileno())
        size_after = os.fstat(original.fileno()).st_size
        if size_after < size:
            raise OSError('Source became shorter during backup.')
    return dict(status='COPIED', source=str(resolved), file=destination.name,
                bytes=size, sha256=digest.hexdigest(), source_bytes_after_read=size_after,
                scope='Exact prefix available at file open; later appends are not part of this snapshot.')


def capture_snapshot(event, *, codex_home=None):
    """Return a durable manifest for a main-session PreCompact event."""
    if not isinstance(event, dict):
        return dict(status='ERROR', error='Invalid event object.')
    if (event.get('hook_event_name') != 'PreCompact'
            or event.get('trigger') not in {'auto', 'manual'} or event.get('subagent_id') or event.get('agent_id')):
        return dict(status='SKIPPED')
    directory = None
    try:
        session = event.get('session_id')
        if not isinstance(session, str) or str(uuid.UUID(session)) != session:
            raise ValueError('Canonical session ID required.')
        cwd_value = event.get('cwd')
        if not isinstance(cwd_value, str) or not Path(cwd_value).is_absolute() or not _local(cwd_value):
            raise ValueError('Absolute local working directory required.')
        cwd = _path(cwd_value).resolve(strict=True)
        if not _local(cwd) or not cwd.is_dir():
            raise ValueError('Working directory is not a directory.')
        home = _path(codex_home if codex_home is not None else
                    os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
        if not home.is_absolute() or not _local(home):
            raise ValueError('Absolute local CODEX_HOME required.')
        home = home.resolve(strict=True)
        if not _local(home):
            raise ValueError('Resolved CODEX_HOME must be local.')
        storage = home / 'handoff-snapshots'
        parent = storage / session
        if not parent.resolve().is_relative_to(home):
            raise ValueError('Resolved backup area escapes CODEX_HOME.')
        parent.mkdir(parents=True, exist_ok=True)
        checkpoint_root, checkpoint_status, pointer = _checkpoint(cwd, session)
        note = checkpoint_root / 'work/handoff' / (session + '-working.md')
        if event.get('turn_id') and (parent / 'latest.json').is_file():
            try:
                cached = _json_file(parent / 'latest.json')
                old_dir = Path(cached['snapshot_path']).resolve(strict=True)
                if (old_dir.is_relative_to(parent.resolve()) and cached.get('turn_id') == event['turn_id']
                        and cached.get('trigger') == event['trigger'] and _verified(cached)
                        and str(note.resolve(strict=True)) == cached['working_state']['source']
                        and _digest(note) == cached['working_state']['sha256']
                        and str(_path(event['transcript_path']).resolve(strict=True)) == cached['transcript']['source']
                        and _digest(_path(event['transcript_path']), cached['transcript']['bytes']) == cached['transcript']['sha256']
                        and checkpoint_status.get('successorThreadId') == cached.get('successor_thread_id')):
                    optional = [('handoff_report', checkpoint_root / 'work/handoff' / (session + '-handoff.md')),
                                ('handoff_status', pointer)]
                    if all((not source.is_file() and key not in cached) or
                           (source.is_file() and key in cached and _digest(source) == cached[key]['sha256'])
                           for key, source in optional):
                        return cached
            except (OSError, ValueError, KeyError, TypeError):
                pass
        name = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + uuid.uuid4().hex[:8]
        directory = parent / name
        directory.mkdir(exist_ok=False)
        manifest = dict(schema_version=1, session_id=session, cwd=str(cwd), trigger=event['trigger'],
                        turn_id=event.get('turn_id'),
                        started_at_utc=datetime.now(timezone.utc).isoformat(),
                        status='ERROR', snapshot_path=str(directory),
                        model_called=False, network_requested=False, chat_created=False,
                        automatic_chat_creation_supported=False,
                        successor_thread_id=checkpoint_status.get('successorThreadId'))
        transcript_value = event.get('transcript_path')
        try:
            if not isinstance(transcript_value, str) or not transcript_value:
                raise ValueError('Host did not provide a local transcript path.')
            allowed = [(home / part).resolve() for part in ('sessions', 'archived_sessions')]
            # A redirected sessions directory must not escape CODEX_HOME.
            if any(not path.is_relative_to(home) for path in allowed):
                raise ValueError('History directory escapes CODEX_HOME.')
            manifest['transcript'] = _copy_prefix(Path(transcript_value), directory / 'transcript.jsonl',
                                                   allowed, MAX_TRANSCRIPT_BYTES)
        except (OSError, ValueError) as exc:
            manifest['transcript'] = dict(status='ERROR', error=str(exc))
        try:
            manifest['working_state'] = _copy_prefix(note, directory / 'working.md', [checkpoint_root], MAX_WORKING_BYTES)
        except FileNotFoundError:
            manifest['working_state'] = dict(status='MISSING', source=str(note))
        except (OSError, ValueError) as exc:
            manifest['working_state'] = dict(status='ERROR', error=str(exc))
        manifest['status'] = ('ERROR' if manifest['transcript']['status'] != 'COPIED' else
                              'PASS' if manifest['working_state']['status'] == 'COPIED' else 'PARTIAL')
        for key, source, name, allowed in [
            ('handoff_report', checkpoint_root / 'work/handoff' / (session + '-handoff.md'), 'handoff.md', checkpoint_root),
            ('handoff_status', pointer, 'status.json', cwd),
        ]:
            if source.is_file():
                manifest[key] = _copy_prefix(source, directory / name, [allowed], MAX_WORKING_BYTES)
        resume = ('VOR Komprimierung lokal gesichert. Keine weitere Modellarbeit im alten Durchlauf.\n'
                  'Vorhandenen Nachfolger aus status.json wiederverwenden; keinen zweiten Chat anlegen.\n'
                  'Ohne Nachfolger: genau einen lokalen Chat manuell anlegen. Sein Startauftrag '
                  'enthaelt ausschliesslich Projekt-ID, absoluten Pfad zur aktuellen lokalen '
                  'Handoff-Datei und den naechsten offenen Arbeitsschritt.\n'
                  'Keine Berichte, Chatverlaeufe oder Zusammenfassungen einfuegen. Vollstaendige '
                  'Sicherung lokal belassen; Details ueber TheHive-Index und gezielte Datei-/OSB-Abfragen '
                  'bedarfsgerecht laden, Werkzeugausgaben klein halten.\n'
                  'Erst nach erfolgreicher Uebernahme alten Chat archivieren. Keine neuen Tests/Modelle nur fuer Uebergabe.\n')
        with (directory / 'resume.md').open('x', encoding='utf-8') as handle:
            handle.write(resume)
            handle.flush()
            os.fsync(handle.fileno())
        manifest['completed_at_utc'] = datetime.now(timezone.utc).isoformat()
        with (directory / 'manifest.json').open('x', encoding='utf-8', newline='\n') as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        if manifest['status'] == 'PASS':
            try:
                confirmed = _verified(manifest)
            except (OSError, ValueError, KeyError, TypeError):
                confirmed = False
            if not confirmed:
                manifest['status'] = 'ERROR'
                manifest['error'] = 'Read-back verification failed.'
                _atomic_json(directory / 'manifest.json', manifest)
                return manifest
            _atomic_json(parent / 'latest.json', manifest)
        return manifest
    except (OSError, ValueError, TypeError) as exc:
        return dict(status='ERROR', error=str(exc), snapshot_path=str(directory) if directory else None)


def _transition_notice(desktop):
    return {
        'new_user_message_after_snapshot': 'Neuere Benutzernachricht nach der Sicherung erkannt; automatische Erstellung, Oeffnung und Archivierung gesperrt. Nachricht und lokalen Arbeitsstand fuer manuelle Fortsetzung erhalten.',
        'snapshot_unverifiable': 'Nachrichtenstand seit Sicherung nicht verlaesslich pruefbar; automatische Erstellung, Oeffnung und Archivierung gesperrt. Lokalen manuellen Rueckweg nutzen.',
    }.get(desktop.get('reason_code'), '')


def handle_event(event, *, codex_home=None):
    result = capture_snapshot(event, codex_home=codex_home)
    if result['status'] == 'SKIPPED':
        return {}
    reason = ('Lokale Sicherung bestaetigt. ' if result['status'] == 'PASS' else 'Lokale Sicherung NICHT bestaetigt. ')
    reason += ('Komprimierung und weitere Modellarbeit vor Komprimierung gestoppt. '
               'Uebergabe/Resume-Dateien: ' + str(result.get('snapshot_path') or 'kein Sicherungsordner') + '.')
    if result['status'] == 'PASS':
        desktop = _desktop_successor(event, result, codex_home=codex_home)
        notice = _transition_notice(desktop)
        if notice:
            reason += ' ' + notice
        elif desktop.get('successor_thread_id'):
            reason += ' Vorhandener Nachfolger: ' + desktop['successor_thread_id'] + '.'
        elif desktop['status'] in ('creation_pending', 'creation_unknown'):
            reason += ' Chat-Erstellung ausstehend oder unklar; gespeicherten Status pruefen, keinen zweiten Nachfolger anlegen.'
        else:
            reason += ' Desktop-Uebernahme nicht bestaetigt; vorhandenen Dreifeld-Start fuer sichere manuelle Fortsetzung nutzen.'
    reason += ' Alten Chat erst nach erfolgreicher Uebernahme archivieren.'
    return {'continue': False, 'stopReason': reason, 'systemMessage': reason}


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_EVENT_BYTES + 1)
        if len(raw) > MAX_EVENT_BYTES:
            raise ValueError('Oversized hook event.')
        output = handle_event(json.loads(raw.decode('utf-8')))
    except (OSError, ValueError, TypeError, UnicodeError):
        output = {'continue': False, 'stopReason': 'Sicherung NICHT bestaetigt; Komprimierung vorsorglich gestoppt.',
                  'systemMessage': 'PreCompact-Daten ungueltig. Keinen Nachfolger doppelt anlegen und alten Chat nicht archivieren.'}
    print(json.dumps(output, ensure_ascii=True))


if __name__ == '__main__':
    main()
