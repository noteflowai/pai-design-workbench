"""Install the pinned NVIDIA PhysicsNeMo-CFD + DoMINO DrivAerML checkpoint for the advisory aero prescreen.

    python3 tools/setup_prescreen.py      # Linux x86_64 with an NVIDIA GPU, uv on PATH

Pins come from tools/runtime-pins.json (physicsnemoCfd): the repository commit (its uv.lock is installed with
`uv sync --frozen`) and the Hugging Face checkpoint revision with SHA-256 of every file the prescreen reads.
Writes PAI_PRESCREEN_DIR to .state/demo.env. Nothing here is a solver: the native OpenFOAM lane stays the verdict.
"""
import hashlib, json, os, shutil, subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
pin = json.loads((root / "tools/runtime-pins.json").read_text())["physicsnemoCfd"]
tools = Path(os.environ.get("PAI_TOOLS_DIR") or root / ".state/tools").resolve() / "physicsnemo-cfd"
src, venv, ck = tools / "src", tools / "venv", tools / "domino_drivaerml"
if not shutil.which("uv"):
    raise SystemExit("uv is required (https://docs.astral.sh/uv/)")
if not (src / ".git").exists():
    subprocess.run(["git", "clone", "--quiet", pin["repository"], str(src)], check=True)
subprocess.run(["git", "-C", str(src), "fetch", "--quiet", "origin", pin["commit"]], check=True)
subprocess.run(["git", "-C", str(src), "checkout", "--quiet", "--detach", pin["commit"]], check=True)
head = subprocess.run(["git", "-C", str(src), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
if head != pin["commit"]:
    raise SystemExit(f"physicsnemo-cfd at {head}, pinned {pin['commit']}")
subprocess.run(["uv", "sync", "--frozen", "--python", pin["python"], "--extra", "evaluation-hf", "--extra", "gpu"], cwd=src, check=True,
               env={**os.environ, "UV_PROJECT_ENVIRONMENT": str(venv)})
# The sensitivities workflow (reused unchanged) needs tyro on top of the locked package.
subprocess.run(["uv", "pip", "install", "--python", str(venv / "bin/python"), "tyro==1.0.16"], check=True)
c = pin["checkpoint"]
subprocess.run([str(venv / "bin/python"), "-c", "import sys; from huggingface_hub import snapshot_download as d; "
                "d(sys.argv[1], revision=sys.argv[2], local_dir=sys.argv[3], allow_patterns=['domino_drivaerml_surface_checkpoint/*'])",
                c["repository"], c["revision"], str(ck)], check=True)
for rel, want in c["sha256"].items():
    got = hashlib.sha256((ck / rel).read_bytes()).hexdigest()
    if got != want:
        raise SystemExit(f"{rel}: sha256 {got} != pinned {want}")
env = root / ".state/demo.env"
lines = [l for l in (env.read_text().splitlines() if env.exists() else []) if not l.startswith("PAI_PRESCREEN_DIR=")]
env.write_text("\n".join([*lines, f"PAI_PRESCREEN_DIR={tools}"]) + "\n")
print(json.dumps({"physicsnemoCfd": head, "checkpoint": c["revision"], "dir": str(tools)}))
