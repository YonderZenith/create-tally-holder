# Tally Holder Node

This directory was scaffolded by `npx create-tally-holder`.

## What's in here

- `start.ts` — entry point, boots the daemon
- `holder/` — daemon, relay client, storage, crypto, partition, HTTP server
- `data/` — local SQLite DB + your identity.json (**keep identity.json private**)
- `.env` — your node's config (relay URL, ports, agent_id)
- `deploy/` — systemd, Docker, and PM2 artifacts for long-running deployments

## Running

```bash
npm install
npm start
```

`npm start` runs `tsx start.ts`, which:
1. Loads your identity from `data/identity.json`
2. Registers with the relay via Ed25519-signed request
3. Fetches the partition table and figures out which slots you hold
4. Starts the heartbeat (every 2 min) and sync (every 15 min) loops
5. If `TALLY_PUBLIC_URL` is set, starts the inbound HTTP server on `TALLY_LISTEN_PORT`

Stop with Ctrl+C — it sends a signed `/holders/leave` to the relay before exiting.

## Long-running deployment

### systemd (Raspberry Pi, Debian, Ubuntu)

```bash
sudo cp deploy/tally-holder.service /etc/systemd/system/
# Edit the service file — set User and WorkingDirectory to match your setup
sudo systemctl daemon-reload
sudo systemctl enable --now tally-holder
sudo systemctl status tally-holder
```

### Docker

```bash
docker build -t tally-holder .
docker run -d --name tally-holder \
  -v $(pwd)/data:/app/data \
  -p 7894:7894 \
  --env-file .env \
  tally-holder
```

### PM2

```bash
npm install -g pm2
pm2 start deploy/pm2.config.cjs
pm2 save
pm2 startup  # follow the printed instructions
```

## Inbound vs outbound mode

**Outbound-only** (default — leave `TALLY_PUBLIC_URL` blank):
- Polls the relay every 15 minutes for new packets in your slots
- Heartbeat keeps your node visible in `/holders`
- No incoming HTTP — works behind NAT, in a closet, on a Pi Zero

**Inbound** (set `TALLY_PUBLIC_URL=https://your.domain`):
- Also accepts real-time packet pushes from the relay
- PWA clients can query you directly: `GET /buckets/:id/packets`
- Reduces relay load + keeps Tally alive if the relay is slow/down

To upgrade from outbound to inbound:
1. Get a public URL (reverse proxy, Tailscale Funnel, Cloudflare Tunnel, etc.)
2. Open `TALLY_LISTEN_PORT` (default 7894) inbound
3. Set `TALLY_PUBLIC_URL` in `.env`
4. Restart

## Security

- `data/identity.json` is your node's permanent signing key — **do not commit, share, or back up to cloud storage**. Lose it = your node's identity is gone (you can always create a new one).
- The daemon signs every register/leave request. Only you can leave your node.
- Incoming packets (inbound mode) are Ed25519-verified before insertion.

## Troubleshooting

- **`better-sqlite3` install fails on Raspberry Pi** — build tools needed: `sudo apt install build-essential python3`
- **Permission denied on `identity.json`** — the scaffolder tries to `chmod 600`; on Windows this is a no-op, so lock it down via NTFS permissions manually if multi-user
- **Relay registration fails** — check `TALLY_RELAY_URL` is reachable, check your clock is within 5 minutes of server time (signature freshness window)

## License

MIT
