/**
 * Tally holder daemon — orchestrator.
 *
 * Lifecycle:
 *   1. Load identity + config
 *   2. Open local SQLite
 *   3. Register with relay (signed)
 *   4. Immediate sync of currently-owned slots
 *   5. Heartbeat every 2m
 *   6. Refresh partitions + sync every 15m
 *   7. Optional inbound HTTP server if TALLY_PUBLIC_URL is set
 *   8. SIGTERM/SIGINT → signed /holders/leave → close DB → exit
 */

import path from "node:path";
import { loadIdentity } from "./crypto.js";
import {
  openDb,
  upsertBuckets,
  upsertPackets,
  pruneForSlots,
  stats,
  getMeta,
  setMeta,
  type IncomingBucket,
  type IncomingPacket,
  type HolderDb,
} from "./storage.js";
import {
  register,
  heartbeat,
  leave,
  partitions,
  syncSlots,
  type SyncResponse,
} from "./relay-client.js";
import {
  expandTable,
  computeOwnedSlots,
  type PartitionTable,
  type CompactTable,
} from "./partition.js";

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;
const SYNC_INTERVAL_MS = 15 * 60 * 1000;

type Config = {
  relayUrl: string;
  nodeId: string;
  nodeName: string;
  dataDir: string;
  identityPath: string;
  listenPort: number;
  publicUrl: string | null;
};

function loadConfig(): Config {
  const relayUrl = process.env.TALLY_RELAY_URL;
  const nodeId = process.env.TALLY_NODE_ID;
  const nodeName = process.env.TALLY_NODE_NAME || "tally-holder";
  const dataDir = process.env.TALLY_DATA_DIR || "./data";
  const identityPath = process.env.TALLY_IDENTITY_PATH || path.join(dataDir, "identity.json");
  const listenPort = parseInt(process.env.TALLY_LISTEN_PORT || "7894", 10);
  const publicUrl = (process.env.TALLY_PUBLIC_URL || "").trim() || null;

  if (!relayUrl) throw new Error("TALLY_RELAY_URL not set in .env");
  if (!nodeId) throw new Error("TALLY_NODE_ID not set in .env");
  return { relayUrl, nodeId, nodeName, dataDir, identityPath, listenPort, publicUrl };
}

/* ── Wire → storage translation ─────────────────────────── */

function parseIncomingBuckets(raw: any[]): IncomingBucket[] {
  return raw.map((b) => ({
    bucket_id: b.bucket_id,
    path: b.path,
    title: b.title || undefined,
    description: b.description || undefined,
  }));
}

function parseIncomingPackets(raw: any[]): IncomingPacket[] {
  return raw.map((p) => ({
    bucket_id: p.bucket_id,
    agent_id: p.agent_id,
    public_key: p.public_key,
    signal: p.signal,
    confidence: p.confidence,
    insight: p.insight,
    context: typeof p.context === "string" ? safeJsonParse(p.context) : p.context,
    metrics: typeof p.metrics === "string" ? safeJsonParse(p.metrics) : p.metrics,
    ts: p.ts,
    signature: p.signature,
  }));
}

function safeJsonParse(text: string): Record<string, any> | undefined {
  try { return JSON.parse(text); } catch { return undefined; }
}

/* ── Sync one cycle ─────────────────────────────────────── */

async function runSync(
  db: HolderDb,
  cfg: Config,
  table: PartitionTable,
): Promise<{ buckets: number; packets: number; ownedSlots: number; dropped: { bucketsDropped: number; packetsDropped: number } }> {
  const owned = computeOwnedSlots(table, cfg.nodeId);
  if (owned.length === 0) {
    console.log(`[tally-holder] partition says this node owns 0 slots (table v${table.version}) — skipping sync`);
    return { buckets: 0, packets: 0, ownedSlots: 0, dropped: { bucketsDropped: 0, packetsDropped: 0 } };
  }

  const since = getMeta(db, "last_sync_at") || undefined;
  let resp: SyncResponse;
  try {
    resp = await syncSlots(cfg.relayUrl, owned, since);
  } catch (err) {
    console.error("[tally-holder] syncSlots failed:", (err as Error).message);
    return { buckets: 0, packets: 0, ownedSlots: owned.length, dropped: { bucketsDropped: 0, packetsDropped: 0 } };
  }

  const buckets = parseIncomingBuckets(resp.buckets);
  const packets = parseIncomingPackets(resp.packets);
  upsertBuckets(db, buckets);
  const applied = upsertPackets(db, packets);
  const dropped = pruneForSlots(db, owned);

  setMeta(db, "last_sync_at", new Date().toISOString());
  setMeta(db, "last_table_version", String(table.version));

  return { buckets: resp.total_buckets, packets: applied, ownedSlots: owned.length, dropped };
}

/* ── Main ───────────────────────────────────────────────── */

export async function run(): Promise<void> {
  const cfg = loadConfig();
  const identity = loadIdentity(cfg.identityPath);

  console.log("");
  console.log(`[tally-holder] node_id:   ${cfg.nodeId}`);
  console.log(`[tally-holder] agent_id:  ${identity.agentId}`);
  console.log(`[tally-holder] relay:     ${cfg.relayUrl}`);
  console.log(`[tally-holder] data_dir:  ${cfg.dataDir}`);
  console.log(`[tally-holder] mode:      ${cfg.publicUrl ? "inbound+outbound" : "outbound-only"}`);
  console.log("");

  const dbPath = path.resolve(cfg.dataDir, "holder.db");
  const db = openDb(dbPath);

  // Register
  const registerUrl = cfg.publicUrl || `outbound://${identity.agentId}`;
  let compact: CompactTable;
  try {
    const res = await register(cfg.relayUrl, identity, cfg.nodeId, registerUrl, identity.agentId);
    compact = res.table;
    console.log(`[tally-holder] registered with relay (table v${compact.v}, ${compact.holders.length} holders)`);
  } catch (err) {
    console.error("[tally-holder] registration failed:", (err as Error).message);
    db.close();
    process.exit(1);
  }

  let table = expandTable(compact);
  const initial = await runSync(db, cfg, table);
  console.log(
    `[tally-holder] initial sync: ${initial.buckets} buckets, ${initial.packets} packets (slots=${initial.ownedSlots})`,
  );
  const s = stats(db);
  console.log(`[tally-holder] local db:  ${s.buckets} buckets, ${s.packets} packets, ${s.slotsCovered} slots`);

  // Inbound server
  let stopServer: (() => Promise<void>) | null = null;
  if (cfg.publicUrl) {
    const { startServer } = await import("./server.js");
    try {
      stopServer = await startServer(cfg.listenPort, db, identity);
      console.log(`[tally-holder] inbound server listening on :${cfg.listenPort} (public=${cfg.publicUrl})`);
    } catch (err) {
      console.error("[tally-holder] inbound server failed to start:", (err as Error).message);
    }
  }

  // Heartbeat loop
  const hbTimer = setInterval(async () => {
    try {
      const { table_version } = await heartbeat(cfg.relayUrl, cfg.nodeId);
      const last = parseInt(getMeta(db, "last_table_version") || "0", 10);
      if (table_version !== last) {
        console.log(`[tally-holder] table version bumped ${last} → ${table_version}, scheduling sync`);
      }
    } catch (err) {
      console.warn("[tally-holder] heartbeat failed:", (err as Error).message);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Sync loop
  const syncTimer = setInterval(async () => {
    try {
      const fresh = await partitions(cfg.relayUrl);
      table = expandTable(fresh);
      const result = await runSync(db, cfg, table);
      const pruned = result.dropped.bucketsDropped + result.dropped.packetsDropped;
      console.log(
        `[tally-holder] sync: +${result.packets} packets, slots=${result.ownedSlots}${pruned ? `, pruned ${result.dropped.bucketsDropped}b/${result.dropped.packetsDropped}p` : ""}`,
      );
    } catch (err) {
      console.warn("[tally-holder] sync cycle failed:", (err as Error).message);
    }
  }, SYNC_INTERVAL_MS);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[tally-holder] ${sig} received — leaving relay gracefully`);
    clearInterval(hbTimer);
    clearInterval(syncTimer);
    try {
      if (stopServer) await stopServer();
      await leave(cfg.relayUrl, identity, cfg.nodeId);
      console.log("[tally-holder] relay /holders/leave ok");
    } catch (err) {
      console.warn("[tally-holder] leave failed (relay may be down):", (err as Error).message);
    }
    try { db.close(); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT",  () => void shutdown("SIGINT"));

  console.log("[tally-holder] running — heartbeat 2m, sync 15m. Ctrl-C to exit.");
}
