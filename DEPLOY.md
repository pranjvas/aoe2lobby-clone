# Deploying aoe2lobby.online

Target: any Ubuntu 22.04/24.04 VPS with Node 22.12 or newer. The scraper no longer runs a browser
(no Chrome or Puppeteer), so the app itself needs little CPU or RAM.

## Layout

```
Internet -> Caddy (80/443, auto HTTPS) -> server.js (127.0.0.1:3002, API + frontend)
                                          scraper.js (WebSocket snapshots of aoe2lobby.com -> scraped_*_v2.json)
```

`server.js` serves both `/api/lobbies` and the frontend (only the whitelisted runtime files: `index.html`,
`app.js`, `styles.css`, `fonts/`, favicons and icons, `robots.txt`, `sitemap.xml`, ...), so `fe_server.js`
and `cloudflared.exe` are no longer used. Fonts are self-hosted; no requests go to Google Fonts.

The deployed file list is `FILES` in `deploy/push.sh` (and the same list in `deploy/setup.sh`). A new runtime
file must be added there, and to `PUBLIC_FILES` in `server.js` if browsers fetch it.

## 1. DNS (Namecheap)

Domain List -> Manage -> Advanced DNS. Remove the default parking records, then add:

| Type | Host | Value        |
|------|------|--------------|
| A    | @    | `<VPS IPv4>` |
| A    | www  | `<VPS IPv4>` |

Do this before the first start so Caddy can get its HTTPS certificate. Optional: move the nameservers to a
free Cloudflare account for a CDN and to hide the server IP (the domain stays registered at Namecheap).

## 2. Upload and set up (new server)

From Git Bash in the repo root on your PC (replace the IP):

```bash
git archive --format=tar.gz -o /tmp/aoe2lobby.tar.gz HEAD
scp -i ~/.ssh/aoe2lobby_vps /tmp/aoe2lobby.tar.gz root@<VPS IP>:/root/
ssh -i ~/.ssh/aoe2lobby_vps root@<VPS IP> "rm -rf /root/aoe2lobby && mkdir -p /root/aoe2lobby && tar -xzf /root/aoe2lobby.tar.gz -C /root/aoe2lobby && bash /root/aoe2lobby/deploy/setup.sh"
```

`setup.sh` runs as root and:

- installs Node 22 (if Node is missing or older than 22.12), Caddy, a 2 GB swap file and a firewall
  (SSH/80/443 only);
- installs `deploy/Caddyfile` as root from `/root/aoe2lobby` before any app-user code runs;
- copies only the runtime files (the `FILES` list) to `/opt/aoe2lobby`, owned by user `aoe2`;
- installs pm2 7.1.1, starts the app as `aoe2` and hands the pm2 daemon over to systemd (`pm2-aoe2.service`),
  so it survives reboots and the end of the SSH session;
- enables fail2ban for SSH (5 failed logins in 10 minutes = 1 h ban, longer for repeat offenders). SSH
  password login and root login are left as they are;
- rotates pm2's logs daily (at most 10 MB each, 7 kept, compressed) via `/etc/logrotate.d/aoe2lobby-pm2`;
- lets unattended-upgrades install updates from the NodeSource and Caddy repos as well
  (`/etc/apt/apt.conf.d/51unattended-upgrades-thirdparty`). A Node update takes effect after
  `systemctl restart pm2-aoe2`.

## 3. Check

```bash
curl -s http://127.0.0.1:3002/api/lobbies | head -c 200   # on the VPS
systemctl is-active pm2-aoe2                               # active
sudo -u aoe2 pm2 status                                    # server + scraper online
sudo -u aoe2 pm2 logs scraper --lines 30
fail2ban-client status sshd
logrotate -d /etc/logrotate.d/aoe2lobby-pm2
unattended-upgrade --dry-run -d 2>&1 | grep -iE 'allowed origins|nodistro|cloudsmith'
curl -I https://aoe2lobby.online
```

Use `sudo -u aoe2 pm2 ...` for pm2 commands. Running `pm2` as root starts a second, empty root daemon.

## Current production

- VPS: Contabo, Ubuntu 24.04, `85.190.254.97`, app in `/opt/aoe2lobby` run by user `aoe2` under `pm2-aoe2.service`
- DNS: Cloudflare (the domain's nameservers point there, not Namecheap). `@` and `www` A records -> VPS, DNS only
- SSH: `ssh -i ~/.ssh/aoe2lobby_vps root@85.190.254.97` (key added with `deploy/add-key.ps1`)
- Visits: Cloudflare dashboard -> Analytics -> Web analytics -> aoe2lobby.online (beacon snippet in `index.html`)
- Caddy: admin API on the unix socket `/var/lib/caddy/admin.sock` (no TCP port 2019), HTTP/1.1 and HTTP/2 only
  (ufw drops UDP 443). The Content-Security-Policy is sent as `Content-Security-Policy-Report-Only`; once the
  browser console shows no violations on Lobbies, Players and Spectate, rename the header to
  `Content-Security-Policy` in `deploy/Caddyfile`.
- Access log: `/var/log/caddy/access.log`, client IPs masked to /24 (IPv4) and /48 (IPv6), rolled at 50 MB,
  5 files kept for at most 30 days.

## Updating later

Commit, then from Git Bash in the repo root:

```bash
bash deploy/push.sh
```

It ships the committed HEAD only. It refuses to run while a deployed file has uncommitted or untracked
changes (`ALLOW_DIRTY=1 bash deploy/push.sh` overrides this and still ships HEAD). It then:

1. uploads the runtime files to `/root/aoe2lobby-release.tar.gz` (retried up to 3 times; nothing on the server
   changes if the upload fails);
2. extracts them into root-only `/root/aoe2lobby` and checks them there: `node --check` on `server.js`,
   `scraper.js` and `app.js`, and `caddy validate` on the Caddyfile;
3. requires `pm2-aoe2.service` to be active;
4. syncs the files into `/opt/aoe2lobby` with `rsync --delete`, which removes files that are no longer shipped
   but keeps `node_modules/`, `map_names.json` and the scraped `scraped_*_v2.json` data;
5. runs `npm install --omit=dev` only when `package-lock.json` changed;
6. installs the Caddyfile as root (`root:root`, 644) and reloads Caddy (restarts it if the reload fails);
7. reloads pm2, waits up to 15 s for the server to answer on `127.0.0.1:3002` (printing its logs if it does
   not) and saves the pm2 process list.

A failed check (steps 2, 3 and 7) stops the deploy without a retry; a dropped connection is retried once.

## One-time migration of the existing server

The production server was set up with the older scripts, with pm2 running outside systemd. For the first
deploy with the new `push.sh`:

1. Run `bash deploy/push.sh`. While `pm2-aoe2.service` is not active, it uploads and checks the release in
   `/root/aoe2lobby`, then stops with "pm2-aoe2.service is not active" without touching `/opt/aoe2lobby` or
   Caddy. Check first that `systemctl is-active pm2-aoe2` does not print `active`; if it does, this step
   deploys straight away.
2. On the server, preview what `rsync --delete` would remove from `/opt/aoe2lobby` (it should list only old
   debugging files):
   ```bash
   rsync -an --delete --itemize-changes --exclude /node_modules/ --exclude "/scraped_*_v2.json" \
     --exclude "/scraped_*_v2.json.*.tmp" --exclude /map_names.json --exclude /deploy/ \
     /root/aoe2lobby/ /opt/aoe2lobby/
   ```
3. Move pm2 under systemd (a few seconds of downtime):
   ```bash
   sudo -u aoe2 pm2 save && sudo -u aoe2 pm2 kill && systemctl start pm2-aoe2
   systemctl is-active pm2-aoe2
   ```
4. Run `bash deploy/push.sh` again.
5. Install fail2ban, the logrotate rule and the unattended-upgrades origins as in `setup.sh` (independent of
   the deploy).

The first deploy moves Caddy's admin API to the socket. That reload fails because the old admin address is
gone, so `push.sh` restarts Caddy instead (about 1 s of downtime).

After the deploy that removes the browser, drop the scraper's old environment (`pm2 reload` keeps removed
variables such as `PUPPETEER_NO_SANDBOX`) and the downloaded Chrome:

```bash
sudo -u aoe2 bash -c 'cd /opt/aoe2lobby && pm2 delete scraper && pm2 start ecosystem.config.js --only scraper --env production && pm2 save'
rm -rf /home/aoe2/.cache/puppeteer
```

## Known risks

- **Scraper IP blocking:** `scraper.js` reads aoe2lobby.com. Datacenter IPs are sometimes blocked by sites like
  that. Check `sudo -u aoe2 pm2 logs scraper` and that `scraped_lobbies_v2.json` fills up on the first run. If
  the scraper is blocked, pause it (`sudo -u aoe2 pm2 stop scraper`) and contact the aoe2lobby.com operator.
- **Third-party data:** the site republishes data pulled from aoe2lobby.com and the Relic API. Make sure that is
  acceptable to those services before putting it on a public domain.
- **No auth / rate limiting** on `/api/lobbies`; Caddy or Cloudflare rate limits are worth adding if traffic grows.
- **fail2ban** bans your own IP for 1 h after 5 wrong passwords in 10 minutes. Recover from the Contabo console or
  another IP.
