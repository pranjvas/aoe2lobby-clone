# Deploying aoe2lobby.online

Target: any Ubuntu 22.04/24.04 VPS with 2 vCPU / 4 GB RAM (Chrome is the heavy part).

## Layout

```
Internet -> Caddy (80/443, auto HTTPS) -> server.js (127.0.0.1:3002, API + frontend)
                                          scraper.js (headless Chrome -> scraped_*_v2.json every 20s)
```

`server.js` serves both `/api/lobbies` and the frontend (only `index.html`, `app.js`, `styles.css`,
favicons), so `fe_server.js` and `cloudflared.exe` are no longer used.

## 1. DNS (Namecheap)

Domain List -> Manage -> Advanced DNS. Remove the default parking records, then add:

| Type | Host | Value        |
|------|------|--------------|
| A    | @    | `<VPS IPv4>` |
| A    | www  | `<VPS IPv4>` |

Do this before the first start so Caddy can get its HTTPS certificate. Optional: move the nameservers to a
free Cloudflare account for a CDN and to hide the server IP (the domain stays registered at Namecheap).

## 2. Upload and set up

From this folder on your PC (replace the IP):

```bash
rsync -av --exclude node_modules --exclude .git --exclude '*.log' --exclude cloudflared.exe ./ root@<VPS IP>:/root/aoe2lobby/
ssh root@<VPS IP> "bash /root/aoe2lobby/deploy/setup.sh"
```

(On Windows without rsync, use `scp -r` or `git push` to a private repo and `git clone` on the server, then run
`sudo bash deploy/setup.sh` from the clone.)

The script installs Node 22, Caddy, the Chrome libraries, a 2 GB swap file and a firewall (SSH/80/443 only),
copies the app to `/opt/aoe2lobby`, runs it under pm2 as user `aoe2`, and enables start on boot.

## 3. Check

```bash
curl -s http://127.0.0.1:3002/api/lobbies | head -c 200   # on the VPS
pm2 status                                                 # as user aoe2: sudo -u aoe2 pm2 status
sudo -u aoe2 pm2 logs scraper --lines 30
curl -I https://aoe2lobby.online
```

## Updating later

```bash
rsync ... (same as above), then on the VPS:
sudo -u aoe2 bash -c "cd /opt/aoe2lobby && npm install --omit=dev && pm2 reload ecosystem.config.js --env production"
```

## Known risks

- **Scraper IP blocking:** `scraper.js` reads aoe2lobby.com. Datacenter IPs are sometimes blocked by sites like
  that. Check `pm2 logs scraper` and that `scraped_lobbies_v2.json` fills up on the first run. If it is blocked,
  try another provider or route the scraper through a residential proxy.
- **Third-party data:** the site republishes data pulled from aoe2lobby.com and the Relic API. Make sure that is
  acceptable to those services before putting it on a public domain.
- **No auth / rate limiting** on `/api/lobbies`; Caddy or Cloudflare rate limits are worth adding if traffic grows.
