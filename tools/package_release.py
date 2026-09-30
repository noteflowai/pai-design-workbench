"""Package an explicit deployment allowlist; never include private runtime state."""
from pathlib import Path
import hashlib
import json
import tarfile

root = Path(__file__).resolve().parents[1]
output = root / ".state/deploy/release.tgz"
output.parent.mkdir(parents=True, exist_ok=True)
directories = ["dist/src", "web-dist", "src", "scripts", "native", "tools"]
files = ["package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICE.md"]
paths = [root / p for p in files]
for directory in directories:
    paths.extend(p for p in (root / directory).rglob("*") if p.is_file() and "__pycache__" not in p.parts)
for path in paths:
    assert path.is_file() and not path.is_symlink()
with tarfile.open(output, "w:gz") as archive:
    for path in sorted(set(paths)):
        archive.add(path, arcname=str(path.relative_to(root)), recursive=False)
print(json.dumps({"artifact": str(output), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                  "files": len(set(paths)), "privateStateIncluded": False}))
