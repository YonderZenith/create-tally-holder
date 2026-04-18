/**
 * Partition table — maps bucket paths to slot numbers (0-255) and slots to holders.
 * Ported from qis-mobile/src/core/partition-cache.ts expandTable(), with added
 * holder-side helpers (computeOwnedSlots, computePrimarySlots).
 *
 * No IndexedDB: holders keep the expanded table in-memory and refresh via the
 * sync loop (daemon.ts). On process restart, daemon fetches fresh from relay.
 */

const SLOT_COUNT = 256;

/* ── Relay wire format ──────────────────────────────────── */

export type CompactHolder = {
  id: string;
  name: string;
  url: string;
  pos: number;
};

export type CompactGroup = {
  s: number;         // slot_start
  e: number;         // slot_end
  h: string[];       // holder node_ids (primary first)
};

export type CompactTable = {
  v: number;         // version
  r: number;         // replication factor
  ts: string;        // updated_at
  relay: string;     // relay URL
  holders: CompactHolder[];
  groups: CompactGroup[];
};

/* ── Expanded in-memory form ────────────────────────────── */

export type HolderNode = {
  node_id: string;
  agent_name: string;
  url: string;
  ring_position: number;
  slots_owned: number;       // primary-only count (matches qis-mobile)
  joined_at: string;
  last_heartbeat: string;
};

export type PartitionGroup = {
  group_id: number;
  slot_start: number;
  slot_end: number;
  holders: string[];
};

export type PartitionTable = {
  version: number;
  replication_factor: number;
  slot_count: number;
  holders: HolderNode[];
  slot_map: string[][];      // index = slot 0-255, value = holder node_ids (primary first)
  groups: PartitionGroup[];
  relay_url: string;
  updated_at: string;
};

/* ── Expand ─────────────────────────────────────────────── */

/**
 * Expand a compact table to full PartitionTable.
 * Byte-for-byte match with qis-mobile's expandTable so both sides route identically.
 */
export function expandTable(compact: CompactTable): PartitionTable {
  const holders: HolderNode[] = compact.holders.map((h) => ({
    node_id: h.id,
    agent_name: h.name,
    url: h.url,
    ring_position: h.pos,
    slots_owned: 0,
    joined_at: compact.ts,
    last_heartbeat: compact.ts,
  }));

  const slotMap: string[][] = new Array(SLOT_COUNT).fill(null).map(() => [] as string[]);
  for (const g of compact.groups) {
    for (let s = g.s; s <= g.e; s++) {
      slotMap[s] = [...g.h];
    }
  }

  for (const entry of slotMap) {
    if (entry.length > 0) {
      const primary = entry[0];
      const h = holders.find((n) => n.node_id === primary);
      if (h) h.slots_owned++;
    }
  }

  const groups: PartitionGroup[] = compact.groups.map((g, i) => ({
    group_id: i,
    slot_start: g.s,
    slot_end: g.e,
    holders: g.h,
  }));

  return {
    version: compact.v,
    replication_factor: compact.r,
    slot_count: SLOT_COUNT,
    holders,
    slot_map: slotMap,
    groups,
    relay_url: compact.relay,
    updated_at: compact.ts,
  };
}

/* ── Holder-side routing helpers ────────────────────────── */

/**
 * All slots this node must store data for — primary OR replica position.
 * This is the set of slots the holder should pull/serve packets for.
 */
export function computeOwnedSlots(table: PartitionTable, nodeId: string): number[] {
  const slots: number[] = [];
  for (let i = 0; i < table.slot_map.length; i++) {
    if (table.slot_map[i].includes(nodeId)) slots.push(i);
  }
  return slots;
}

/**
 * Only slots where this node is the PRIMARY (position 0 in slot_map[i]).
 * Useful for write-ordering decisions.
 */
export function computePrimarySlots(table: PartitionTable, nodeId: string): number[] {
  const slots: number[] = [];
  for (let i = 0; i < table.slot_map.length; i++) {
    if (table.slot_map[i][0] === nodeId) slots.push(i);
  }
  return slots;
}

/**
 * Holders (primary + replicas) responsible for a given slot.
 */
export function holdersForSlot(table: PartitionTable, slot: number): HolderNode[] {
  const ids = table.slot_map[slot] || [];
  return ids
    .map((id) => table.holders.find((h) => h.node_id === id))
    .filter((h): h is HolderNode => !!h);
}
