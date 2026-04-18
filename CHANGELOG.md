# create-tally-holder — Changelog

## v0.1.0 — 2026-04-18

**Initial release.** Ship a Tally DHT holder in one command: `npx create-tally-holder my-node`.

### Package (`src/cli.ts`)
- Interactive scaffold: prompts for target dir, relay URL, node name, data dir, listen port, optional public URL.
- Non-interactive `--yes` / `-y` flag for scriptable deploys.
- Generates Ed25519 keypair via `node:crypto`, writes `data/identity.json` (0600 where supported).
- agent_id derived as `sha256(publicKeyHex).slice(0,16)` (matches relay's SPKI-collision-safe scheme).
- Emits `.env` with TALLY_RELAY_URL, TALLY_NODE_ID (name + short agent hash), TALLY_AGENT_ID, TALLY_DATA_DIR, TALLY_LISTEN_PORT, TALLY_PUBLIC_URL, TALLY_IDENTITY_PATH.

### Holder runtime (`template/holder/`)
- **`crypto.ts`** — port of qis-mobile crypto to `node:crypto`. Same canonical JSON signing format (`JSON.stringify(body, Object.keys(body).sort())`) so signatures round-trip through the relay. Helpers: `loadIdentity`, `signBody`, `verifySignedBody`, `buildSignedRegister`, `buildSignedLeave`, `verifyPacketSignature`, `bucketToSlot`.
- **`partition.ts`** — `expandTable` (byte-identical to qis-mobile), `computeOwnedSlots` (primary + replica), `computePrimarySlots`, `holdersForSlot`.
- **`storage.ts`** — better-sqlite3 wrapper. Schema: `buckets(bucket_id, path, slot, title, description, schema_json, created_at)`, `packets(bucket_id, agent_id, public_key, signal, confidence, insight, context, metrics, template_data, optional_metadata, ts, signature, received_at, PK(bucket_id, agent_id))`, `meta(key, value)`. Dedup via PK; `upsertPackets` replaces only when incoming `ts` is newer. `pruneForSlots` drops buckets + packets for slots no longer owned after rebalance.
- **`relay-client.ts`** — fetch-based HTTP client. `register` / `heartbeat` / `leave` / `partitions` / `syncSlots` / `listHolders`. Auto-retry once on 5xx / network error.
- **`daemon.ts`** — lifecycle orchestrator. Load identity → open DB → signed register → initial sync → heartbeat (2m) + sync (15m) loops → SIGTERM/SIGINT triggers signed `/holders/leave` → close DB → exit 0.
- **`server.ts`** — optional inbound HTTP server (only when `TALLY_PUBLIC_URL` is set). `GET /health`, `GET /info`, `POST /packets` (Ed25519 verify + freshness window + insert), `GET /buckets/:id/packets` (direct client query). No request-level auth — packets carry their own signatures; reads are public.

### Deploy artifacts (`template/deploy/`, `template/Dockerfile`)
- `deploy/tally-holder.service` — systemd unit with graceful SIGTERM shutdown (30s timeout) + `ProtectSystem=strict` hardening.
- `deploy/pm2.config.cjs` — PM2 ecosystem config with 20s `kill_timeout` for clean leave.
- `Dockerfile` — alpine-based, `tini` as PID 1 so `docker stop` delivers SIGTERM for graceful leave. Builds better-sqlite3 at install time, drops build deps.
- `deploy/README.md` — per-method deploy recipes (systemd, pm2, docker) + reverse-proxy example.

### Verification
- **12/12** crypto + partition round-trip checks against live relay (including tamper detection + signed register/leave).
- **18/18** storage smoke checks (insert, dedup via ts comparison, prune by slot set, meta round-trip).
- **11/11** server smoke checks (health, info, signed packet accept/reject tampered/reject stale, direct query).
- **12/12** multi-node partition rebalance checks against live relay (1-holder → 2-holder transition, graceful leave for both).
- **End-to-end daemon run**: registered with live relay, pulled 600 cohort-mode demo packets across 3 buckets in <2s, idled on heartbeat/sync loops, graceful leave via signed request.
