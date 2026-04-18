# create-tally-holder

**Run a Tally DHT holder node in one command.**

Tally is a public [QIS Protocol](https://tally.qisprotocol.com) network where anyone can define a problem, deposit structured observations, and query tight similarity-cohort tallies. Holders store and serve the data that makes it work.

## Quickstart

```bash
npx create-tally-holder my-holder
cd my-holder
npm install
npm start
```

That's it. You're a Tally holder.

## What it does

- Generates a fresh Ed25519 identity (your node's permanent keypair)
- Registers with the Tally relay via a signed request (no API key needed)
- Gets assigned a slice of the bucket space via the partition table
- Keeps a local SQLite copy of your slice, syncs every 15 minutes
- Heartbeats the relay every 2 minutes
- (Optional) Listens for direct client queries so the PWA can read from you when the relay is slow

## Modes

| Mode | What you provide | What you get |
|------|------------------|--------------|
| **Outbound-only** (default) | Nothing — just a running node | Data persistence, network count, partition assignment, archival |
| **Inbound** (full) | A public URL (e.g. `https://holder.example.com`) | Everything above + real-time push from relay + clients can query you directly |

You pick the mode during `npx create-tally-holder` setup. Outbound works behind NAT, in a closet, on a Pi Zero. Inbound needs a publicly reachable URL.

## Requirements

- Node.js ≥ 18
- ~100 MB disk for the local SQLite DB (grows with network size)
- Stable internet connection

## Deploy targets

Pre-built deploy artifacts in `deploy/` of your scaffolded directory:

- `deploy/tally-holder.service` — systemd unit (Raspberry Pi, Debian, Ubuntu)
- `deploy/pm2.config.cjs` — PM2 process manager
- `Dockerfile` — containerized (at scaffold root)

See `my-holder/README.md` (generated) for step-by-step guides.

## License

MIT © Yonder Zenith LLC
