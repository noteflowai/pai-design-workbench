"""Fetch pinned current Blender LTS on Linux; verify the official SHA-256 manifest."""
import hashlib
import json
import os
import platform
from pathlib import Path
import tarfile
import urllib.request

if platform.system() != "Linux" or platform.machine() != "x86_64":
    raise SystemExit("Automatic bootstrap tested on Linux x86_64 only. Configure a native current Blender executable with PAI_BLENDER on other systems.")
version = "5.2.2"
name = f"blender-{version}-linux-x64.tar.xz"
# PAI_TOOLS_DIR / PAI_ENV_FILE let the desktop app install into its own data directory.
root = Path(os.environ.get("PAI_TOOLS_DIR", ".state/tools")).resolve()
root.mkdir(parents=True, exist_ok=True)
base = "https://download.blender.org/release/Blender5.2/"


def fetch(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30)


with fetch(base + f"blender-{version}.sha256") as response:
    manifest = response.read().decode()
expected = next(line.split()[0] for line in manifest.splitlines() if line.split()[-1].lstrip("*") == name)
archive = root / name
if not archive.exists():
    temporary = archive.with_suffix(".partial")
    with fetch(base + name) as response, temporary.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    temporary.rename(archive)
with archive.open("rb") as file:
    actual = hashlib.file_digest(file, "sha256").hexdigest()
if actual != expected:
    raise SystemExit("Blender archive checksum mismatch; not extracting")
folder = root / f"blender-{version}-linux-x64"
if not folder.exists():
    with tarfile.open(archive) as file:
        file.extractall(root, filter="data")
print(json.dumps({"blender": str(folder / "blender"), "version": version}))
receipt = {"version": version, "url": base + name, "manifestUrl": base + f"blender-{version}.sha256", "sha256": actual}
(root / "blender-install-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
env_file = Path(os.environ.get("PAI_ENV_FILE", ".state/demo.env"))
existing = env_file.read_text() if env_file.exists() else ""
lines = [line for line in existing.splitlines() if not line.startswith("PAI_BLENDER=")]
env_file.write_text("\n".join(lines) + f"\nPAI_BLENDER={folder / 'blender'}\n")
env_file.chmod(0o600)
print(f"Verified current Blender LTS {version}: {folder / 'blender'}")
