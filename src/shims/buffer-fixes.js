/**
 * Workers' Buffer.prototype.utf8Write (and its siblings) default the `length` argument to the
 * whole buffer instead of "the rest of the buffer after `offset`" as Node does, so any call with an
 * offset and no length throws ERR_OUT_OF_RANGE. protobufjs writes every string of 40+ characters
 * that way, which made every message longer than ~40 characters fail to encrypt
 * ("All encryptions failed"). Restore Node's default before the WhatsApp library runs.
 */
import { Buffer } from "node:buffer";

for (const name of ["utf8Write", "latin1Write", "asciiWrite", "ucs2Write", "hexWrite", "base64Write", "base64urlWrite"]) {
  const original = Buffer.prototype[name];
  if (typeof original !== "function" || original.__nodeDefaults) continue;
  const patched = function (string, offset = 0, length = this.length - offset) { return original.call(this, string, offset, length); };
  patched.__nodeDefaults = true;
  Buffer.prototype[name] = patched;
}
