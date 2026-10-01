#!/bin/bash
# Invoke through the scoped SSM operator after CDK has granted the new asset.
set -euo pipefail
: "${PAI_RELEASE_HASH:?}"
: "${PAI_ASSET_BUCKET:?}"
: "${PAI_ASSET_KEY:?}"
RELEASE="/opt/pai/releases/$PAI_RELEASE_HASH"
export PAI_RELEASE="$RELEASE"
python3 - <<'PY'
import boto3, hashlib, os, re, tarfile
from pathlib import Path
digest = os.environ["PAI_RELEASE_HASH"]
assert re.fullmatch("[a-f0-9]{64}", digest)
archive = Path("/tmp/pai-update-" + digest + ".tgz")
boto3.client("s3").download_file(os.environ["PAI_ASSET_BUCKET"], os.environ["PAI_ASSET_KEY"], str(archive))
assert hashlib.sha256(archive.read_bytes()).hexdigest() == digest
release = Path(os.environ["PAI_RELEASE"])
release.mkdir(parents=True, exist_ok=True)
with tarfile.open(archive) as file:
    for member in file.getmembers():
        path = Path(member.name)
        assert not path.is_absolute() and ".." not in path.parts and ".state" not in path.parts
        assert member.isfile() or member.isdir()
    file.extractall(release, filter="data")
PY
if [ ! -e "$RELEASE/.state" ]; then ln -s /var/lib/pai/data/state "$RELEASE/.state"; fi
chown -R pai:pai "$RELEASE"
cd "$RELEASE"
NODE_BIN="/var/lib/pai/data/state/tools/node-v24.21.0-linux-x64/bin"
runuser -u pai -- env PATH="$NODE_BIN:$PATH" npm ci
runuser -u pai -- env PATH="$NODE_BIN:$PATH" npm prune --omit=dev
# Native parametric CAD: hash-locked CadQuery 2.8.0 / OCCT 7.9 in persistent state; idempotent. Fails before any switch.
if ! python3 -c "import ensurepip" 2>/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3.12-venv >/dev/null
fi
runuser -u pai -- python3 tools/setup_cadquery.py
PREVIOUS=$(readlink -f /opt/pai/current)
systemctl stop pai-workbench.service
ln -sfn "$RELEASE" /opt/pai/current.next
mv -Tf /opt/pai/current.next /opt/pai/current
systemctl start pai-workbench.service
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:4317/healthz >/dev/null; then
    echo "Verified new release $PAI_RELEASE_HASH; previous $PREVIOUS retained; no native replay."
    exit 0
  fi
  sleep 1
done
ln -sfn "$PREVIOUS" /opt/pai/current.next
mv -Tf /opt/pai/current.next /opt/pai/current
systemctl restart pai-workbench.service
echo "New release failed health; restored previous release without changing domain state." >&2
exit 1
