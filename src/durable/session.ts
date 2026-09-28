import type { Env, MessageRequest, SessionState, WaEvent } from "../types";
import { HttpError, json, readJson } from "../lib/http";
import { makeEvent } from "../lib/events";
import { UnimplementedProtocolClient } from "../protocol/client";

export class WhatsAppSession {
  private readonly sql: SqlStorage;
  private readonly protocol = new UnimplementedProtocolClient();

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, response TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS webhook_jobs (event_id TEXT NOT NULL, webhook_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, PRIMARY KEY(event_id, webhook_id));`);
    this.sql.exec("INSERT OR IGNORE INTO metadata(key,value) VALUES('state','unpaired')");
    ctx.storage.setAlarm(Date.now() + 5 * 60_000);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/status" && request.method === "GET") return json({ session: url.searchParams.get("session"), state: this.state() });
      if (url.pathname === "/pair" && request.method === "POST") return await this.pair(url.searchParams.get("session") ?? "");
      if (url.pathname === "/messages" && request.method === "POST") return await this.send(await readJson<MessageRequest>(request), url.searchParams.get("session") ?? "");
      if (url.pathname === "/internal/cron" && request.method === "POST") return await this.cleanup();
      if (url.pathname === "/" && request.method === "DELETE") return await this.logout();
      throw new HttpError(404, "not_found", "Unknown session operation");
    } catch (error) {
      if (error instanceof Error && error.message.includes("not implemented")) return json({ error: { code: "protocol_not_implemented", message: "WhatsApp protocol support is not available yet" } }, 503);
      if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
      return json({ error: { code: "internal_error", message: "Session operation failed" } }, 500);
    }
  }

  async alarm(): Promise<void> {
    await this.cleanup();
    // Re-arm only for named session objects. The reserved maintenance object
    // receives explicit Cron pokes and does not need its own alarm loop.
    this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
  }

  private state(): SessionState { return (this.sql.exec<{ value: string }>("SELECT value FROM metadata WHERE key='state'").toArray()[0]?.value as SessionState) ?? "unpaired"; }

  private async pair(session: string): Promise<Response> {
    if (this.state() === "connected") return json({ session, state: "connected" });
    this.sql.exec("UPDATE metadata SET value='pairing' WHERE key='state'");
    try { const result = await this.protocol.pair(); return json({ session, state: "pairing", qr: result.qr }, 201); }
    catch (error) { this.sql.exec("UPDATE metadata SET value='unpaired' WHERE key='state'"); throw error; }
  }

  private async send(input: MessageRequest, session: string): Promise<Response> {
    if (this.state() !== "connected") throw new HttpError(409, "session_not_connected", "Pair and connect the session before sending");
    if (!/^\+?[1-9]\d{6,14}$/.test(input.to)) throw new HttpError(400, "invalid_recipient", "to must be an international phone number");
    const max = Number(this.env.MAX_MESSAGE_CHARS || 4096);
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > max) throw new HttpError(400, "invalid_text", `text must contain 1 to ${max} characters`);
    const key = input.idempotencyKey;
    if (key && !/^[\w.:/-]{1,128}$/.test(key)) throw new HttpError(400, "invalid_idempotency_key", "Invalid idempotency key");
    if (key) {
      const old = this.sql.exec<{ response: string }>("SELECT response FROM idempotency WHERE key=? AND expires_at>?", key, Date.now()).toArray()[0];
      if (old) return json(JSON.parse(old.response));
    }
    const sent = await this.protocol.sendText(input.to, input.text);
    const result = { id: `msg_${crypto.randomUUID()}`, session, status: "sent", providerMessageId: sent.providerMessageId };
    const ttl = input.kind === "otp" ? Math.max(60, Math.min(input.expiresInSeconds ?? 300, 900)) : 86_400;
    const event: WaEvent = makeEvent(session, "message.sent", { messageId: result.id, to: input.to, kind: input.kind ?? "transactional" });
    this.sql.exec("INSERT INTO events VALUES(?,?,?,?,?)", event.id, event.type, JSON.stringify(event), Date.now(), Date.now() + ttl * 1000);
    if (key) this.sql.exec("INSERT OR REPLACE INTO idempotency VALUES(?,?,?)", key, JSON.stringify(result), Date.now() + 86_400_000);
    return json(result, 202);
  }

  private async cleanup(): Promise<Response> {
    const now = Date.now();
    this.sql.exec("DELETE FROM events WHERE expires_at<=?", now);
    this.sql.exec("DELETE FROM idempotency WHERE expires_at<=?", now);
    return json({ cleaned: true });
  }

  private async logout(): Promise<Response> {
    await this.protocol.close();
    this.sql.exec("UPDATE metadata SET value='logged_out' WHERE key='state'");
    this.sql.exec("DELETE FROM events; DELETE FROM idempotency; DELETE FROM webhook_jobs; DELETE FROM webhooks");
    return json({ state: "logged_out" });
  }
}
