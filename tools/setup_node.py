"""Install the verified Node LTS distribution into the deployment's private tools."""
import hashlib
from pathlib import Path
import tarfile
import urllib.request

version = "24.21.0"
name = f"node-v{version}-linux-x64.tar.xz"
base = f"https://nodejs.org/dist/v{version}/"
root = Path(".state/tools").resolve()
root.mkdir(parents=True, exist_ok=True)
manifest = urllib.request.urlopen(base + "SHASUMS256.txt", timeout=30).read().decode()
expected = next(line.split()[0] for line in manifest.splitlines() if line.split()[-1] == name)
archive = root / name
if not archive.exists():
    temporary = archive.with_suffix(".partial")
    with urllib.request.urlopen(base + name, timeout=30) as response, temporary.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    temporary.rename(archive)
with archive.open("rb") as file:
    if hashlib.file_digest(file, "sha256").hexdigest() != expected:
        raise SystemExit("Node checksum mismatch")
folder = root / f"node-v{version}-linux-x64"
if not folder.exists():
    with tarfile.open(archive) as file:
        file.extractall(root, filter="data")
print(folder / "bin")
