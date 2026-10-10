#!/bin/bash
# Invoke through the scoped SSM operator after CDK has granted the new asset.
set -euo pipefail
: "${PAI_RELEASE_HASH:?}"
: "${PAI_ASSET_BUCKET:?}"
: "${PAI_ASSET_KEY:?}"
RELEASE="/opt/pai/releases/$PAI_RELEASE_HASH"
# Package builds unpack into TMPDIR; keep them on the data volume, not the small root disk.
PAI_TMP=/var/lib/pai/data/tmp
install -d -m 0700 -o pai -g pai "$PAI_TMP"
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
NODE_VERSION=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['node']['version'])" "$PAI_RELEASE/tools/runtime-pins.json")
NODE_BIN="/var/lib/pai/data/state/tools/node-v$NODE_VERSION-linux-x64/bin"
runuser -u pai -- env PATH="$NODE_BIN:$PATH" npm ci
runuser -u pai -- env PATH="$NODE_BIN:$PATH" npm prune --omit=dev
# Native parametric CAD: hash-locked CadQuery 2.8.0 / OCCT 7.9 in persistent state; idempotent. Fails before any switch.
if ! python3 -c "import ensurepip" 2>/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3.12-venv >/dev/null
fi
runuser -u pai -- env TMPDIR="$PAI_TMP" python3 tools/setup_cadquery.py
# Physics lane (Gmsh, CalculiX from the signed Ubuntu archive, Optuna, scikit-learn, MuJoCo); idempotent, no root needed.
DEBIAN_FRONTEND=noninteractive apt-get install -y -q libglu1-mesa libgl1 libopengl0 libxcursor1 libxft2 libxinerama1 libfontconfig1 libgomp1 libopenmpi3t64 >/dev/null
# BoTorch strategy (CPU PyTorch, hash-locked) and Newton USD conformance (CPU Warp) only when the operator opts in.
runuser -u pai -- env TMPDIR="$PAI_TMP" PAI_PHYSICS_BOTORCH="${PAI_PHYSICS_BOTORCH:-}" PAI_PHYSICS_NEWTON="${PAI_PHYSICS_NEWTON:-}" python3 tools/setup_physics.py
# Logistics planning artifact: hash-locked OR-Tools (wheels only); idempotent, no root needed.
runuser -u pai -- env TMPDIR="$PAI_TMP" python3 tools/setup_logistics.py
# Strands Robots cross-check (hash-locked, pinned Menagerie, simulation only) only when the operator opts in.
if [ "${PAI_ROBOTS:-}" = "1" ]; then runuser -u pai -- env TMPDIR="$PAI_TMP" python3 tools/setup_robots.py; fi
# OS sandbox for generated CAD code; without it the lane stays disabled (fail closed).
if ! command -v bwrap >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y -q bubblewrap >/dev/null; fi
# Ubuntu 24.04 restricts unprivileged user namespaces; grant them to bwrap only (per-application AppArmor profile).
if [ -d /sys/kernel/security/apparmor ] && [ -f "$RELEASE/infra/apparmor-bwrap" ]; then
  install -m 0644 "$RELEASE/infra/apparmor-bwrap" /etc/apparmor.d/pai-bwrap && apparmor_parser -r /etc/apparmor.d/pai-bwrap
fi
# AI engine (pinned Kiro CLI + bounded executor); skipped only if the stack predates the AI resources.
if [ -n "${PAI_EXECUTOR_KEY:-}" ] && [ -n "${PAI_AI_KEYS_ARN:-}" ]; then
  bash "$RELEASE/infra/install_ai.sh"
fi
# Release seals: S3 Object Lock archive and RFC 3161 time-stamping authority (each optional).
for key in PAI_PACKAGE_ARCHIVE_BUCKET PAI_PACKAGE_RETENTION_DAYS PAI_TSA_URL PAI_SOLVER_QUEUE PAI_SOLVER_JOB_DEFINITION PAI_SOLVER_BUCKET PAI_SOLVER_REGION PAI_SOLVER_CFD_JOB_DEFINITION PAI_SOLVER_CAM_JOB_DEFINITION; do
  value="${!key:-}"
  if [ -n "$value" ]; then
    sed -i "/^${key}=/d" /etc/pai/runtime.env
    printf '%s=%s\n' "$key" "$value" >> /etc/pai/runtime.env
  fi
done
if [ -n "${PAI_SIGNING_KMS_KEY_ID:-}" ]; then
  sed -i '/^PAI_SIGNING_KMS_KEY_ID=/d' /etc/pai/runtime.env
  printf 'PAI_SIGNING_KMS_KEY_ID=%s\n' "$PAI_SIGNING_KMS_KEY_ID" >> /etc/pai/runtime.env
fi
# Machine-agent API settings come from stack outputs; keep the file's other lines unchanged.
if [ -n "${PAI_AGENT_USER_POOL_ID:-}" ] && [ -n "${PAI_AGENT_CLIENT_ID:-}" ]; then
  sed -i '/^PAI_AGENT_USER_POOL_ID=/d;/^PAI_AGENT_CLIENT_IDS=/d' /etc/pai/runtime.env
  printf 'PAI_AGENT_USER_POOL_ID=%s\nPAI_AGENT_CLIENT_IDS=%s\n' "$PAI_AGENT_USER_POOL_ID" "$PAI_AGENT_CLIENT_ID" >> /etc/pai/runtime.env
fi
PREVIOUS=$(readlink -f /opt/pai/current)
systemctl stop pai-workbench.service
ln -sfn "$RELEASE" /opt/pai/current.next
mv -Tf /opt/pai/current.next /opt/pai/current
systemctl start pai-workbench.service
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:4317/healthz >/dev/null; then
    BUILD=$(python3 -c "import json,sys;b=json.load(open(sys.argv[1]));print('v%s commit %s' % (b['version'], b.get('sourceCommit') or 'unknown'))" "$RELEASE/.build-info.json" 2>/dev/null || echo "build info not recorded")
    # Keep the new release, the previous one and the 3 newest others; older copies only fill the root disk.
    KEEP="$(basename "$RELEASE") $(basename "$PREVIOUS") $(ls -1t /opt/pai/releases | head -5 | tr '\n' ' ')"
    for r in $(ls -1 /opt/pai/releases); do
      case " $KEEP " in *" $r "*) ;; *) [[ "$r" =~ ^[a-f0-9]{64}$ ]] && rm -rf -- "/opt/pai/releases/$r" ;; esac
    done
    echo "Verified new release $PAI_RELEASE_HASH ($BUILD); previous $PREVIOUS retained; no native replay."
    exit 0
  fi
  sleep 1
done
ln -sfn "$PREVIOUS" /opt/pai/current.next
mv -Tf /opt/pai/current.next /opt/pai/current
systemctl restart pai-workbench.service
echo "New release failed health; restored previous release without changing domain state." >&2
exit 1
