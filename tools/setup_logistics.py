"""Install the pinned logistics-planning toolchain into .state/tools without touching the system.

- Python 3.12 venv `logistics-1` from the hash-locked native/logistics-requirements.txt: Google OR-Tools 9.15
  (Apache-2.0; routing solver with capacity, pickup-and-delivery and time-window dimensions) and its dependencies.
  Wheels only, every file checked against its SHA-256 (`--require-hashes`).
- Writes PAI_LOGISTICS_PYTHON to .state/demo.env and a receipt with the installed versions.

The independent verifier (native/logistics_verify.py) uses only the Python standard library on purpose: it must
not share code or libraries with the solver it checks.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

if sys.version_info[:2] != (3, 12):
    raise SystemExit("Run with Python 3.12; the lock targets CPython 3.12 manylinux wheels.")
root = Path(__file__).resolve().parents[1]
lock = root / "native/logistics-requirements.txt"
tools = Path(os.environ["PAI_TOOLS_DIR"]).resolve() if os.environ.get("PAI_TOOLS_DIR") else (root / ".state").resolve() / "tools"
venv = tools / "logistics-1"
python = venv / "bin/python"
if not (venv / "bin/pip").exists():
    subprocess.run([sys.executable, "-m", "venv", "--clear", str(venv)], check=True)
subprocess.run([str(python), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-input",
                "--require-hashes", "--no-deps", "--only-binary", ":all:", "-r", str(lock)], check=True)
versions = json.loads(subprocess.check_output([str(python), "-I", "-c",
    "import json, importlib.metadata as m; print(json.dumps({p: m.version(p) for p in ('ortools', 'protobuf', 'numpy')}))"], text=True))
import hashlib
receipt = {"schema": "pai-logistics-install-1", "python": str(python), "versions": versions, "lock": str(lock.relative_to(root)),
           "lockSha256": hashlib.sha256(lock.read_bytes()).hexdigest()}
(tools / "logistics-install-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
env = Path(os.environ["PAI_ENV_FILE"]) if os.environ.get("PAI_ENV_FILE") else root / ".state/demo.env"
lines = [l for l in (env.read_text().splitlines() if env.exists() else []) if not l.startswith("PAI_LOGISTICS_PYTHON=")]
env.parent.mkdir(parents=True, exist_ok=True)
env.write_text("\n".join(lines + [f"PAI_LOGISTICS_PYTHON={python}"]) + "\n")
os.chmod(env, 0o600)
print(json.dumps(receipt))
