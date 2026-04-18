/**
 * Optional inbound HTTP server — started only when TALLY_PUBLIC_URL is set.
 *
 *   GET  /health                  → { ok, node_id, stats }
 *   GET  /info                    → full holder status
 *   POST /packets                 → accept a signed packet (verify + insert)
 *   GET  /buckets/:id/packets     → direct DHT query
 *
 * The server does NOT require request-level auth — packets carry their own
 * Ed25519 signature (verified per-packet), and reads are public.
 */

import http from "node:http";
import {
  upsertPackets,
  upsertBuckets,
  getPacketsForBucket,
  rowToPacket,
  stats,
  getMeta,
  getBucket,
  type HolderDb,
  type IncomingPacket,
} from "./storage.js";
import { verifyPacketSignature, bucketToSlot, type Identity } from "./crypto.js";

const FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

function respond(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function extractBucketId(pathname: string): string | null {
  const m = pathname.match(/^\/buckets\/([^/]+)\/packets\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/* ── startServer ────────────────────────────────────────── */

export async function startServer(
  port: number,
  db: HolderDb,
  identity: Identity,
): Promise<() => Promise<void>> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const { pathname } = url;
    const method = req.method || "GET";

    if (method === "OPTIONS") {
      respond(res, 204, {});
      return;
    }

    try {
      if (method === "GET" && pathname === "/health") {
        respond(res, 200, { ok: true, node_id: process.env.TALLY_NODE_ID || null, stats: stats(db) });
        return;
      }

      if (method === "GET" && pathname === "/info") {
        respond(res, 200, {
          ok: true,
          node_id: process.env.TALLY_NODE_ID || null,
          agent_id: identity.agentId,
          relay: process.env.TALLY_RELAY_URL || null,
          public_url: process.env.TALLY_PUBLIC_URL || null,
          last_sync_at: getMeta(db, "last_sync_at"),
          last_table_version: getMeta(db, "last_table_version"),
          stats: stats(db),
        });
        return;
      }

      if (method === "POST" && pathname === "/packets") {
        const body = await readBody(req);
        if (!body.bucket_id || !body.agent_id || !body.signature || !body.public_key) {
          respond(res, 400, { error: "bucket_id, agent_id, public_key, signature required" });
          return;
        }
        if (typeof body.ts !== "number" || Math.abs(Date.now() - body.ts) > FRESHNESS_WINDOW_MS) {
          respond(res, 400, { error: "ts missing or outside freshness window" });
          return;
        }
        if (!verifyPacketSignature(body)) {
          respond(res, 401, { error: "signature verification failed" });
          return;
        }

        const packet: IncomingPacket = {
          bucket_id: body.bucket_id,
          agent_id: body.agent_id,
          public_key: body.public_key,
          signal: body.signal,
          confidence: body.confidence,
          insight: body.insight,
          context: body.context,
          metrics: body.metrics,
          template_data: body.template_data,
          optional_metadata: body.optional_metadata,
          ts: body.ts,
          signature: body.signature,
        };

        if (!getBucket(db, body.bucket_id) && body.bucket_path) {
          upsertBuckets(db, [{ bucket_id: body.bucket_id, path: body.bucket_path }]);
        }

        const applied = upsertPackets(db, [packet]);
        respond(res, 200, { ok: true, applied, slot: body.bucket_path ? bucketToSlot(body.bucket_path) : null });
        return;
      }

      if (method === "GET") {
        const bucketId = extractBucketId(pathname);
        if (bucketId) {
          const rows = getPacketsForBucket(db, bucketId);
          const bucket = getBucket(db, bucketId);
          respond(res, 200, {
            bucket_id: bucketId,
            bucket: bucket ? { path: bucket.path, slot: bucket.slot, title: bucket.title, description: bucket.description } : null,
            packets: rows.map(rowToPacket),
            count: rows.length,
          });
          return;
        }
      }

      respond(res, 404, { error: `no route for ${method} ${pathname}` });
    } catch (err) {
      console.error("[tally-holder] server error:", err);
      respond(res, 500, { error: (err as Error).message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
