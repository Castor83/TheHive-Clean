"""Recover only a proven dead local gate, under the existing kernel-lock helper.

The recovery mutex file stays in place: the OS releases its lock on process
exit, so an interrupted recovery cannot leave another presence-based gate.
No models, network, services, or checkpoint changes.
"""
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import uuid


def dead(pid):
    if type(pid) is not int or not 0 < pid <= 0xFFFFFFFF:
        return False
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE only
        if not handle:
            return ctypes.get_last_error() == 87  # ERROR_INVALID_PARAMETER: no such PID
        try:
            return kernel.WaitForSingleObject(handle, 0) == 0  # signalled: exited
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except (PermissionError, OSError):
        pass
    return False


def recover(root):
    gate = root / '.lock-gate'
    mutex = root / '.lock-gate-recovery'
    if mutex.is_symlink() or gate.is_symlink():
        raise ValueError('Gate recovery refuses symlinks')
    # Reuse the existing Windows msvcrt / POSIX flock implementation. Importing
    # this module does not start graph maintenance or load Graphify.
    spec = importlib.util.spec_from_file_location('handoff_kernel_lock', Path(__file__).with_name('sync-text-graph.py'))
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    with helper.lock(mutex) as acquired:
        if not acquired:
            return 'busy'
        try:
            if not gate.exists():
                return 'absent'
            if gate.is_symlink() or not gate.is_file() or gate.stat().st_size > 4096:
                return 'retained'
            before = gate.read_bytes()
        except FileNotFoundError:
            return 'absent'  # A newer normal owner may have just released it.
        try:
            owner = json.loads(before)
        except (ValueError, UnicodeError):
            return 'retained'
        if (not isinstance(owner, dict) or owner.get('host') != socket.gethostname()
                or not isinstance(owner.get('token'), str) or not owner['token']
                or not dead(owner.get('pid'))):
            return 'retained'
        try:
            if gate.read_bytes() != before:
                return 'retained'
        except FileNotFoundError:
            return 'absent'
        gate.rename(root / ('.lock-gate.stale-' + uuid.uuid4().hex))
        return 'recovered'


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Exactly one local handoff root required')
        print(json.dumps({'status': recover(Path(sys.argv[1]).resolve(strict=True))}))
    except Exception as error:
        print(json.dumps({'status': 'error', 'reason': str(error)}))
        sys.exit(1)
