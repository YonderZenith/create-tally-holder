/**
 * HTTP client for the Tally relay. Fetch-based; no external HTTP dep.
 * Every call retries once on 5xx / network error; the daemon's loops
 * handle longer-lived failures by sleeping and retrying next cycle.
 */

import { buildSignedRegister, buildSignedLeave, type Identity } from "./crypto.js";
import type { CompactTable, CompactHolder } from "./partition.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

async function request(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<any> {
  const url = baseUrl.replace(/\/$/, "") + path;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init.headers || {}) },
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if (!res.ok) {
        const err = new Error(`[relay] ${init.method || "GET"} ${path} → ${res.status} ${body.error || text.slice(0, 200)}`);
        (err as any).status = res.status;
        (err as any).body = body;
        throw err;
      }
      return body;
    } catch (err) {
      lastErr = err;
      if ((err as any).status && (err as any).status < 500) throw err; // don't retry 4xx
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

/* ── Holder lifecycle ───────────────────────────────────── */

export async function register(
  relayUrl: string,
  identity: Identity,
  nodeId: string,
  publicUrl: string,
  agentName?: string,
): Promise<{ ok: true; table: CompactTable }> {
  const body = buildSignedRegister(identity, nodeId, publicUrl, agentName);
  return request(relayUrl, "/holders/register", { method: "POST", body: JSON.stringify(body) });
}

export async function heartbeat(
  relayUrl: string,
  nodeId: string,
): Promise<{ ok: true; table_version: number }> {
  return request(relayUrl, "/holders/heartbeat", {
    method: "POST",
    body: JSON.stringify({ node_id: nodeId }),
  });
}

export async function leave(
  relayUrl: string,
  identity: Identity,
  nodeId: string,
): Promise<{ ok: true }> {
  const body = buildSignedLeave(identity, nodeId);
  return request(relayUrl, "/holders/leave", { method: "POST", body: JSON.stringify(body) });
}

/* ── Partitioning ───────────────────────────────────────── */

export async function partitions(relayUrl: string): Promise<CompactTable> {
  return request(relayUrl, "/partitions");
}

export async function listHolders(relayUrl: string): Promise<{
  holder_count: number;
  replication_factor: number;
  holders: CompactHolder[];
}> {
  return request(relayUrl, "/holders");
}

/* ── Sync ───────────────────────────────────────────────── */

export type SyncResponse = {
  slots_requested: number;
  buckets: Array<Record<string, JsonValue>>;
  packets: Array<Record<string, JsonValue>>;
  total_buckets: number;
  total_packets: number;
};

/**
 * Pull buckets + packets whose path hashes to one of `slots`.
 * `since` is an ISO timestamp — relay returns only packets with created_at > since.
 */
export async function syncSlots(
  relayUrl: string,
  slots: number[],
  since?: string,
): Promise<SyncResponse> {
  if (slots.length === 0) {
    return { slots_requested: 0, buckets: [], packets: [], total_buckets: 0, total_packets: 0 };
  }
  const qs = new URLSearchParams({ slots: slots.join(",") });
  if (since) qs.set("since", since);
  return request(relayUrl, `/sync/slots?${qs.toString()}`);
}
