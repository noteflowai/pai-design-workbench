#!/usr/bin/env bash
# The same bounded CPU checks serve GitHub CI and the local verifier.
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:-all}"
if [ "$#" -gt 0 ]; then shift; fi
case "$mode" in all|core|infra) ;; *) echo "Invalid CPU check mode" >&2; exit 2 ;; esac

if [ "$#" -gt 0 ]; then
  [ "$#" -eq 2 ] && [ "$1" = "--prepared-dependencies" ] || exit 2
  prepared="$2"
  python3 - "$prepared" <<'PY'
import hashlib, json, shutil, subprocess, sys
from pathlib import Path

prepared = Path(sys.argv[1])
if not prepared.is_absolute() or prepared.is_symlink():
    raise SystemExit("An absolute prepared dependency directory is required")
receipt = json.loads((prepared / "locks.json").read_text())
if receipt.get("schema_version") != 1:
    raise SystemExit("Unsupported dependency receipt")
for label, root in (("core", Path(".")), ("infra", Path("infra"))):
    actual = hashlib.sha256((root / "package-lock.json").read_bytes()).hexdigest()
    if receipt[label] != actual:
        raise SystemExit("Prepared dependencies do not match the source lockfiles")
    destination = root / "node_modules"
    if destination.exists() or destination.is_symlink():
        raise SystemExit("Do not replace existing dependencies")
if subprocess.check_output(["node", "--version"], text=True).strip() != receipt["node"]:
    raise SystemExit("Prepared Node identity differs")
for label, root in (("core", Path(".")), ("infra", Path("infra"))):
    shutil.copytree(prepared / label, root / "node_modules", symlinks=True)
PY
fi

if [ "$mode" != infra ]; then
  python3 -B -m unittest discover -s tests -p 'test_*.py'
  npm run check
fi
if [ "$mode" != core ]; then
  npm --prefix infra run check
  bash -n infra/bootstrap.sh infra/update_release.sh
fi
