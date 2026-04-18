/**
 * better-sqlite3 wrapper for the holder's local copy of buckets + packets.
 *
 * Packet dedup: PRIMARY KEY (bucket_id, agent_id). An agent can update their
 * packet — later writes replace older ones (INSERT OR REPLACE).
 *
 * Slot ownership: each bucket is tagged with its slot (0-255). After a
 * partition rebalance, pruneForSlots() drops buckets + packets the holder
 * is no longer responsible for.
 */

import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { bucketToSlot } from "./crypto.js";

export type HolderDb = Db;

export type BucketRow = {
  bucket_id: string;
  path: string;
  slot: number;
  title: string | null;
  description: string | null;
  schema_json: string | null;
  created_at: number;
};

export type PacketRow = {
  bucket_id: string;
  agent_id: string;
  public_key: string;
  signal: string;
  confidence: number;
  insight: string;
  context: string | null;            // JSON
  metrics: string | null;            // JSON
  template_data: string | null;      // JSON
  optional_metadata: string | null;  // JSON
  ts: number;
  signature: string;
  received_at: number;
};

export type IncomingBucket = {
  bucket_id: string;
  path: string;
  title?: string;
  description?: string;
  schema?: Record<string, any>;
  created_at?: number;
};

export type IncomingPacket = {
  bucket_id: string;
  agent_id: string;
  public_key: string;
  signal: string;
  confidence: number;
  insight: string;
  context?: Record<string, any>;
  metrics?: Record<string, any>;
  template_data?: Record<string, any>;
  optional_metadata?: Record<string, any>;
  ts: number;
  signature: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS buckets (
  bucket_id    TEXT PRIMARY KEY,
  path         TEXT NOT NULL,
  slot         INTEGER NOT NULL,
  title        TEXT,
  description  TEXT,
  schema_json  TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_buckets_slot ON buckets(slot);
CREATE INDEX IF NOT EXISTS idx_buckets_path ON buckets(path);

CREATE TABLE IF NOT EXISTS packets (
  bucket_id          TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  public_key         TEXT NOT NULL,
  signal             TEXT NOT NULL,
  confidence         REAL NOT NULL,
  insight            TEXT NOT NULL,
  context            TEXT,
  metrics            TEXT,
  template_data      TEXT,
  optional_metadata  TEXT,
  ts                 INTEGER NOT NULL,
  signature          TEXT NOT NULL,
  received_at        INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_packets_bucket ON packets(bucket_id);
CREATE INDEX IF NOT EXISTS idx_packets_agent ON packets(agent_id);
CREATE INDEX IF NOT EXISTS idx_packets_ts ON packets(ts);

CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

/* ── Open / schema migration ────────────────────────────── */

export function openDb(dbPath: string): HolderDb {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

/* ── Buckets ────────────────────────────────────────────── */

export function upsertBuckets(db: HolderDb, buckets: IncomingBucket[]): number {
  if (buckets.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO buckets (bucket_id, path, slot, title, description, schema_json, created_at)
    VALUES (@bucket_id, @path, @slot, @title, @description, @schema_json, @created_at)
    ON CONFLICT(bucket_id) DO UPDATE SET
      path        = excluded.path,
      slot        = excluded.slot,
      title       = excluded.title,
      description = excluded.description,
      schema_json = excluded.schema_json
  `);
  const now = Date.now();
  const tx = db.transaction((rows: IncomingBucket[]) => {
    for (const b of rows) {
      stmt.run({
        bucket_id: b.bucket_id,
        path: b.path,
        slot: bucketToSlot(b.path),
        title: b.title ?? null,
        description: b.description ?? null,
        schema_json: b.schema ? JSON.stringify(b.schema) : null,
        created_at: b.created_at ?? now,
      });
    }
  });
  tx(buckets);
  return buckets.length;
}

export function getBucket(db: HolderDb, bucketId: string): BucketRow | null {
  return (db.prepare("SELECT * FROM buckets WHERE bucket_id = ?").get(bucketId) as BucketRow) ?? null;
}

export function listBucketsForSlots(db: HolderDb, slots: number[]): BucketRow[] {
  if (slots.length === 0) return [];
  const placeholders = slots.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM buckets WHERE slot IN (${placeholders})`)
    .all(...slots) as BucketRow[];
}

/* ── Packets ────────────────────────────────────────────── */

export function upsertPackets(db: HolderDb, packets: IncomingPacket[]): number {
  if (packets.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO packets (
      bucket_id, agent_id, public_key, signal, confidence, insight,
      context, metrics, template_data, optional_metadata,
      ts, signature, received_at
    ) VALUES (
      @bucket_id, @agent_id, @public_key, @signal, @confidence, @insight,
      @context, @metrics, @template_data, @optional_metadata,
      @ts, @signature, @received_at
    )
    ON CONFLICT(bucket_id, agent_id) DO UPDATE SET
      public_key        = excluded.public_key,
      signal            = excluded.signal,
      confidence        = excluded.confidence,
      insight           = excluded.insight,
      context           = excluded.context,
      metrics           = excluded.metrics,
      template_data     = excluded.template_data,
      optional_metadata = excluded.optional_metadata,
      ts                = excluded.ts,
      signature         = excluded.signature,
      received_at       = excluded.received_at
    WHERE excluded.ts > packets.ts
  `);
  const now = Date.now();
  let inserted = 0;
  const tx = db.transaction((rows: IncomingPacket[]) => {
    for (const p of rows) {
      const result = stmt.run({
        bucket_id: p.bucket_id,
        agent_id: p.agent_id,
        public_key: p.public_key,
        signal: p.signal,
        confidence: p.confidence,
        insight: p.insight,
        context: p.context ? JSON.stringify(p.context) : null,
        metrics: p.metrics ? JSON.stringify(p.metrics) : null,
        template_data: p.template_data ? JSON.stringify(p.template_data) : null,
        optional_metadata: p.optional_metadata ? JSON.stringify(p.optional_metadata) : null,
        ts: p.ts,
        signature: p.signature,
        received_at: now,
      });
      if (result.changes > 0) inserted++;
    }
  });
  tx(packets);
  return inserted;
}

export function getPacketsForBucket(db: HolderDb, bucketId: string): PacketRow[] {
  return db
    .prepare("SELECT * FROM packets WHERE bucket_id = ? ORDER BY ts ASC")
    .all(bucketId) as PacketRow[];
}

export function countPacketsForBucket(db: HolderDb, bucketId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as c FROM packets WHERE bucket_id = ?")
    .get(bucketId) as { c: number };
  return row.c;
}

/**
 * Deserialize a PacketRow back into the on-the-wire signed-packet shape.
 * Use when responding to GET /buckets/:id/packets.
 */
export function rowToPacket(row: PacketRow): IncomingPacket {
  return {
    bucket_id: row.bucket_id,
    agent_id: row.agent_id,
    public_key: row.public_key,
    signal: row.signal,
    confidence: row.confidence,
    insight: row.insight,
    context: row.context ? JSON.parse(row.context) : undefined,
    metrics: row.metrics ? JSON.parse(row.metrics) : undefined,
    template_data: row.template_data ? JSON.parse(row.template_data) : undefined,
    optional_metadata: row.optional_metadata ? JSON.parse(row.optional_metadata) : undefined,
    ts: row.ts,
    signature: row.signature,
  };
}

/* ── Rebalance pruning ──────────────────────────────────── */

/**
 * Drop buckets + packets for slots the holder no longer owns.
 * Called after the partition table shifts on a sync loop.
 */
export function pruneForSlots(db: HolderDb, keepSlots: number[]): { bucketsDropped: number; packetsDropped: number } {
  const keepSet = new Set(keepSlots);
  const allBuckets = db.prepare("SELECT bucket_id, slot FROM buckets").all() as { bucket_id: string; slot: number }[];
  const toDrop = allBuckets.filter((b) => !keepSet.has(b.slot)).map((b) => b.bucket_id);
  if (toDrop.length === 0) return { bucketsDropped: 0, packetsDropped: 0 };

  const placeholders = toDrop.map(() => "?").join(",");
  const tx = db.transaction(() => {
    const pktRes = db.prepare(`DELETE FROM packets WHERE bucket_id IN (${placeholders})`).run(...toDrop);
    const bktRes = db.prepare(`DELETE FROM buckets WHERE bucket_id IN (${placeholders})`).run(...toDrop);
    return { bucketsDropped: bktRes.changes, packetsDropped: pktRes.changes };
  });
  return tx();
}

/* ── Meta (sync cursors, etc.) ──────────────────────────── */

export function getMeta(db: HolderDb, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: HolderDb, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

/* ── Stats ──────────────────────────────────────────────── */

export function stats(db: HolderDb): { buckets: number; packets: number; slotsCovered: number } {
  const b = db.prepare("SELECT COUNT(*) as c FROM buckets").get() as { c: number };
  const p = db.prepare("SELECT COUNT(*) as c FROM packets").get() as { c: number };
  const s = db.prepare("SELECT COUNT(DISTINCT slot) as c FROM buckets").get() as { c: number };
  return { buckets: b.c, packets: p.c, slotsCovered: s.c };
}
