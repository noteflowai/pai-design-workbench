"""Install the pinned Strands Robots simulation toolchain into .state/tools without touching the system.

- strands-robots 0.5.3 with its MuJoCo extra (Apache-2.0) into its own venv `robots-1`, from the hash-locked
  native/robots-requirements.txt (wheels only).
- MuJoCo Menagerie cloned once at the commit pinned in tools/runtime-pins.json into `robots-assets`; at run time the
  cross-check reads it offline and refuses any other commit.
- Writes PAI_ROBOTS_PYTHON and PAI_ROBOTS_ASSETS to .state/demo.env and a receipt. Simulation only: hardware mode,
  the Zenoh mesh and remote code are never enabled by the workbench.
"""
from pathlib import Path
import hashlib, json, os, platform, re, subprocess, sys

root = Path(__file__).resolve().parents[1]
pin = json.loads((root / "tools/runtime-pins.json").read_text())["strandsRobots"]
lock = root / pin["lock"]
tools = Path(os.environ["PAI_TOOLS_DIR"]).resolve() if os.environ.get("PAI_TOOLS_DIR") else (root / ".state").resolve() / "tools"
venv, assets = tools / "robots-1", tools / "robots-assets"
if sys.version_info[:2] < (3, 12):
    raise SystemExit("strands-robots needs Python 3.12 or newer; run with python3.12")
if not (venv / "bin/pip").exists():
    subprocess.run([sys.executable, "-m", "venv", "--clear", str(venv)], check=True)
python = venv / "bin/python"
subprocess.run([str(python), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-input",
                "--require-hashes", "--no-deps", "--only-binary", ":all:", "-r", str(lock)], check=True)

repo, commit = pin["menagerie"]["repository"], pin["menagerie"]["commit"]
if not re.fullmatch(r"[0-9a-f]{40}", commit):
    raise SystemExit("The Menagerie pin must be a full commit id")
menagerie = assets / "mujoco_menagerie"
norm = lambda url: url.removesuffix(".git").replace("github.com/deepmind/", "github.com/google-deepmind/")
git = lambda *a: subprocess.run(["git", "-C", str(menagerie), *a], check=True, capture_output=True, text=True).stdout.strip()
if not (menagerie / ".git").exists():
    menagerie.mkdir(parents=True, exist_ok=True)
    git("init", "-q"); git("remote", "add", "origin", repo)
elif norm(git("remote", "get-url", "origin")) != norm(repo):
    raise SystemExit("The existing Menagerie cache points to another repository; remove it and rerun")
head = subprocess.run(["git", "-C", str(menagerie), "rev-parse", "-q", "--verify", "HEAD"], capture_output=True, text=True).stdout.strip()
if head != commit:
    git("fetch", "-q", "--depth", "1", "origin", commit)
    git("checkout", "-q", "--detach", commit)
if git("rev-parse", "HEAD") != commit or git("status", "--porcelain"):
    raise SystemExit(f"MuJoCo Menagerie is not clean at the pinned commit {commit}")

# robot_descriptions checks out its own pinned Menagerie commit on import; ours must be the same one.
probe = subprocess.run([str(python), "-c", "import json, mujoco, strands_robots; from strands_robots.registry.robots import get_robot;"
                        "from robot_descriptions._repositories import REPOSITORIES as R;"
                        "print(json.dumps({'strandsRobots': strands_robots.__version__, 'mujoco': mujoco.__version__, 'ur5e': bool(get_robot('ur5e')),"
                        "'descriptionsCommit': R['mujoco_menagerie'].commit}))"],
                       capture_output=True, text=True, timeout=120, env={**os.environ, "ROBOT_DESCRIPTIONS_CACHE": str(assets), "MUJOCO_GL": "disable"})
if probe.returncode:
    print(probe.stderr[-1500:], file=sys.stderr)
    raise SystemExit("Strands Robots self-check failed")
versions = json.loads(probe.stdout.strip().splitlines()[-1])
if versions["strandsRobots"] != pin["version"]:
    raise SystemExit(f"strands-robots {versions['strandsRobots']} differs from the pin {pin['version']}")
if versions.pop("descriptionsCommit") != commit:
    raise SystemExit("robot_descriptions pins a different Menagerie commit than tools/runtime-pins.json")
receipt = {"schema": "pai-robots-install-1", **versions, "menagerieCommit": commit, "python": platform.python_version(), "interpreter": str(python),
           "assets": str(assets), "lock": pin["lock"], "lockSha256": hashlib.sha256(lock.read_bytes()).hexdigest()}
(tools / "robots-install-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
env = Path(os.environ["PAI_ENV_FILE"]) if os.environ.get("PAI_ENV_FILE") else root / ".state/demo.env"
lines = [l for l in (env.read_text().splitlines() if env.exists() else []) if l and not l.startswith(("PAI_ROBOTS_PYTHON=", "PAI_ROBOTS_ASSETS="))]
env.parent.mkdir(parents=True, exist_ok=True)
env.touch(mode=0o600, exist_ok=True); env.chmod(0o600)
env.write_text("\n".join([*lines, f"PAI_ROBOTS_PYTHON={python}", f"PAI_ROBOTS_ASSETS={assets}"]) + "\n")
print(json.dumps(receipt))
