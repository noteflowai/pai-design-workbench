"""Package an explicit deployment allowlist; never include private runtime state."""
from pathlib import Path
import hashlib
import io
import json
import subprocess
import tarfile
from datetime import datetime, timezone

root = Path(__file__).resolve().parents[1]
output = root / ".state/deploy/release.tgz"
output.parent.mkdir(parents=True, exist_ok=True)
directories = ["dist/src", "web-dist", "src", "scripts", "native", "tools", "data"]
files = ["package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICE.md", "infra/install_ai.sh", "infra/apparmor-bwrap"]
paths = [root / p for p in files]
for directory in directories:
    paths.extend(p for p in (root / directory).rglob("*") if p.is_file() and "__pycache__" not in p.parts)
for path in paths:
    assert path.is_file() and not path.is_symlink()
# Provenance: the commit the sources came from, only when every packaged source path is clean (else unknown).
def git(*args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=False).stdout.strip()
commit = git("rev-parse", "HEAD")
dirty = git("status", "--porcelain", "--", "src", "scripts", "native", "tools", "data", *files)
source_commit = commit if len(commit) == 40 and not dirty else None
version = json.loads((root / "package.json").read_text())["version"]
packaged_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
with tarfile.open(output, "w:gz") as archive:
    for path in sorted(set(paths)):
        archive.add(path, arcname=str(path.relative_to(root)), recursive=False)
    def add(name, data):
        info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o644
        archive.addfile(info, io.BytesIO(data))
    if source_commit:
        add(".source-commit", (source_commit + "\n").encode())
    # Shown in the signed-in UI (status bar) and by update_release.sh, so a deploy can be matched to main.
    add(".build-info.json", (json.dumps({"version": version, "sourceCommit": source_commit, "packagedAt": packaged_at}) + "\n").encode())
print(json.dumps({"artifact": str(output), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "version": version,
                  "files": len(set(paths)), "sourceCommit": source_commit, "privateStateIncluded": False}))
