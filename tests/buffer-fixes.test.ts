import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

type Write = (this: Buffer, string: string, offset?: number, length?: number) => number;
const proto = Buffer.prototype as unknown as Record<string, Write>;

describe("Buffer write shim", () => {
  it("lets protobuf-style writes with an offset and no length succeed on a Workers-style Buffer", async () => {
    // Mimic the Workers runtime: `length` defaults to the whole buffer and is then range-checked.
    const nodeWrite = proto.utf8Write;
    proto.utf8Write = function (this: Buffer, string: string, offset = 0, length = this.length) {
      if (length > this.length - offset) throw new RangeError(`length must be <= ${this.length - offset}, received ${length}`);
      return nodeWrite.call(this, string, offset, length);
    };
    try {
      expect(() => Buffer.alloc(10).utf8Write("abcdef", 2)).toThrow(RangeError);
      await import("../src/shims/buffer-fixes.js");
      const buffer = Buffer.alloc(10);
      expect(buffer.utf8Write("abcdef", 2)).toBe(6);
      expect(buffer.toString("hex")).toBe("00006162636465660000");
      expect(buffer.utf8Write("zz", 0, 1)).toBe(1); // an explicit length is still respected
    } finally {
      proto.utf8Write = nodeWrite;
    }
  });

  it("encodes long text with protobufjs, which writes strings of 40+ characters through utf8Write", async () => {
    await import("../src/shims/buffer-fixes.js");
    const { proto: wa } = await import("baileys");
    for (const text of ["short", "x".repeat(40), "héllo wörld 🎉 ".repeat(200), "y".repeat(65_536)]) {
      expect(wa.Message.decode(wa.Message.encode({ conversation: text }).finish()).conversation).toBe(text);
    }
  });
});
