/**
 * Stand-in for the `ws` package (aliased in wrangler.toml). The WhatsApp client library opens its
 * socket through `ws`, which needs Node's http upgrade path; Workers instead open outbound
 * WebSockets with `fetch` + an Upgrade header. Only the surface the library uses is provided.
 */
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";

export default class WebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, options = {}) {
    super();
    this.readyState = WebSocket.CONNECTING;
    this.socket = null;
    const target = String(url).replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    const headers = { Upgrade: "websocket", ...(options.headers || {}) };
    if (options.origin) headers.Origin = options.origin;
    // The abort must be disarmed once the upgrade succeeds: aborting later would tear down the open socket.
    const abort = new AbortController();
    const timer = options.handshakeTimeout ? setTimeout(() => abort.abort(new Error("WebSocket handshake timed out")), options.handshakeTimeout) : undefined;
    fetch(target, { headers, signal: abort.signal }).then((response) => {
      clearTimeout(timer);
      const socket = response.webSocket;
      if (!socket) throw new Error(`WebSocket upgrade failed: HTTP ${response.status}`);
      if (this.readyState === WebSocket.CLOSING) { socket.accept(); socket.close(1000); throw new Error("WebSocket closed before it opened"); }
      socket.binaryType = "arraybuffer";
      socket.accept();
      this.socket = socket;
      socket.addEventListener("message", (event) => this.emit("message", Buffer.from(event.data), typeof event.data !== "string"));
      socket.addEventListener("close", (event) => this.finish(event.code, event.reason));
      socket.addEventListener("error", (event) => this.emit("error", event.error || new Error("WebSocket error")));
      this.readyState = WebSocket.OPEN;
      this.emit("open");
    }).catch((error) => {
      clearTimeout(timer);
      this.emit("error", error);
      this.finish(1006, "");
    });
  }

  send(data, cb) {
    try { this.socket.send(data); cb?.(); }
    catch (error) { if (cb) cb(error); else throw error; }
  }

  close(code, reason) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    try { this.socket?.close(code ?? 1000, reason); } catch { /* already closed */ }
    // The peer may never answer the close frame; callers await the "close" event, so do not depend on it.
    if (this.socket) setTimeout(() => this.finish(code ?? 1000, reason ?? ""), 0);
  }

  finish(code, reason) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason || ""));
  }

  terminate() { this.close(); }
}

export { WebSocket };
