#!/bin/sh
# Run one of the release's end-to-end scripts on the hosted instance, as the service user with the service's own
# environment and native tools, in a throw-away state directory (never the live workbench state).
#
#   PAI_SEND_E2E=pillow-e2e python3 tools/aws_operator.py send --script tools/hosted_e2e.sh
#
# The script imports the compiled release (dist/src) and runs with Node's type stripping; ALB authentication and the
# public origin are disabled because it talks to an in-process app, never to the network. Prints the report line.
set -e
E2E="${E2E:-pillow-e2e}"
case "$E2E" in *[!a-z0-9-]*) echo "bad E2E name" >&2; exit 2;; esac
REL=$(readlink -f /opt/pai/current)
NODE=$(systemctl show pai-workbench -p ExecStart | grep -oE 'path=[^ ;]+' | head -1 | cut -d= -f2)
W=$(mktemp -d /tmp/pai-e2e.XXXXXX); chown pai "$W"
sed -e "s#\.\./src/\([a-z-]*\)\.js#$REL/dist/src/\1.js#g" \
    -e 's#createApp({ ...config, state })#createApp({ ...config, state, albAuth: undefined, publicOrigin: undefined })#' \
    "$REL/scripts/$E2E.ts" > "$W/$E2E.ts"
chown pai "$W/$E2E.ts"
cd "$W"
set -a; . /etc/pai/runtime.env; set +a
for kv in $(systemctl show pai-workbench -p Environment --value); do export "$kv"; done
export PAI_STATE="$W/state"
/usr/sbin/runuser -u pai -p -- timeout 3000 "$NODE" --env-file-if-exists="$REL/.state/demo.env" "$W/$E2E.ts" 2>&1 \
  | /usr/bin/grep -v -e Warning -e trace-warnings | /usr/bin/tail -1
rm -rf "$W"
