/**
 * Stand-in for the `whatsapp-rust-bridge` package (aliased in wrangler.toml). The real package
 * compiles its WebAssembly from inline bytes at load time, which the Workers runtime forbids.
 * The WhatsApp client library only uses these four exports, all expressible with node:crypto.
 */
import { createHash, hkdfSync } from "node:crypto";

export function md5(buffer) { return new Uint8Array(createHash("md5").update(buffer).digest()); }

export function hkdf(buffer, expandedLength, info = {}) {
  const salt = info.salt ?? new Uint8Array(0);
  const label = new TextEncoder().encode(info.info ?? "");
  return new Uint8Array(hkdfSync("sha256", buffer, salt, label, expandedLength));
}

export function expandAppStateKeys(keyData) {
  const expanded = hkdf(keyData, 160, { info: "WhatsApp Mutation Keys" });
  return {
    indexKey: expanded.slice(0, 32),
    valueEncryptionKey: expanded.slice(32, 64),
    valueMacKey: expanded.slice(64, 96),
    snapshotMacKey: expanded.slice(96, 128),
    patchMacKey: expanded.slice(128, 160),
  };
}

/** Summation hash over 16-bit little-endian words; each item is first expanded to 128 bytes. */
export class LTHashAntiTampering {
  subtractThenAdd(base, subtract, add) {
    const out = new Uint8Array(base);
    const view = new DataView(out.buffer);
    const apply = (item, sign) => {
      const expanded = new DataView(hkdf(item, out.length, { info: "WhatsApp Patch Integrity" }).buffer);
      for (let i = 0; i + 1 < out.length; i += 2) view.setUint16(i, (view.getUint16(i, true) + sign * expanded.getUint16(i, true)) & 0xffff, true);
    };
    for (const item of subtract) apply(item, -1);
    for (const item of add) apply(item, 1);
    return out;
  }
}
