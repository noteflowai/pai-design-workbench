"""Install the pinned physics toolchain into .state/tools without touching the system.

- Python 3.12 venv `physics-1` from the hash-locked native/physics-requirements.txt:
  Gmsh 4.15 (meshing), Optuna 5 (multi-objective search), scikit-learn (ranking surrogate), MuJoCo 3.14.
- CalculiX ccx 2.21 (structural FEA) from the Ubuntu 24.04 archive. `apt-get download` checks every package
  against the archive's signed indices; the .deb files are unpacked into .state/tools/calculix-2.21 with their
  shared libraries, so no root and no system package changes are needed.

- Optional (`--with-botorch` or PAI_PHYSICS_BOTORCH=1): BoTorch 0.18 / GPyTorch / CPU PyTorch from the hash-locked
  native/bo-requirements.txt (PyTorch from its official CPU index), for the qLogNEHVI optimisation strategy.

- Optional (`--with-newton` or PAI_PHYSICS_NEWTON=1): Newton 1.6 (Linux Foundation; NVIDIA Warp, MuJoCo-Warp,
  OpenUSD) in its own venv `newton-1` from the hash-locked native/newton-requirements.txt. It checks that the exported
  OpenUSD robot cell imports as one articulation and matches the MJCF kinematics (native/usd_newton_check.py).
  Runs on the CPU; a separate venv because Newton pins its own MuJoCo.

Writes PAI_PHYSICS_PYTHON and PAI_CCX (and PAI_NEWTON_PYTHON) to .state/demo.env and a receipt with every digest.
"""
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

if platform.system() != "Linux" or platform.machine() != "x86_64":
    raise SystemExit("Automatic physics setup is tested on Linux x86_64 (Ubuntu 24.04); set PAI_PHYSICS_PYTHON and PAI_CCX elsewhere.")
if sys.version_info[:2] != (3, 12):
    raise SystemExit("Run with Python 3.12; the lock targets CPython 3.12 manylinux wheels.")
root = Path(__file__).resolve().parents[1]
lock = root / "native/physics-requirements.txt"
tools = Path(os.environ["PAI_TOOLS_DIR"]).resolve() if os.environ.get("PAI_TOOLS_DIR") else (root / ".state").resolve() / "tools"
venv, ccx_root = tools / "physics-1", tools / "calculix-2.21"
python = venv / "bin/python"
if not (venv / "bin/pip").exists():
    subprocess.run([sys.executable, "-m", "venv", "--clear", str(venv)], check=True)
subprocess.run([str(python), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-input",
                "--require-hashes", "--no-deps", "--only-binary", ":all:", "-r", str(lock)], check=True)
with_bo = "--with-botorch" in sys.argv or os.environ.get("PAI_PHYSICS_BOTORCH") == "1"
bo_lock = root / "native/bo-requirements.txt"
if with_bo:
    subprocess.run([str(python), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-input",
                    "--require-hashes", "--no-deps", "--only-binary", ":all:", "-r", str(bo_lock)], check=True)

with_newton = "--with-newton" in sys.argv or os.environ.get("PAI_PHYSICS_NEWTON") == "1"
newton_lock, newton_venv = root / "native/newton-requirements.txt", tools / "newton-1"
if with_newton:
    if not (newton_venv / "bin/pip").exists():
        subprocess.run([sys.executable, "-m", "venv", "--clear", str(newton_venv)], check=True)
    subprocess.run([str(newton_venv / "bin/python"), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-input",
                    "--require-hashes", "--no-deps", "--only-binary", ":all:", "-r", str(newton_lock)], check=True)

# Shared libraries the Gmsh wheel links against (headless use still loads them); not bundled in the wheel.
SYSTEM_LIBS = ["libglu1-mesa", "libgl1", "libopengl0", "libxcursor1", "libxft2", "libxinerama1", "libfontconfig1", "libgomp1",
               "libopenmpi3t64"]  # ccx 2.21 in Ubuntu links OpenMPI through ARPACK/SPOOLES
DEBS = ["calculix-ccx", "libarpack2t64", "libspooles2.2t64", "libgfortran5", "libblas3", "liblapack3"]
debs = {}
if not (ccx_root / "usr/bin/ccx").exists():
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["apt-get", "download", *DEBS], cwd=tmp, check=True, capture_output=True)
        staging = Path(tmp) / "root"
        for deb in sorted(Path(tmp).glob("*.deb")):
            debs[deb.name] = hashlib.sha256(deb.read_bytes()).hexdigest()
            subprocess.run(["dpkg-deb", "-x", str(deb), str(staging)], check=True)
        if ccx_root.exists():
            shutil.rmtree(ccx_root)
        shutil.move(str(staging), ccx_root)
real = next((p for p in sorted((ccx_root / "usr/bin").glob("ccx*")) if p.is_file() and not p.is_symlink()), None)
if not real:
    raise SystemExit("CalculiX binary missing after unpacking")
libdirs = sorted({str(p.parent) for p in ccx_root.rglob("*.so*")})
wrapper = ccx_root / "ccx"
wrapper.write_text("#!/bin/sh\n# Pinned CalculiX from the Ubuntu archive, run with its own unpacked libraries.\n"
                   f"LD_LIBRARY_PATH='{':'.join(libdirs)}'${{LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}} exec '{real}' \"$@\"\n")
wrapper.chmod(0o755)

probe = subprocess.run([str(python), "-c", "import gmsh, optuna, sklearn, mujoco, numpy, scipy, json;"
    "print(json.dumps({'gmsh': gmsh.__version__, 'optuna': optuna.__version__, 'sklearn': sklearn.__version__, 'mujoco': mujoco.__version__, 'numpy': numpy.__version__}))"],
    capture_output=True, text=True)
if probe.returncode != 0:
    raise SystemExit("Physics import self-check failed. Gmsh needs the OpenGL/X11 runtime libraries "
                     f"({' '.join(SYSTEM_LIBS)}); install them with apt-get.\n{probe.stderr[-1500:]}")
versions = json.loads(probe.stdout)
if with_bo:
    bo = subprocess.run([str(python), "-c", "import json, torch, botorch, gpytorch; print(json.dumps({'torch': torch.__version__, 'botorch': botorch.__version__, 'gpytorch': gpytorch.__version__}))"],
                        capture_output=True, text=True)
    if bo.returncode != 0:
        raise SystemExit(f"BoTorch self-check failed:\n{bo.stderr[-1500:]}")
    versions.update(json.loads(bo.stdout))
if with_newton:
    nt = subprocess.run([str(newton_venv / "bin/python"), "-c", "import json, newton, warp, mujoco, pxr; from pxr import Usd;"
                         "print(json.dumps({'newton': newton.__version__, 'warp': warp.__version__, 'newtonMujoco': mujoco.__version__, 'newtonUsd': '.'.join(map(str, Usd.GetVersion()))}))"],
                        capture_output=True, text=True, cwd=tempfile.gettempdir())
    if nt.returncode != 0:
        raise SystemExit(f"Newton self-check failed:\n{nt.stderr[-1500:]}")
    versions.update(json.loads(nt.stdout.strip().splitlines()[-1]))
# ccx prints its version banner when run without an input deck.
banner = subprocess.run([str(wrapper), "-v"], capture_output=True, text=True, timeout=30)
ccx_version = next((line.strip() for line in (banner.stdout + banner.stderr).splitlines() if "Version" in line), "")
if "2.21" not in ccx_version:
    raise SystemExit(f"CalculiX self-check failed: {ccx_version!r}; install the runtime libraries ({' '.join(SYSTEM_LIBS)}).\n{banner.stderr[-1500:]}")
receipt = {**versions, "ccx": ccx_version, "ccxBinary": str(wrapper), "debs": debs or "previously unpacked",
           "lockSha256": hashlib.sha256(lock.read_bytes()).hexdigest(),
           **({"botorchLockSha256": hashlib.sha256(bo_lock.read_bytes()).hexdigest()} if with_bo else {}),
           **({"newtonLockSha256": hashlib.sha256(newton_lock.read_bytes()).hexdigest(), "newtonInterpreter": str(newton_venv / "bin/python")} if with_newton else {}), "python": platform.python_version(), "interpreter": str(python)}
(tools / "physics-install-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
env_file = Path(os.environ["PAI_ENV_FILE"]) if os.environ.get("PAI_ENV_FILE") else root / ".state/demo.env"
existing = env_file.read_text() if env_file.exists() else ""
lines = [x for x in existing.splitlines() if x and not x.startswith(("PAI_PHYSICS_PYTHON=", "PAI_CCX=", *(("PAI_NEWTON_PYTHON=",) if with_newton else ())))]
env_file.write_text("\n".join(lines) + f"\nPAI_PHYSICS_PYTHON={python}\nPAI_CCX={wrapper}\n" + (f"PAI_NEWTON_PYTHON={newton_venv / 'bin/python'}\n" if with_newton else ""))
env_file.chmod(0o600)
print(json.dumps(receipt))
