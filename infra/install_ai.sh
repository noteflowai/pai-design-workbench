#!/bin/bash
# AI runtime for the hosted workbench: pinned Kiro CLI + NoteFlow executor, Kiro keys from Secrets Manager,
# a dedicated attempt-only ledger and a systemd drop-in. Idempotent; run as root from update_release.sh.
# Never prints credentials. Requires PAI_RELEASE, PAI_ASSET_BUCKET, PAI_EXECUTOR_KEY, PAI_AI_KEYS_ARN.
set -euo pipefail
: "${PAI_RELEASE:?}" "${PAI_ASSET_BUCKET:?}" "${PAI_EXECUTOR_KEY:?}" "${PAI_AI_KEYS_ARN:?}"
STATE=/var/lib/pai/data/state
AI=$STATE/tools/ai
NODE_BIN="$STATE/tools/node-v24.21.0-linux-x64/bin"
install -d -m 0700 -o pai -g pai "$AI" "$STATE/ai-ledger"
TAR=$(mktemp /tmp/pai-executor.XXXXXX.tar)
python3 -c "import boto3,os,sys; boto3.client('s3').download_file(os.environ['PAI_ASSET_BUCKET'], os.environ['PAI_EXECUTOR_KEY'], sys.argv[1])" "$TAR"
chown pai:pai "$TAR"
OUT=$(runuser -u pai -- env PATH="$NODE_BIN:$PATH" HOME=/var/lib/pai python3 "$PAI_RELEASE/tools/install_ai_runtime.py" --prefix "$AI" --executor-tar "$TAR" --link-dir "$AI/bin")
rm -f "$TAR"
ROOT=$(python3 -c "import json,sys; print(json.loads(sys.argv[1].strip().splitlines()[-1])['executorRoot'])" "$OUT")
# Kiro keys, in the exact files the executor reads (owner-only); values never reach logs.
runuser -u pai -- install -d -m 0700 /var/lib/pai/.config /var/lib/pai/.config/agent-cli /var/lib/pai/.config/kiro-failover
python3 - <<'PY'
import boto3, json, os, re
keys = json.loads(boto3.client("secretsmanager").get_secret_value(SecretId=os.environ["PAI_AI_KEYS_ARN"])["SecretString"])
assert set(keys) == {"primary", "backup", "backup2"} and all(re.fullmatch(r"ksk_[A-Za-z0-9_-]{20,}", v) for v in keys.values())
import pwd
pai = pwd.getpwnam("pai")
for path, text in (("/var/lib/pai/.config/agent-cli/env", f"KIRO_API_KEY={keys['primary']}\n"),
                   ("/var/lib/pai/.config/kiro-failover/backup.key", keys["backup"] + "\n"),
                   ("/var/lib/pai/.config/kiro-failover/backup2.key", keys["backup2"] + "\n")):
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f: f.write(text)
    os.chown(tmp, pai.pw_uid, pai.pw_gid); os.replace(tmp, path)
print("kiro keys installed")
PY
# Dedicated ledger with the reviewed attempt-only policy; an existing ledger is never replaced or reset.
runuser -u pai -- bash -c "cd '$ROOT' && python3 -B - <<'PY'
import json
from pathlib import Path
from agent_control.budget import BudgetLedger
policy = json.loads(Path('$PAI_RELEASE/tools/ai-ledger-policy.json').read_text())
BudgetLedger.create(Path('$STATE/ai-ledger/ledger.sqlite3'), policy)
print('ledger ready')
PY"
install -d -m 0755 /etc/systemd/system/pai-workbench.service.d
cat > /etc/systemd/system/pai-workbench.service.d/ai.conf <<EOF
[Service]
Environment=PAI_CONTROL_ROOT=$ROOT
Environment=PAI_CONTROLLER_ENTRYPOINT=$ROOT/.runtime/compiled/flows/execute.js
Environment=PAI_CONTROLLER_DATABASE=$STATE/ai-ledger/ledger.sqlite3
Environment=PAI_AI_PROFILES=kiro-primary,kiro-backup,kiro-backup2
Environment=PATH=$AI/bin:$NODE_BIN:/usr/local/bin:/usr/bin:/bin
EOF
systemctl daemon-reload
echo "AI runtime ready: $(runuser -u pai -- "$AI/bin/kiro-cli-chat" --version)"
