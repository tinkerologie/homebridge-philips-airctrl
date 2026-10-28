#!/usr/bin/env bash
# Build, pack, ship, install and restart. Requires sshpass and a .env (see .env.example).
#
# Verified layout: Homebridge runs in Docker container "homebridge"; its storage
# dir /var/lib/homebridge resolves to /homebridge in the container, which is the
# host directory /mnt/cache/appdata/homebridge.
#
# Plugins install into the LOCAL plugin dir /var/lib/homebridge/node_modules,
# NOT the global npm root. Only homebridge-config-ui-x lives in the global root
# (/opt/homebridge/lib/node_modules); every other plugin on this instance is
# local. Installing globally leaves the plugin invisible to Homebridge and the
# UI, with no error anywhere — verified the hard way.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "error: .env not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

: "${UNRAID_HOST:?missing in .env}"
: "${UNRAID_USER:?missing in .env}"
: "${UNRAID_PASS:?missing in .env}"

export SSHPASS="$UNRAID_PASS"

CONTAINER=homebridge
HOST_DIR=/mnt/cache/appdata/homebridge   # == /homebridge inside the container

command -v sshpass >/dev/null || { echo "error: sshpass not installed (brew install hudochenkov/sshpass/sshpass)" >&2; exit 1; }

# Never expands the password into the process table of the remote host.
remote() { sshpass -e ssh -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 "$UNRAID_USER@$UNRAID_HOST" "$@"; }

echo "==> Build"
npm run build

echo "==> Pack"
TARBALL=$(npm pack --silent)
trap 'rm -f "$TARBALL"' EXIT
echo "    $TARBALL"

# Stable filename: npm records the install as
#   "homebridge-philips-airctrl": "file:homebridge-philips-airctrl.tgz"
# in /homebridge/package.json, so the tarball MUST stay on the host for that
# reference to keep resolving. Deleting it leaves a dangling dependency and
# every later `npm install` there fails with ENOENT; installing with --no-save
# instead leaves the plugin unmanaged, so the next `npm install` prunes it and
# its runtime deps. Keeping one stable, overwritten tarball avoids both.
DEPLOYED=homebridge-philips-airctrl.tgz

echo "==> Ship to $UNRAID_HOST:$HOST_DIR/$DEPLOYED"
sshpass -e scp -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 \
  "$TARBALL" "$UNRAID_USER@$UNRAID_HOST:$HOST_DIR/$DEPLOYED"

echo "==> Install inside container (local plugin dir, not global)"
# --omit=dev so the container does not pull our test/build toolchain.
remote "docker exec $CONTAINER npm install --prefix /var/lib/homebridge --omit=dev /homebridge/$DEPLOYED"

echo "==> Restart Homebridge"
remote "docker restart $CONTAINER" >/dev/null

echo "==> Wait for it to come back"
for _ in $(seq 1 30); do
  if remote "docker exec $CONTAINER true" 2>/dev/null; then break; fi
  sleep 2
done

echo "==> Done. Recent log:"
remote "docker logs --tail 40 $CONTAINER" 2>&1 | sed 's/^/    /'
