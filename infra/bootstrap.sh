#!/bin/bash
set -euo pipefail
exec > >(tee -a /var/log/pai-bootstrap.log) 2>&1
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-boto3 git xz-utils curl libx11-6 libxfixes3 libxrender1 libxi6 libxkbcommon0 libsm6 libgl1 libegl1 libdbus-1-3 libfontconfig1
id pai >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/pai --shell /usr/sbin/nologin pai
install -d -m 0750 -o pai -g pai /var/lib/pai/data /opt/pai/releases
DEVICE=""
for attempt in $(seq 1 120); do
  DEVICE=$(lsblk -nro PATH,SERIAL | awk -v serial="${PAI_VOLUME_ID//-/}" '$2 == serial {print $1; exit}')
  if [ -n "$DEVICE" ]; then break; fi
  sleep 2
done
test -n "$DEVICE"
if ! blkid "$DEVICE" >/dev/null; then mkfs.ext4 -L pai-data "$DEVICE"; fi
UUID=$(blkid -s UUID -o value "$DEVICE")
if ! grep -q "UUID=$UUID " /etc/fstab; then
  echo "UUID=$UUID /var/lib/pai/data ext4 defaults,nofail 0 2" >> /etc/fstab
fi
mountpoint -q /var/lib/pai/data || mount /var/lib/pai/data
install -d -m 0700 -o pai -g pai /var/lib/pai/data/state
RELEASE="/opt/pai/releases/$PAI_RELEASE_HASH"
install -d -m 0750 -o pai -g pai "$RELEASE"
export PAI_RELEASE="$RELEASE"
python3 - <<'PY'
import boto3, os, hashlib
from pathlib import Path
path = Path("/tmp/pai-release.tgz")
boto3.client("s3").download_file(os.environ["PAI_ASSET_BUCKET"], os.environ["PAI_ASSET_KEY"], str(path))
if hashlib.sha256(path.read_bytes()).hexdigest() != os.environ["PAI_RELEASE_HASH"]:
    raise SystemExit("Deployment artifact hash mismatch")
PY
tar -xzf /tmp/pai-release.tgz -C "$RELEASE"
ln -s /var/lib/pai/data/state "$RELEASE/.state"
chown -R pai:pai "$RELEASE"
cd "$RELEASE"
runuser -u pai -- python3 tools/setup_node.py
NODE_VERSION=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['node']['version'])" "$PAI_RELEASE/tools/runtime-pins.json")
NODE_BIN="$RELEASE/.state/tools/node-v$NODE_VERSION-linux-x64/bin"
runuser -u pai -- env PATH="$NODE_BIN:$PATH" npm ci
runuser -u pai -- env PATH="$NODE_BIN:$PATH" npm run setup:demo
runuser -u pai -- env PATH="$NODE_BIN:$PATH" npm run setup:native
runuser -u pai -- env PATH="$NODE_BIN:$PATH" npm prune --omit=dev
install -d -m 0750 /etc/pai
cat > /etc/pai/runtime.env <<EOF
PORT=4317
PAI_STATE=/var/lib/pai/data/state
PAI_LISTEN_HOST=0.0.0.0
PAI_PUBLIC_ORIGIN=https://pai.oneai.host
PAI_AUTH_ALB_ARN=$PAI_ALB_ARN
PAI_AUTH_ISSUER=$PAI_ISSUER
PAI_AUTH_CLIENT_ID=$PAI_CLIENT_ID
PAI_AUTH_LOGOUT_URL=$PAI_LOGOUT_URL
EOF
chmod 0640 /etc/pai/runtime.env
chown root:pai /etc/pai/runtime.env
ln -sfn "$RELEASE" /opt/pai/current
cat > /etc/systemd/system/pai-workbench.service <<EOF
[Unit]
Description=PAI Design Workbench
After=network-online.target
Wants=network-online.target
RequiresMountsFor=/var/lib/pai/data
[Service]
User=pai
Group=pai
WorkingDirectory=/opt/pai/current
EnvironmentFile=/etc/pai/runtime.env
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_BIN/node --env-file-if-exists=.state/demo.env dist/src/server.js
Restart=on-failure
RestartSec=15
TimeoutStopSec=60
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/pai/data
LimitNOFILE=8192
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now pai-workbench.service
echo "PAI_BOOTSTRAP_COMPLETE"
