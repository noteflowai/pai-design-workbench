"""Process-level lockdown for untrusted CadQuery code (rlimits, PEP 578 audit hook, restricted builtins)."""
import builtins
import math
import os
import resource
import types
from pathlib import Path

from cad_code_policy import SAFE_BUILTINS

BLOCKED_PREFIXES = ("os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty", "os.kill", "os.killpg", "os.putenv", "os.unsetenv",
                    "os.chdir", "os.chmod", "os.chown", "os.link", "os.symlink", "os.truncate", "subprocess.", "socket.", "ctypes.", "_posixsubprocess",
                    "pty.", "winreg.", "sys.addaudithook", "sys.settrace", "sys.setprofile", "webbrowser.", "urllib.", "http.", "ftplib.")
BLOCKED_MODULES = {"ctypes", "_ctypes", "subprocess", "_posixsubprocess", "socket", "_socket", "multiprocessing", "pty", "signal", "mmap", "fcntl", "resource"}
WRITE_EVENTS = {"os.remove", "os.rename", "os.replace", "os.rmdir", "os.mkdir", "shutil.rmtree", "shutil.move", "shutil.copyfile", "shutil.copytree"}


def within_output(path, out):
    try:
        return Path(os.fsdecode(path)).resolve().is_relative_to(out)
    except (TypeError, ValueError, OSError):
        return False


def _audit(out):
    def audit(event, payload):
        if event.startswith(BLOCKED_PREFIXES):
            raise PermissionError(f"sandbox: {event} blocked")
        if event == "import" and payload and str(payload[0]).split(".")[0] in BLOCKED_MODULES:
            raise PermissionError(f"sandbox: import {payload[0]} blocked")
        if event == "open" and len(payload) >= 2:
            path, mode, flags = payload[0], payload[1], payload[2] if len(payload) > 2 else 0
            writing = (isinstance(mode, str) and any(m in mode for m in "wax+")) or (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC))
            if writing and not (isinstance(path, (str, bytes, os.PathLike)) and within_output(path, out)):
                raise PermissionError("sandbox: write outside the output directory blocked")
        if event in WRITE_EVENTS and payload and not within_output(payload[0], out):
            raise PermissionError(f"sandbox: {event} outside the output directory blocked")
    return audit


def _view(cq):
    """User code sees cadquery's public classes and functions only; submodules (utils, occ_impl, …) are not reachable."""
    return types.SimpleNamespace(**{k: getattr(cq, k) for k in dir(cq) if not k.startswith("_") and not isinstance(getattr(cq, k), types.ModuleType)})


def limits(cpu_seconds):
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 5))
    resource.setrlimit(resource.RLIMIT_AS, (3 << 30, 3 << 30))
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 << 20, 64 << 20))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def lockdown(out, cq):
    """Install the audit hook (irreversible for this process) and return the restricted globals for exec."""
    import sys
    view = _view(cq)

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level == 0 and name == "cadquery":
            return view
        if level == 0 and name == "math" and not fromlist:
            return math
        raise ImportError(f"only cadquery and math may be imported (got {name})")

    sys.addaudithook(_audit(Path(out).resolve()))
    safe = {name: getattr(builtins, name) for name in SAFE_BUILTINS if hasattr(builtins, name)}
    safe["__import__"] = guarded_import
    return {"__builtins__": safe, "__name__": "generated"}
