"""Install pinned CadQuery 2.8.0 (OCCT 7.9) into .state/tools from a hash-locked requirement file.

Every wheel is verified against native/cadquery-requirements.txt (pip --require-hashes).
Writes PAI_CADQUERY_PYTHON to .state/demo.env; never touches other workspaces.
"""
import hashlib
import json
import platform
import subprocess
import sys
from pathlib import Path

if platform.system() != "Linux" or platform.machine() != "x86_64":
    raise SystemExit("Automatic CadQuery setup is tested on Linux x86_64; set PAI_CADQUERY_PYTHON to a pinned CadQuery interpreter elsewhere.")
if sys.version_info[:2] != (3, 12):
    raise SystemExit("Run with Python 3.12; the lock file targets CPython 3.12 manylinux_2_31 wheels.")
root = Path(__file__).resolve().parents[1]
lock = root / "native/cadquery-requirements.txt"
# Resolve .state so a release directory symlinked to persistent state records a stable interpreter path.
target = (root / ".state").resolve() / "tools/cadquery-2.8.0"
python = target / "bin/python"
if not (target / "bin/pip").exists():
    try:
        subprocess.run([sys.executable, "-m", "venv", "--clear", str(target)], check=True)
    except subprocess.CalledProcessError as error:
        raise SystemExit("python3 -m venv failed; install the python3.12-venv package and retry") from error
subprocess.run([str(python), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-input",
                "--require-hashes", "--no-deps", "--only-binary", ":all:", "-r", str(lock)], check=True)
probe = subprocess.run([str(python), "-W", "ignore", "-c",
    "import cadquery as cq, importlib.metadata as m, json; b = cq.Workplane().box(10, 10, 2).faces('>Z').workplane().hole(3).val();"
    "print(json.dumps({'cadquery': cq.__version__, 'ocp': m.version('cadquery-ocp'), 'valid': b.isValid(), 'volume': round(b.Volume(), 3)}))"],
    check=True, capture_output=True, text=True)
result = json.loads(probe.stdout)
if result["cadquery"] != "2.8.0" or not result["valid"]:
    raise SystemExit(f"CadQuery self-check failed: {result}")
receipt = {**result, "lockSha256": hashlib.sha256(lock.read_bytes()).hexdigest(), "python": platform.python_version(), "interpreter": str(python)}
((root / ".state").resolve() / "tools/cadquery-install-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
env_file = root / ".state/demo.env"
existing = env_file.read_text() if env_file.exists() else ""
lines = [line for line in existing.splitlines() if line and not line.startswith("PAI_CADQUERY_PYTHON=")]
env_file.write_text("\n".join(lines) + f"\nPAI_CADQUERY_PYTHON={python}\n")
env_file.chmod(0o600)
print(json.dumps(receipt))
