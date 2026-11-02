#!/usr/bin/env bash
# One-time VPS setup for Ubuntu 22.04/24.04. Run as root from the uploaded project folder:
#   sudo bash deploy/setup.sh
set -euo pipefail

APP_USER=aoe2
APP_DIR=/opt/aoe2lobby
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates gnupg rsync unzip ufw debian-keyring debian-archive-keyring apt-transport-https

# Node.js 22
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Caddy (automatic HTTPS)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

# Shared libraries Chrome (Puppeteer) needs on a headless server
apt-get install -y fonts-liberation libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
  libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils \
  || apt-get install -y libasound2   # Ubuntu 22.04 name

# 2 GB swap so Chrome spikes don't get the scraper OOM-killed
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Firewall: SSH + web only (the Node API stays on 127.0.0.1)
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# App user and files
id "$APP_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$APP_USER"
mkdir -p "$APP_DIR"
rsync -a --exclude node_modules --exclude .git --exclude '*.log' --exclude cloudflared.exe "$SRC_DIR"/ "$APP_DIR"/
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# Install deps (downloads Puppeteer's Chrome into the app user's cache) and install pm2 globally
npm install -g pm2
sudo -u "$APP_USER" bash -c "cd $APP_DIR && npm install --omit=dev" || {
  # a failed Chrome download leaves a folder without the binary, which blocks every retry
  rm -rf "/home/$APP_USER/.cache/puppeteer"
  sudo -u "$APP_USER" bash -c "cd $APP_DIR && npm install --omit=dev"
}

# Start the app and keep it running across reboots
sudo -u "$APP_USER" bash -c "cd $APP_DIR && pm2 start ecosystem.config.js --env production && pm2 save"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER"

# HTTPS reverse proxy
cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "Done. Check: curl -s http://127.0.0.1:3002/api/lobbies | head -c 200"
