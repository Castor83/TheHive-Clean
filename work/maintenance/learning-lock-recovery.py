"""Explicit, local learning-lock recovery; never starts Dream or changes Brain."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import uuid


def module(name, file):
    """Import and return the named sibling helper without calling its CLI entry point."""
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def processes():
    # Same native CIM source as native-index-watch.ps1. Command lines are used
    # only for classification inside PowerShell and never returned or saved.
    """Return a bounded Windows CIM process snapshot for recovery checks.

    Classify potential Dream/archive workers and unknown Bun runtimes inside
    PowerShell; return only PID, parent PID and classification flags. Unsupported
    platforms or incomplete subprocess results raise ValueError.
    """
    if os.name != 'nt':
        raise ValueError('Complete descendant inspection is currently Windows-only')
    script = r"""
$ErrorActionPreference='Stop'
@(Get-CimInstance Win32_Process | ForEach-Object {
  $name=$_.Name.ToLowerInvariant()
  $unknown=($name -eq 'bun.exe' -and [string]::IsNullOrWhiteSpace($_.CommandLine))
  $potential=($name -in @('tar.exe','zstd.exe')) -or ($name -eq 'bun.exe' -and $_.CommandLine -match 'dream')
  [pscustomobject]@{pid=[long]$_.ProcessId;ppid=[long]$_.ParentProcessId;potential=[bool]$potential;unknown=[bool]$unknown}
}) | ConvertTo-Json -Compress
"""
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode or len(result.stdout) > 8 * 1024 * 1024:
        raise ValueError('Process tree inspection unavailable')
    rows = json.loads(result.stdout)
    if not isinstance(rows, list) or not rows or len(rows) > 65536:
        raise ValueError('Incomplete process tree snapshot')
    return rows


def quiescent(owner, rows):
    """Return whether validated process rows rule out a live/uncertain lock owner.

    Reject duplicate/malformed rows, a present owner, direct children and any
    potential archive/Dream worker or unclassified Bun process, even if orphaned.
    """
    ids = set()
    for row in rows:
        if (not isinstance(row, dict) or type(row.get('pid')) is not int
                or type(row.get('ppid')) is not int or row['pid'] < 0 or row['ppid'] < 0
                or type(row.get('potential')) is not bool or type(row.get('unknown')) is not bool
                or row['pid'] in ids):
            return False
        ids.add(row['pid'])
    if owner in ids:
        return False
    if any(row['ppid'] == owner for row in rows):
        return False  # Even a non-Dream child makes ownership uncertain.
    # A lost intermediate parent breaks ancestry. Conservatively retain if any
    # Dream runtime or archive worker could still be an orphaned descendant.
    return not any(row['potential'] or row['unknown'] for row in rows)


def write_new(file, data):
    """Exclusively create file from bytes and flush its content to disk.

    Existing files and write/fsync failures propagate to the caller.
    """
    with file.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def recover(root):
    """Recover a learning run lock only with dead-owner and quiet-tree evidence.

    Serialize recovery, reject linked state and recheck unchanged ownership.
    Archive the lock and existing status, write receipts and a force barrier before
    freeing the lock path. Return a status record; inspection/write failures may
    raise. This procedure never starts Dream or modifies Brain content.
    """
    gate = root / 'run.lock'
    mutex = root / '.run-lock-recovery'
    marker = root / 'lock-recovery.json'
    for file in (gate, mutex, marker, root / 'status.json'):
        if file.is_symlink():
            raise ValueError('Recovery refuses linked state')
    kernel = module('learning_kernel_lock', 'sync-text-graph.py')
    liveness = module('learning_owner_liveness', 'handoff-gate-recovery.py')
    with kernel.lock(mutex) as held:
        if not held:
            return {'status': 'locked', 'reason': 'recovery_busy'}
        if not gate.exists():
            return {'status': 'not_locked'}
        if gate.stat().st_size > 4096:
            return {'status': 'locked', 'reason': 'unknown_owner'}
        before = gate.read_bytes()
        try:
            owner = json.loads(before)
            if (not isinstance(owner, dict) or not isinstance(owner.get('started_at'), str)
                    or owner.get('host', socket.gethostname()) != socket.gethostname()
                    or not liveness.dead(owner.get('pid'))):
                return {'status': 'locked', 'reason': 'live_or_unknown_owner'}
        except (ValueError, UnicodeError):
            return {'status': 'locked', 'reason': 'unknown_owner'}
        if not quiescent(owner['pid'], processes()):
            return {'status': 'locked', 'reason': 'live_or_uncertain_process_tree'}
        if gate.read_bytes() != before:
            return {'status': 'locked', 'reason': 'owner_changed'}
        archive = root / ('run.lock.stale-' + uuid.uuid4().hex)
        status = root / 'status.json'
        archived_status = None
        if status.exists():
            if status.stat().st_size > 1024 * 1024:
                return {'status': 'locked', 'reason': 'status_too_large'}
            archived_status = Path(str(archive) + '.status.json')
            write_new(archived_status, status.read_bytes())
        record = {'status': 'recovered', 'archived_lock': str(archive),
                  'archived_status': str(archived_status) if archived_status else None,
                  'requires_force': True, 'dream_started': False}
        receipt = Path(str(archive) + '.recovery.json')
        write_new(receipt, (json.dumps(record) + '\n').encode())
        # Block automatic retries before exposing the free lock path. If rename
        # fails, retain the original lock and this conservative force barrier.
        pending = root / ('lock-recovery.' + uuid.uuid4().hex + '.pending')
        write_new(pending, (json.dumps({**record, 'receipt': str(receipt)}) + '\n').encode())
        os.replace(pending, marker)
        gate.rename(archive)
        return record


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('One explicit learning state directory required')
        print(json.dumps(recover(Path(sys.argv[1]).resolve(strict=True))))
    except Exception:
        # No process details, command lines or private state in error output.
        print(json.dumps({'status': 'locked', 'reason': 'inspection_or_recovery_failed'}))
        sys.exit(1)
