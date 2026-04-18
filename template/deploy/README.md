# Deploying a Tally Holder

Pick whichever fits your host.

## Option 1 — systemd (Raspberry Pi / Linux VPS)

```bash
# assume the scaffold lives at /opt/tally-holder
sudo useradd --system --home /opt/tally-holder --shell /usr/sbin/nologin tally
sudo chown -R tally:tally /opt/tally-holder

sudo cp deploy/tally-holder.service /etc/systemd/system/
# edit WorkingDirectory / User / ExecStart if you put the scaffold elsewhere
sudo systemctl daemon-reload
sudo systemctl enable --now tally-holder
sudo systemctl status tally-holder
journalctl -u tally-holder -f
```

SIGTERM triggers a signed `/holders/leave` before shutdown, so
`systemctl stop tally-holder` deregisters cleanly.

## Option 2 — pm2

```bash
npm install -g pm2
pm2 start deploy/pm2.config.cjs
pm2 save
pm2 startup   # follow the printed instructions to enable at boot
```

`kill_timeout` is set to 20s so the graceful leave has time to run.

## Option 3 — Docker

```bash
docker build -t tally-holder .
docker run -d \
  --name tally-holder \
  --restart unless-stopped \
  -p 7894:7894 \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  tally-holder

docker logs -f tally-holder
# graceful deregister:
docker stop --time=30 tally-holder
```

The image uses `tini` so `docker stop` forwards SIGTERM correctly.

## Inbound mode (public URL)

If you set `TALLY_PUBLIC_URL` in `.env`, the holder listens on
`TALLY_LISTEN_PORT` (default 7894) and accepts:

- `GET  /health`                 — liveness + stats
- `GET  /info`                   — full status
- `POST /packets`                — signed packet push (relay fan-out)
- `GET  /buckets/:id/packets`    — direct client query

Make sure the port is reachable at the URL you advertised. A reverse proxy
with TLS is recommended:

```nginx
server {
  listen 443 ssl;
  server_name holder.example.com;
  location / {
    proxy_pass http://127.0.0.1:7894;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
```

## Outbound-only mode

Leave `TALLY_PUBLIC_URL` blank. The holder still pulls its slice every 15
minutes and serves it to the relay on demand — you just don't accept
inbound pushes or direct queries.

## Data directory

`data/` holds:

- `identity.json` — your Ed25519 keypair (mode 0600). **Back this up.**
- `holder.db` — SQLite copy of your slot assignment's buckets + packets.

Losing `identity.json` means a new agent_id and a fresh slot assignment.
Losing `holder.db` just triggers a full resync on next start.
