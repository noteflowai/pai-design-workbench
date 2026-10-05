"""Install the pinned CAM toolchain: FreeCAD 1.1 (official AppImage, SHA-256 checked) + hash-locked ocp-freecad-cam.

    python3 tools/setup_cam.py        # Linux x86_64

- FreeCAD from the official release asset named in tools/runtime-pins.json (freecad), checked against the pinned
  digest, extracted (no FUSE, no root) into .state/tools/freecad-<version>.
- A venv from FreeCAD's own Python 3.11 with its site packages visible (FreeCAD CAM, OpenCAMLib), plus
  native/cam-requirements.txt (ocp-freecad-cam, CadQuery) installed with --require-hashes.
- Self-check: imports FreeCAD, its CAM workbench, OpenCAMLib and ocp-freecad-cam, and writes PAI_CAM_PYTHON to
  .state/demo.env. FreeCAD (LGPL-2.1+) runs as a separate process; nothing is linked into the workbench.
"""
import hashlib, json, os, shutil, subprocess, sys, tempfile, urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[1]
pin = json.loads((root / "tools/runtime-pins.json").read_text())["freecad"]
tools = Path(os.environ.get("PAI_TOOLS_DIR") or root / ".state/tools").resolve()
home = tools / f"freecad-{pin['version']}"
image, squash, venv = home / "FreeCAD.AppImage", home / "squashfs-root", home / "venv"
home.mkdir(parents=True, exist_ok=True)
if not (squash / "usr/bin/python").exists():
    if not image.exists() or hashlib.sha256(image.read_bytes()).hexdigest() != pin["sha256"]:
        with tempfile.NamedTemporaryFile(dir=home, delete=False) as tmp:
            with urllib.request.urlopen(pin["url"], timeout=600) as r:
                shutil.copyfileobj(r, tmp)
        digest = hashlib.sha256(Path(tmp.name).read_bytes()).hexdigest()
        if digest != pin["sha256"]:
            os.unlink(tmp.name)
            raise SystemExit(f"FreeCAD AppImage sha256 {digest} differs from the pin {pin['sha256']}")
        os.replace(tmp.name, image)
    image.chmod(0o755)
    subprocess.run([str(image), "--appimage-extract"], cwd=home, check=True, stdout=subprocess.DEVNULL)
if not (venv / "bin/python").exists():
    subprocess.run([str(squash / "usr/bin/python"), "-m", "venv", "--system-site-packages", str(venv)], check=True)
    site = next((venv / "lib").glob("python3.*/site-packages"))
    (site / "freecad.pth").write_text(str(squash / "usr/lib") + "\n")
subprocess.run([str(venv / "bin/python"), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-input",
                "--require-hashes", "--no-deps", "--only-binary", ":all:", "-r", str(root / "native/cam-requirements.txt")], check=True)
probe = subprocess.run([str(venv / "bin/python"), "-c",
                        "import json, FreeCAD, opencamlib, ocp_freecad_cam, cadquery; import Path.Op.Adaptive;"
                        "print(json.dumps({'freecad': '.'.join(FreeCAD.Version()[:3]), 'cadquery': cadquery.__version__}))"],
                       capture_output=True, text=True, cwd=tempfile.gettempdir())
if probe.returncode != 0:
    raise SystemExit(f"CAM self-check failed:\n{probe.stderr[-1500:]}")
versions = json.loads(probe.stdout.strip().splitlines()[-1])
if versions["freecad"] != pin["version"]:
    raise SystemExit(f"FreeCAD {versions['freecad']} differs from the pin {pin['version']}")
env = root / ".state/demo.env"
lines = [l for l in (env.read_text().splitlines() if env.exists() else []) if l and not l.startswith("PAI_CAM_PYTHON=")]
env.write_text("\n".join([*lines, f"PAI_CAM_PYTHON={venv / 'bin/python'}"]) + "\n"); env.chmod(0o600)
print(json.dumps({**versions, "appImageSha256": pin["sha256"], "lockSha256": hashlib.sha256((root / "native/cam-requirements.txt").read_bytes()).hexdigest(),
                  "python": str(venv / "bin/python")}))
