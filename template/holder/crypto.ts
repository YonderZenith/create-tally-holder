/**
 * Ed25519 keypair ops + canonical JSON signing (Node counterpart to qis-mobile/src/core/crypto.ts).
 * Uses node:crypto (not Web Crypto). Canonical payload format is byte-identical:
 *   JSON.stringify(body, Object.keys(body).sort())
 * so signatures round-trip through the relay's verifyEd25519Signed().
 */

import crypto from "node:crypto";
import fs from "node:fs";

export type Identity = {
  agentId: string;
  publicKeyHex: string;   // SPKI DER → hex
  privateKeyPem: string;  // PKCS8 PEM
};

/* ── Hex helpers ────────────────────────────────────────── */

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/* ── Identity ───────────────────────────────────────────── */

export function loadIdentity(filePath: string): Identity {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!raw.agent_id || !raw.public_key || !raw.private_key_pem) {
    throw new Error(`identity file ${filePath} missing required fields`);
  }
  return {
    agentId: raw.agent_id,
    publicKeyHex: raw.public_key,
    privateKeyPem: raw.private_key_pem,
  };
}

export function deriveAgentId(publicKeyHex: string): string {
  return crypto.createHash("sha256").update(publicKeyHex).digest("hex").slice(0, 16);
}

/* ── Canonical JSON ─────────────────────────────────────── */

export function canonicalJson(obj: Record<string, any>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

/* ── Sign / Verify ──────────────────────────────────────── */

/**
 * Sign a body and return a new object with `signature` (hex) appended.
 * Any existing `signature` on the input is stripped before signing.
 */
export function signBody<T extends Record<string, any>>(
  body: T,
  privateKeyPem: string,
): T & { signature: string } {
  const { signature: _drop, ...rest } = body as Record<string, any>;
  const payload = canonicalJson(rest);
  const privateKey = crypto.createPrivateKey({
    key: privateKeyPem,
    format: "pem",
    type: "pkcs8",
  });
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), privateKey);
  return { ...(rest as T), signature: sig.toString("hex") };
}

/**
 * Verify a signed body. Expects `public_key` (SPKI hex) and `signature` (hex) fields.
 */
export function verifySignedBody(body: Record<string, any>): boolean {
  try {
    if (!body.public_key || !body.signature) return false;
    const { signature, ...rest } = body;
    const payload = canonicalJson(rest);
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(body.public_key, "hex"),
      format: "der",
      type: "spki",
    });
    return crypto.verify(
      null,
      Buffer.from(payload, "utf8"),
      publicKey,
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

/* ── Relay request builders ─────────────────────────────── */

export function buildSignedRegister(
  identity: Identity,
  nodeId: string,
  url: string,
  agentName?: string,
): Record<string, any> {
  const body: Record<string, any> = {
    node_id: nodeId,
    url,
    agent_id: identity.agentId,
    public_key: identity.publicKeyHex,
    ts: Date.now(),
  };
  if (agentName) body.agent_name = agentName;
  return signBody(body, identity.privateKeyPem);
}

export function buildSignedLeave(identity: Identity, nodeId: string): Record<string, any> {
  const body = {
    node_id: nodeId,
    agent_id: identity.agentId,
    public_key: identity.publicKeyHex,
    ts: Date.now(),
  };
  return signBody(body, identity.privateKeyPem);
}

/* ── Packet verification (inbound mode) ─────────────────── */

/**
 * Verify an incoming signed packet. The packet format matches qis-mobile's
 * buildSignedPacket output: the whole packet (minus `signature`) is signed
 * in canonical JSON form using the `public_key` field (SPKI hex).
 */
export function verifyPacketSignature(packet: Record<string, any>): boolean {
  return verifySignedBody(packet);
}

/* ── Bucket routing ─────────────────────────────────────── */

export function sha256Bytes(input: string): Uint8Array {
  return Uint8Array.from(crypto.createHash("sha256").update(input, "utf8").digest());
}

/**
 * bucketToSlot — first byte of sha256(bucket_path). Matches qis-mobile and relay.
 */
export function bucketToSlot(bucketPath: string): number {
  return sha256Bytes(bucketPath)[0];
}
