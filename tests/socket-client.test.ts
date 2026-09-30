import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { jidFromPhone, phoneFromJid, qrDataUrl } from "../src/protocol/socket-client";
import * as shim from "../src/shims/whatsapp-rust-bridge.js";

// The real package sits next to baileys in node_modules; it runs under Node (not on Workers), so
// it serves as the reference the Workers stand-in must match byte for byte.
const referencePath = join(dirname(realpathSync(join(process.cwd(), "node_modules", "baileys"))), "whatsapp-rust-bridge", "dist", "index.js");
const reference = await import(pathToFileURL(referencePath).href) as typeof shim;

const bytes = (length: number, seed: number) => Uint8Array.from({ length }, (_, i) => (i * 31 + seed * 17) & 0xff);

describe("whatsapp-rust-bridge stand-in", () => {
  it("matches the reference md5", () => {
    expect([...shim.md5(bytes(100, 1))]).toEqual([...reference.md5(bytes(100, 1))]);
  });

  it("matches the reference hkdf with and without salt", () => {
    for (const info of [{ info: "adv_secret" }, { salt: bytes(32, 2), info: "" }, { salt: bytes(32, 3), info: "WhatsApp Media Keys" }]) {
      for (const length of [32, 64, 112]) {
        expect([...shim.hkdf(bytes(32, 5), length, info)]).toEqual([...reference.hkdf(bytes(32, 5), length, info)]);
      }
    }
  });

  it("matches the reference app-state key expansion", () => {
    const mine = shim.expandAppStateKeys(bytes(32, 6));
    const theirs = reference.expandAppStateKeys(bytes(32, 6));
    for (const name of ["indexKey", "valueEncryptionKey", "valueMacKey", "snapshotMacKey", "patchMacKey"] as const) {
      expect([...mine[name]]).toEqual([...theirs[name]]);
    }
  });

  it("matches the reference LT hash across adds and subtracts", () => {
    const base = bytes(128, 7);
    const subtract = [bytes(32, 8), bytes(32, 9)];
    const add = [bytes(32, 10), bytes(32, 11), bytes(32, 12)];
    const mine = new shim.LTHashAntiTampering().subtractThenAdd(base, subtract, add);
    const theirs = new reference.LTHashAntiTampering().subtractThenAdd(base, subtract, add);
    expect([...mine]).toEqual([...theirs]);
    expect([...base]).toEqual([...bytes(128, 7)]); // input is not mutated
  });
});

describe("socket client helpers", () => {
  it("extracts phone numbers only from individual phone JIDs", () => {
    expect(phoneFromJid("15551234567@s.whatsapp.net")).toBe("15551234567");
    expect(phoneFromJid("15551234567:12@s.whatsapp.net")).toBe("15551234567");
    expect(phoneFromJid("123456789012345678@lid")).toBeNull();
    expect(phoneFromJid("120363000000000000@g.us")).toBeNull();
    expect(phoneFromJid("status@broadcast")).toBeNull();
    expect(phoneFromJid(null)).toBeNull();
  });

  it("builds a phone JID from an international number", () => {
    expect(jidFromPhone("+1 (555) 123-4567")).toBe("15551234567@s.whatsapp.net");
  });

  it("renders the QR payload as an SVG data URL", () => {
    const url = qrDataUrl("2@abc,def,ghi");
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(atob(url.split(",")[1])).toContain("<svg");
  });
});
