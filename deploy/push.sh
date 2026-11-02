#!/usr/bin/env bash
# Ship the committed HEAD to the VPS and reload the app. Run from the repo root (Git Bash works):
#   bash deploy/push.sh
# Uncommitted changes are NOT shipped. Scraped data and map_names.json on the server are kept.
set -euo pipefail

SERVER=${SERVER:-root@85.190.254.97}
KEY=${KEY:-$HOME/.ssh/aoe2lobby_vps}
SSH_OPTS=(-i "$KEY" -o ServerAliveInterval=15 -o ServerAliveCountMax=8 -o ConnectTimeout=20)

# Only what the server runs (the repo also tracks old debugging dumps that would make the upload ~5 MB)
FILES=(
  package.json package-lock.json ecosystem.config.js server.js scraper.js
  index.html app.js styles.css
  favicon.png favicon-32.png apple-touch-icon.png icon-192.png icon-512.png og-image.png
  site.webmanifest robots.txt sitemap.xml 7e7c007e5148f7d5a2953120e8410d70.txt
  deploy
)
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

INSTALL='
  set -e
  rm -rf /root/aoe2lobby && mkdir -p /root/aoe2lobby && tar -xzf /root/aoe2lobby-release.tar.gz -C /root/aoe2lobby
  rsync -a /root/aoe2lobby/ /opt/aoe2lobby/
  chown -R aoe2:aoe2 /opt/aoe2lobby
  sudo -u aoe2 bash -c "cd /opt/aoe2lobby && npm install --omit=dev --no-audit --no-fund && pm2 reload ecosystem.config.js --env production && pm2 save"
  cp /opt/aoe2lobby/deploy/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
'
# The install step is safe to repeat, so retry it too if the connection drops
for attempt in 1 2; do
  if ssh "${SSH_OPTS[@]}" "$SERVER" "$INSTALL"; then break; fi
  [ "$attempt" = 2 ] && { echo "Install step failed twice; check the server." >&2; exit 1; }
  echo "Install step failed, retrying..." >&2
  sleep 5
done
echo "Deployed $(git rev-parse --short HEAD) to $SERVER"
