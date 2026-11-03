#!/usr/bin/env bash
# One-time VPS setup for Ubuntu 22.04/24.04. Run as root from an extracted copy of the repo in a root-only
# folder (DEPLOY.md shows how):
#   bash /root/aoe2lobby/deploy/setup.sh
# Later updates go through deploy/push.sh. Never touches PasswordAuthentication or PermitRootLogin.
set -euo pipefail

APP_USER=aoe2
APP_DIR=/opt/aoe2lobby
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# The runtime files deploy/push.sh ships (keep the two lists in sync); deploy/ itself stays in $SRC_DIR
FILES=(
  package.json package-lock.json ecosystem.config.js server.js scraper.js
  index.html app.js styles.css fonts
  favicon.png favicon-32.png apple-touch-icon.png icon-192.png icon-512.png og-image.png
  site.webmanifest robots.txt sitemap.xml 7e7c007e5148f7d5a2953120e8410d70.txt
)

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates gnupg rsync unzip ufw debian-keyring debian-archive-keyring apt-transport-https \
  fail2ban logrotate unattended-upgrades

# Node.js 22.12 or newer
if ! command -v node >/dev/null ||
   ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)'; then
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

# HTTPS reverse proxy. Installed by root from the root-only source folder, before any app-user code runs.
# The first reload fails while Caddy still listens on the old admin address, so fall back to a restart.
install -o root -g root -m 644 "$SRC_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

# 2 GB swap as a safety margin on a small VPS
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

# App user and files (only the runtime files, not the whole repo)
id "$APP_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$APP_USER"
mkdir -p "$APP_DIR"
(cd "$SRC_DIR" && rsync -aR -- "${FILES[@]}" "$APP_DIR"/)
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# pm2 (pinned) and the app's dependencies
npm install -g pm2@7.1.1
sudo -u "$APP_USER" bash -c "cd $APP_DIR && npm install --omit=dev --no-audit --no-fund"

# Start the app once to write pm2's process list, then hand the daemon over to systemd (pm2-$APP_USER.service)
# so it is not left running in this SSH session. push.sh refuses to deploy unless that service is active.
sudo -u "$APP_USER" bash -c "cd $APP_DIR && pm2 start ecosystem.config.js --env production && pm2 save"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER"
sudo -u "$APP_USER" pm2 kill
pm2 kill >/dev/null 2>&1 || true   # a root daemon that pm2 startup may have spawned
systemctl start "pm2-$APP_USER"

# SSH brute-force throttle: 5 failures in 10 minutes = 1 h ban, longer for repeat offenders
cat > /etc/fail2ban/jail.d/sshd-local.conf <<'EOF'
[sshd]
enabled = true
mode = normal
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
bantime.increment = true
EOF
systemctl enable fail2ban
systemctl restart fail2ban

# Rotate pm2's logs (su is needed because the log folder is group-writable)
cat > /etc/logrotate.d/aoe2lobby-pm2 <<EOF
/home/$APP_USER/.pm2/logs/*.log /home/$APP_USER/.pm2/pm2.log {
    su $APP_USER $APP_USER
    daily
    maxsize 10M
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF

# Security updates for the NodeSource and Caddy repos too (unattended-upgrades skips third-party repos).
# A Node update takes effect after: systemctl restart pm2-$APP_USER
cat > /etc/apt/apt.conf.d/51unattended-upgrades-thirdparty <<'EOF'
Unattended-Upgrade::Origins-Pattern {
    "origin=. nodistro,codename=nodistro";
    "origin=cloudsmith/caddy/stable,codename=any-version";
};
EOF

echo "Done. Check: curl -s http://127.0.0.1:3002/api/lobbies | head -c 200"
