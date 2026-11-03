#!/usr/bin/env bash
# Ship the committed HEAD to the VPS and reload the app. Run from the repo root (Git Bash works):
#   bash deploy/push.sh
# Only HEAD is shipped, so the script refuses to run while a deployed file has uncommitted changes
# (ALLOW_DIRTY=1 overrides). Scraped data and map_names.json on the server are kept.
# Needs pm2 running under systemd on the server (pm2-aoe2.service, see DEPLOY.md).
set -euo pipefail

SERVER=${SERVER:-root@85.190.254.97}
KEY=${KEY:-$HOME/.ssh/aoe2lobby_vps}
SSH_OPTS=(-i "$KEY" -o ServerAliveInterval=15 -o ServerAliveCountMax=8 -o ConnectTimeout=20)

# Only what the server runs (the repo also tracks old debugging scripts that are never deployed).
# deploy/setup.sh copies the same list on a fresh server: keep the two in sync.
FILES=(
  package.json package-lock.json ecosystem.config.js server.js scraper.js
  index.html app.js styles.css fonts
  favicon.png favicon-32.png apple-touch-icon.png icon-192.png icon-512.png og-image.png
  site.webmanifest robots.txt sitemap.xml 7e7c007e5148f7d5a2953120e8410d70.txt
  deploy
)

if [ "${ALLOW_DIRTY:-}" != 1 ]; then
  UNTRACKED=$(git ls-files --others --exclude-standard -- "${FILES[@]}")
  if ! git diff --quiet HEAD -- "${FILES[@]}" || [ -n "$UNTRACKED" ]; then
    echo "Uncommitted changes in deployed files (only HEAD is shipped):" >&2
    git diff --stat HEAD -- "${FILES[@]}" >&2
    [ -z "$UNTRACKED" ] || sed 's/^/ untracked: /' <<<"$UNTRACKED" >&2
    echo "Commit or stash them, or rerun with ALLOW_DIRTY=1." >&2
    exit 1
  fi
fi

RELEASE=$(mktemp)
trap 'rm -f "$RELEASE"' EXIT
git archive --format=tar.gz -o "$RELEASE" HEAD -- "${FILES[@]}"

# Upload separately from the install step and retry: long uploads have been reset mid-transfer
for attempt in 1 2 3; do
  if scp -q "${SSH_OPTS[@]}" "$RELEASE" "$SERVER:/root/aoe2lobby-release.tar.gz"; then break; fi
  [ "$attempt" = 3 ] && { echo "Upload failed 3 times; nothing was changed on the server." >&2; exit 1; }
  echo "Upload failed, retrying ($attempt/3)..." >&2
  sleep 5
done

# Runs as root on the server. Everything is checked in root-only /root/aoe2lobby before /opt or Caddy is
# touched, and the Caddyfile is installed from there (never from the aoe2-owned tree).
# Exit 3 = a server-side check failed (bad release, pm2 not under systemd, health check): do not retry.
INSTALL='
  set -e
  rm -rf /root/aoe2lobby
  mkdir -p /root/aoe2lobby
  tar -xzf /root/aoe2lobby-release.tar.gz -C /root/aoe2lobby
  cd /root/aoe2lobby
  { test -f server.js && test -f package.json; } || { echo "Release is incomplete" >&2; exit 3; }
  { node --check server.js && node --check scraper.js && node --check app.js; } || exit 3
  # caddy validate opens the access log as root: create it as caddy first, or Caddy could not write it
  [ -e /var/log/caddy/access.log ] || install -o caddy -g caddy -m 600 /dev/null /var/log/caddy/access.log
  caddy validate --adapter caddyfile --config /root/aoe2lobby/deploy/Caddyfile || exit 3
  systemctl is-active --quiet pm2-aoe2 || { echo "pm2-aoe2.service is not active: run pm2 under systemd first (DEPLOY.md)" >&2; exit 3; }
  # Compare with the lock of the last successful npm install (not /opt, which rsync overwrites before npm runs)
  NEED_NPM=0; cmp -s package-lock.json /root/aoe2lobby-installed.lock || NEED_NPM=1
  rsync -a --delete --exclude /node_modules/ --exclude "/scraped_*_v2.json" --exclude "/scraped_*_v2.json.*.tmp" \
    --exclude /scraped_maps.json --exclude /map_names.json --exclude "/map_names.json.*.tmp" --exclude /deploy/ \
    /root/aoe2lobby/ /opt/aoe2lobby/
  chown -R aoe2:aoe2 /opt/aoe2lobby
  install -o root -g root -m 644 /root/aoe2lobby/deploy/Caddyfile /etc/caddy/Caddyfile
  { systemctl reload caddy || systemctl restart caddy; }
  sudo -u aoe2 bash -c "cd /opt/aoe2lobby && { [ $NEED_NPM = 0 ] || npm install --omit=dev --no-audit --no-fund; } && pm2 reload ecosystem.config.js --env production"
  cp package-lock.json /root/aoe2lobby-installed.lock
  ok=0; for i in $(seq 15); do curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:3002/robots.txt && { ok=1; break; }; sleep 1; done
  [ $ok = 1 ] || { echo "Health check failed: nothing answers on 127.0.0.1:3002" >&2; sudo -u aoe2 pm2 logs server --lines 30 --nostream || true; exit 3; }
  sudo -u aoe2 pm2 save
'
# The install step is safe to repeat, so retry it if the connection drops, but not after a failed check
for attempt in 1 2; do
  rc=0; ssh "${SSH_OPTS[@]}" "$SERVER" "$INSTALL" || rc=$?
  [ "$rc" = 0 ] && break
  [ "$rc" = 3 ] && { echo "Server-side check failed; not retrying." >&2; exit 1; }
  [ "$attempt" = 2 ] && { echo "Install step failed twice; check the server." >&2; exit 1; }
  echo "Install step failed, retrying..." >&2
  sleep 5
done
echo "Deployed $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD)) to $SERVER"
