#!/usr/bin/env bash
# Explicit provisioning only; never called by a periodic check.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$#" -eq 1 ] || exit 2
prepared="$1"
case "$prepared" in /*) ;; *) echo "Use an absolute dependency destination" >&2; exit 2 ;; esac
[ ! -e "$prepared" ] || { echo "Prepared dependencies already exist" >&2; exit 1; }
mkdir -p "$prepared"

# Reuse the domain installer and independently check the repository's pinned hash.
node_bin="$(python3 tools/setup_node.py)"
python3 - "$node_bin" <<'PY'
import hashlib, json, subprocess, sys
from pathlib import Path

pins = json.loads(Path("tools/runtime-pins.json").read_text())["node"]
folder = Path(sys.argv[1]).parent
archive = folder.parent / (folder.name + ".tar.xz")
if hashlib.file_digest(archive.open("rb"), "sha256").hexdigest() != pins["sha256"]["linux-x64"]:
    raise SystemExit("Node does not match the domain's pinned SHA-256")
if subprocess.check_output([str(folder / "bin/node"), "--version"], text=True).strip() != "v" + pins["version"]:
    raise SystemExit("Node version differs")
PY
mv "$(dirname "$node_bin")" "$prepared/node"
export PATH="$prepared/node/bin:$PATH"
npm ci --no-audit --no-fund
npm --prefix infra ci --no-audit --no-fund
python3 - "$prepared" <<'PY'
import hashlib, json, shutil, subprocess, sys
from pathlib import Path

prepared = Path(sys.argv[1])
receipt = {"schema_version": 1, "node": subprocess.check_output(["node", "--version"], text=True).strip()}
for label, root in (("core", Path(".")), ("infra", Path("infra"))):
    receipt[label] = hashlib.sha256((root / "package-lock.json").read_bytes()).hexdigest()
    shutil.move(str(root / "node_modules"), prepared / label)
(prepared / "locks.json").write_text(json.dumps(receipt, indent=2) + "\n")
PY
