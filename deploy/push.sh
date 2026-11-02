#!/usr/bin/env bash
# Ship the committed HEAD to the VPS and reload the app. Run from the repo root (Git Bash works):
#   bash deploy/push.sh
# Uncommitted changes are NOT shipped. Scraped data on the server is kept.
set -euo pipefail

SERVER=${SERVER:-root@85.190.254.97}
KEY=${KEY:-$HOME/.ssh/aoe2lobby_vps}

git archive --format=tar HEAD | ssh -i "$KEY" -o ServerAliveInterval=15 -o ServerAliveCountMax=8 "$SERVER" '
  set -e
  rm -rf /root/aoe2lobby && mkdir -p /root/aoe2lobby && tar -x -C /root/aoe2lobby
  rsync -a /root/aoe2lobby/ /opt/aoe2lobby/
  chown -R aoe2:aoe2 /opt/aoe2lobby
  sudo -u aoe2 bash -c "cd /opt/aoe2lobby && npm install --omit=dev --no-audit --no-fund && pm2 reload ecosystem.config.js --env production && pm2 save"
  cp /opt/aoe2lobby/deploy/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
'
echo "Deployed $(git rev-parse --short HEAD) to $SERVER"
