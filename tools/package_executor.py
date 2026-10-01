"""Create the pinned executor archive from the local NoteFlow executor checkout (git archive, deterministic).

The private executor source is never committed to this repository; the archive lives in ignored state
and is handed to the image build / hosted release as a separately hashed artifact.
"""
import hashlib
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
pins = json.loads((root / "tools/runtime-pins.json").read_text())["executor"]
source = Path.home() / ".local/share/noteflow-text-executor"
out = root / ".state/deploy" / f"executor-{pins['commit'][:12]}.tar"
out.parent.mkdir(parents=True, exist_ok=True)
data = subprocess.run(["git", "archive", "--format=tar", pins["commit"]], cwd=source, capture_output=True, check=True).stdout
digest = hashlib.sha256(data).hexdigest()
if digest != pins["archiveSha256"]:
    raise SystemExit("Executor archive digest differs from the pin; refusing to package")
out.write_bytes(data)
out.chmod(0o600)
print(json.dumps({"archive": str(out), "sha256": digest, "bytes": len(data)}))
