"""Isolation probe for scripts/cad-code-e2e.ts. Prints one JSON line of observations.

mode "os":      run inside bubblewrap without the process lockdown; reports what the OS layer allows.
mode "process": additionally install the audit-hook lockdown and report what the process layer blocks.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[4])
mode, out, secret = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
seen = {}


def attempt(name, action):
    try:
        action()
        seen[name] = "allowed"
    except Exception as e:  # noqa: BLE001
        seen[name] = type(e).__name__


if mode == "process":
    import cadquery as cq
    from cad_lockdown import lockdown
    lockdown(out, cq)

attempt("read-secret", lambda: open(secret).read())
attempt("write-outside", lambda: open("/var/tmp-pai-probe" if mode == "process" else str(Path(sys.argv[4]) / "probe.txt"), "w").write("x"))
attempt("write-output", lambda: (out / "ok.txt").write_text("ok"))
attempt("network", lambda: __import__("socket").create_connection(("1.1.1.1", 53), timeout=2))
attempt("subprocess", lambda: __import__("subprocess").run(["/bin/true"], check=True))
attempt("os-system", lambda: (_ for _ in ()).throw(OSError("exit")) if os.system("/bin/true") != 0 else None)
attempt("ctypes", lambda: __import__("ctypes").CDLL(None))
seen["env"] = sorted(k for k in os.environ if k.startswith(("PAI_", "KIRO", "AWS", "CLAUDE", "OPENAI")))
seen["home-visible"] = os.path.exists(os.path.expanduser("~/.config"))
seen["run-entries"] = len(os.listdir("/run")) if os.path.isdir("/run") else 0
print(json.dumps(seen))
