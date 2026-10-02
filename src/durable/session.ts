import type { Env, MessageRequest, SessionState, WaEvent } from "../types";
import { HttpError, json, MESSAGE_BODY_LIMIT, readJson } from "../lib/http";
import { makeEvent } from "../lib/events";
import { deliverWebhook } from "../lib/webhooks";
import type { IncomingText, ProtocolState } from "../protocol/client";
import { SocketProtocolClient } from "../protocol/socket-client";
import { validateWebhookUrl } from "../lib/url-safety";
import { alertMessage, getSessionAlertSettings, notifySessionOwner, sendAlert, type AlertKind } from "../lib/alerts";

const WHATSAPP_MAX_TEXT = 65_536;

export class WhatsAppSession {
  private readonly sql: SqlStorage;

  /** How often a linked session wakes to check its socket; also keeps the DO from idling out. */
  private static readonly HEARTBEAT_MS = 45_000;
  /** WhatsApp rotates the pairing QR roughly every 20–60 seconds. */
  private static readonly QR_TTL_MS = 60_000;

  private socket: SocketProtocolClient | null = null;

  /** The WhatsApp transport for this session: a socket held by this very DO. */
  private get protocol(): SocketProtocolClient {
    this.socket ??= new SocketProtocolClient(this.sql, {
      onQr: (qr) => {
        this.setMetadata("qr", qr ?? "");
        this.setMetadata("qr_expires_at", qr ? String(Date.now() + WhatsAppSession.QR_TTL_MS) : "0");
      },
    });
    return this.socket;
  }

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS inbound_seen (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, response TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS webhook_jobs (event_id TEXT NOT NULL, webhook_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, PRIMARY KEY(event_id, webhook_id))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS webhook_failures (event_id TEXT NOT NULL, webhook_id TEXT NOT NULL, attempts INTEGER NOT NULL, failed_at INTEGER NOT NULL, PRIMARY KEY(event_id, webhook_id))");
    this.sql.exec("INSERT OR IGNORE INTO metadata(key,value) VALUES('state','unpaired')");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/status" && request.method === "GET") return json({ session: url.searchParams.get("session"), state: this.state(), qr: this.currentQr() });
      if (url.pathname === "/pair" && request.method === "POST") return await this.pair(url.searchParams.get("session") ?? "");
      if (url.pathname === "/messages" && request.method === "POST") return await this.send(await readJson<MessageRequest>(request, MESSAGE_BODY_LIMIT), url.searchParams.get("session") ?? "");
      if (url.pathname === "/events" && request.method === "GET") return json({ events: this.sql.exec<{ payload: string }>("SELECT payload FROM events ORDER BY created_at DESC LIMIT 100").toArray().map(row => JSON.parse(row.payload)) });
      if (url.pathname === "/webhooks" && request.method === "GET") return json({ webhooks: this.sql.exec<{ id: string; url: string; enabled: number }>("SELECT id,url,enabled FROM webhooks ORDER BY id").toArray() });
      if (url.pathname === "/webhooks/deliveries" && request.method === "GET") return json({ failed: this.sql.exec("SELECT * FROM webhook_failures ORDER BY failed_at DESC LIMIT 100").toArray(), pending: this.sql.exec("SELECT COUNT(*) AS count FROM webhook_jobs").toArray()[0]?.count ?? 0 });
      if (url.pathname === "/webhooks" && request.method === "POST") return await this.addWebhook(request);
      const webhookDelete = url.pathname.match(/^\/webhooks\/([\w-]+)$/);
      if (webhookDelete && request.method === "PATCH") return await this.updateWebhook(webhookDelete[1], request);
      if (webhookDelete && request.method === "DELETE") {
        this.sql.exec("DELETE FROM webhook_jobs WHERE webhook_id=?", webhookDelete[1]);
        this.sql.exec("DELETE FROM webhook_failures WHERE webhook_id=?", webhookDelete[1]);
        this.sql.exec("DELETE FROM webhooks WHERE id=?", webhookDelete[1]);
        this.scheduleNextAlarm();
        return json({ deleted: true });
      }
      if (url.pathname === "/internal/cron" && request.method === "POST") return await this.cleanup();
      if (url.pathname === "/" && request.method === "DELETE") return await this.logout();
      throw new HttpError(404, "not_found", "Unknown session operation");
    } catch (error) {
      if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
      return json({ error: { code: "internal_error", message: "Session operation failed" } }, 500);
    }
  }

  async alarm(): Promise<void> {
    await this.cleanup();
    // The socket dies with the DO instance (eviction, deploy) without any state change being
    // recorded, so a linked session re-opens it here whenever it is missing.
    const socket = this.protocol;
    if (this.hasLinkedAccount() && !socket.registered) { this.setMetadata("has_link", "0"); this.setMetadata("state", "unpaired"); }
    else if (this.hasLinkedAccount() && !socket.live && Number(this.getMetadata("next_reconnect_at") ?? "0") <= Date.now()) await this.reconnect();
    await this.alertIfDown();
    this.scheduleNextAlarm();
  }

  /** Tells the session's owner once when a linked session has stayed disconnected past their chosen delay. */
  private async alertIfDown(): Promise<void> {
    const since = Number(this.getMetadata("down_since") ?? "0");
    if (!since || this.getMetadata("alert_sent") === "1" || this.state() === "connected" || !this.hasLinkedAccount()) return;
    const session = this.getMetadata("session_id") ?? "";
    try {
      const settings = await getSessionAlertSettings(this.env, session);
      if (!settings || Date.now() - since < settings.delayMinutes * 60_000) return;
      if (!settings.slackWebhookUrl && !settings.email) return; // nowhere to send yet; keep checking in case a destination is added
      const deliveries = await sendAlert(this.env, settings, alertMessage("down", session, Math.round((Date.now() - since) / 60_000)));
      if (deliveries.some((delivery) => delivery.ok)) this.setMetadata("alert_sent", "1"); // otherwise retry on the next alarm
    } catch { /* alerting must never break reconnects; the next alarm retries */ }
  }

  private async alert(session: string, kind: AlertKind): Promise<void> {
    try { await notifySessionOwner(this.env, session, kind); }
    catch { /* best effort */ }
  }

  private state(): SessionState { return (this.sql.exec<{ value: string }>("SELECT value FROM metadata WHERE key='state'").toArray()[0]?.value as SessionState) ?? "unpaired"; }

  private async pair(session: string): Promise<Response> {
    if (this.state() === "connected") return json({ session, state: "connected" });
    this.setMetadata("session_id", session);
    try {
      await this.protocol.start((message) => this.handleIncoming(session, message), (state) => this.handleProtocolState(session, state));
      const current = await this.protocol.state().catch(() => "unpaired" as ProtocolState);
      if (current === "connected") {
        if (this.state() !== "connected") await this.handleProtocolState(session, "connected");
        return json({ session, state: "connected" });
      }
      this.setMetadata("state", "pairing");
      const result = await this.protocol.pair();
      const after = await this.protocol.state().catch(() => "pairing" as ProtocolState);
      const ttl = WhatsAppSession.QR_TTL_MS;
      this.setMetadata("qr", result.qr);
      this.setMetadata("qr_expires_at", String(Date.now() + ttl));
      if (after === "connected" && this.state() !== "connected") await this.handleProtocolState(session, "connected");
      this.scheduleNextAlarm();
      return json({ session, state: this.state(), qr: result.qr, expiresAt: Date.now() + ttl }, 201);
    } catch (error) {
      this.setMetadata("state", this.hasLinkedAccount() ? "disconnected" : "unpaired");
      throw error;
    }
  }

  private async handleProtocolState(session: string, state: ProtocolState): Promise<void> {
    const previous = this.state();
    this.setMetadata("state", state);
    if (state === "connected") {
      this.setMetadata("has_link", "1");
      this.setMetadata("reconnect_attempt", "0");
      this.setMetadata("next_reconnect_at", "0");
      this.setMetadata("qr", "");
      this.setMetadata("qr_expires_at", "0");
      // Re-opening the socket after the DO was evicted is not a new connection from the caller's view.
      if (previous !== "connected") await this.recordEvent(makeEvent(session, "session.connected", {}));
      const alerted = this.getMetadata("alert_sent") === "1";
      this.setMetadata("down_since", "0");
      this.setMetadata("alert_sent", "0");
      if (alerted) await this.alert(session, "recovered");
      return;
    }
    if (state === "logged_out") {
      const wasLinked = this.hasLinkedAccount();
      this.setMetadata("has_link", "0");
      this.setMetadata("next_reconnect_at", "0");
      this.setMetadata("down_since", "0");
      this.setMetadata("alert_sent", "0");
      if (wasLinked) {
        await this.recordEvent(makeEvent(session, "session.logged_out", {}));
        // Being unlinked cannot fix itself, so the owner hears about it straight away.
        await this.alert(session, "logged_out");
      }
      return;
    }
    if (state === "disconnected" && this.hasLinkedAccount()) {
      // Failed reconnect attempts report "disconnected" again; announce only the first drop.
      if (previous !== "disconnected") await this.recordEvent(makeEvent(session, "session.disconnected", {}));
      if (!Number(this.getMetadata("down_since") ?? "0")) this.setMetadata("down_since", String(Date.now()));
      this.queueReconnect();
    }
  }

  private async handleIncoming(session: string, message: IncomingText): Promise<void> {
    if (!message.id || typeof message.id !== "string" || !message.from || !/^\+?[1-9]\d{6,14}$/.test(message.from) || typeof message.text !== "string" || !message.text.trim()) return;
    const seen = this.sql.exec("INSERT OR IGNORE INTO inbound_seen(id,expires_at) VALUES(?,?)", message.id, Date.now() + 86_400_000);
    if (!seen.rowsWritten) return; // duplicate inbound message; deliver once
    const event = makeEvent(session, "message.received", { messageId: message.id, from: message.from, type: "text", text: message.text, timestamp: message.timestamp });
    await this.recordEvent(event);
  }

  private async reconnect(): Promise<void> {
    this.setMetadata("next_reconnect_at", "0");
    const session = this.getMetadata("session_id") ?? "";
    try { await this.protocol.start((message) => this.handleIncoming(session, message), (state) => this.handleProtocolState(session, state)); }
    catch { this.queueReconnect(); }
  }

  private queueReconnect(): void {
    const attempt = Number(this.getMetadata("reconnect_attempt") ?? "0");
    const jitter = crypto.getRandomValues(new Uint16Array(1))[0] % 10_000;
    const delay = Math.min(3_600_000, 30_000 * 2 ** Math.min(attempt, 7)) + jitter;
    this.setMetadata("reconnect_attempt", String(attempt + 1));
    this.setMetadata("next_reconnect_at", String(Date.now() + delay));
    this.scheduleNextAlarm();
  }

  private hasLinkedAccount(): boolean { return this.getMetadata("has_link") === "1"; }
  private currentQr(): string | undefined {
    const expires = Number(this.getMetadata("qr_expires_at") ?? "0");
    return expires > Date.now() ? this.getMetadata("qr") || undefined : undefined;
  }
  private getMetadata(key: string): string | undefined { return this.sql.exec<{ value: string }>("SELECT value FROM metadata WHERE key=?", key).toArray()[0]?.value; }
  private setMetadata(key: string, value: string): void { this.sql.exec("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value); }

  private async recordEvent(event: WaEvent): Promise<void> {
    const now = Date.now();
    this.sql.exec("INSERT OR IGNORE INTO events VALUES(?,?,?,?,?)", event.id, event.type, JSON.stringify(event), now, now + 86_400_000);
    for (const hook of this.sql.exec<{ id: string }>("SELECT id FROM webhooks WHERE enabled=1").toArray()) this.sql.exec("INSERT OR IGNORE INTO webhook_jobs(event_id,webhook_id,attempts,next_attempt_at) VALUES(?,?,0,?)", event.id, hook.id, now);
    this.scheduleNextAlarm();
  }

  private async send(input: MessageRequest, session: string): Promise<Response> {
    if (this.state() !== "connected") throw new HttpError(409, "session_not_connected", "Pair and connect the session before sending");
    if (!/^\+?[1-9]\d{6,14}$/.test(input.to)) throw new HttpError(400, "invalid_recipient", "to must be an international phone number");
    if (typeof input.text !== "string" || !input.text.trim()) throw new HttpError(400, "invalid_text", "text must not be empty");
    // WaSend sets no length limit of its own; this is WhatsApp's maximum for one text message.
    if (input.text.length > WHATSAPP_MAX_TEXT) throw new HttpError(400, "text_too_long", `WhatsApp accepts at most ${WHATSAPP_MAX_TEXT} characters per message`);
    const key = input.idempotencyKey;
    if (key && !/^[\w.:/-]{1,128}$/.test(key)) throw new HttpError(400, "invalid_idempotency_key", "Invalid idempotency key");
    if (key) {
      const old = this.sql.exec<{ response: string }>("SELECT response FROM idempotency WHERE key=? AND expires_at>?", key, Date.now()).toArray()[0];
      if (old) return json(JSON.parse(old.response));
    }
    const sent = await this.protocol.sendText(input.to, input.text);
    const result = { id: `msg_${crypto.randomUUID()}`, session, status: "sent", providerMessageId: sent.providerMessageId };
    const event: WaEvent = makeEvent(session, "message.sent", { messageId: result.id, to: input.to, kind: input.kind ?? "transactional" });
    await this.recordEvent(event);
    if (key) this.sql.exec("INSERT OR REPLACE INTO idempotency VALUES(?,?,?)", key, JSON.stringify(result), Date.now() + 86_400_000);
    return json(result, 202);
  }

  private async cleanup(): Promise<Response> {
    const now = Date.now();
    this.sql.exec("DELETE FROM webhook_jobs WHERE event_id IN (SELECT id FROM events WHERE expires_at<=?)", now);
    this.sql.exec("DELETE FROM webhook_failures WHERE event_id IN (SELECT id FROM events WHERE expires_at<=?)", now);
    this.sql.exec("DELETE FROM inbound_seen WHERE expires_at<=?", now);
    const jobs = this.sql.exec<{ event_id: string; webhook_id: string; attempts: number; payload: string; url: string; secret: string }>(
      `SELECT j.event_id,j.webhook_id,j.attempts,e.payload,w.url,w.secret FROM webhook_jobs j
       JOIN events e ON e.id=j.event_id JOIN webhooks w ON w.id=j.webhook_id
       WHERE j.next_attempt_at<=? AND w.enabled=1 ORDER BY j.next_attempt_at LIMIT 20`, now,
    ).toArray();
    for (const job of jobs) {
      const ok = await deliverWebhook(job.url, job.secret, JSON.parse(job.payload), this.env.WEBHOOK_ALLOWED_HOSTS);
      if (ok) this.sql.exec("DELETE FROM webhook_jobs WHERE event_id=? AND webhook_id=?", job.event_id, job.webhook_id);
      else if (job.attempts >= 7) {
        this.sql.exec("INSERT OR REPLACE INTO webhook_failures(event_id,webhook_id,attempts,failed_at) VALUES(?,?,?,?)", job.event_id, job.webhook_id, job.attempts + 1, now);
        this.sql.exec("DELETE FROM webhook_jobs WHERE event_id=? AND webhook_id=?", job.event_id, job.webhook_id);
      }
      else {
        const jitter = crypto.getRandomValues(new Uint16Array(1))[0] % 10_000;
        const delay = Math.min(6 * 60 * 60_000, 30_000 * 2 ** job.attempts) + jitter;
        this.sql.exec("UPDATE webhook_jobs SET attempts=attempts+1,next_attempt_at=? WHERE event_id=? AND webhook_id=?", now + delay, job.event_id, job.webhook_id);
      }
    }
    this.sql.exec("DELETE FROM events WHERE expires_at<=?", now);
    this.sql.exec("DELETE FROM idempotency WHERE expires_at<=?", now);
    if (Number(this.getMetadata("qr_expires_at") ?? "0") <= now) {
      this.setMetadata("qr", "");
      this.setMetadata("qr_expires_at", "0");
    }
    this.scheduleNextAlarm();
    return json({ cleaned: true });
  }

  private scheduleNextAlarm(): void {
    const row = this.sql.exec<{ at: number | null }>(`SELECT MIN(at) AS at FROM (
      SELECT MIN(expires_at) AS at FROM events
      UNION ALL SELECT MIN(expires_at) AS at FROM inbound_seen
      UNION ALL SELECT MIN(next_attempt_at) AS at FROM webhook_jobs
      UNION ALL SELECT CAST(NULLIF(value,'0') AS INTEGER) AS at FROM metadata WHERE key='next_reconnect_at'
      UNION ALL SELECT CAST(NULLIF(value,'0') AS INTEGER) AS at FROM metadata WHERE key='qr_expires_at'
    )`).toArray()[0];
    let at = row?.at ?? null;
    // While this DO holds the WhatsApp socket it needs a steady wake-up to notice a lost socket.
    if ((this.hasLinkedAccount() || this.state() === "pairing")) at = Math.min(at ?? Infinity, Date.now() + WhatsAppSession.HEARTBEAT_MS);
    if (at != null) this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, at));
    else void this.ctx.storage.deleteAlarm();
  }

  private async addWebhook(request: Request): Promise<Response> {
    const body = await readJson<{ url?: string; secret?: string }>(request);
    if (body.url !== undefined && typeof body.url !== "string" || body.secret !== undefined && typeof body.secret !== "string") throw new HttpError(400, "invalid_webhook", "url and secret must be strings");
    let url: URL;
    try { url = await validateWebhookUrl(body.url ?? "", this.env.WEBHOOK_ALLOWED_HOSTS); }
    catch (error) { throw new HttpError(400, "invalid_webhook_url", error instanceof Error ? error.message : "Webhook host is not publicly routable"); }
    const secret = body.secret?.trim() || `whsec_${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`;
    if (secret.length < 24 || secret.length > 256) throw new HttpError(400, "invalid_webhook_secret", "Secret must be 24–256 characters");
    const id = `wh_${crypto.randomUUID()}`;
    this.sql.exec("INSERT INTO webhooks(id,url,secret,enabled) VALUES(?,?,?,1)", id, url.toString(), secret);
    return json({ id, url: url.toString(), secret }, 201);
  }

  private async updateWebhook(id: string, request: Request): Promise<Response> {
    const current = this.sql.exec<{ url: string; secret: string; enabled: number }>("SELECT url,secret,enabled FROM webhooks WHERE id=?", id).toArray()[0];
    if (!current) throw new HttpError(404, "webhook_not_found", "Webhook not found");
    const body = await readJson<{ url?: string; secret?: string; enabled?: boolean }>(request);
    if (body.url !== undefined && typeof body.url !== "string" || body.secret !== undefined && typeof body.secret !== "string" || body.enabled !== undefined && typeof body.enabled !== "boolean") throw new HttpError(400, "invalid_webhook", "url and secret must be strings; enabled must be a boolean");
    let url = current.url;
    if (body.url !== undefined) {
      try { url = (await validateWebhookUrl(body.url, this.env.WEBHOOK_ALLOWED_HOSTS)).toString(); }
      catch (error) { throw new HttpError(400, "invalid_webhook_url", error instanceof Error ? error.message : "Webhook host is not publicly routable"); }
    }
    const secret = body.secret?.trim() || current.secret;
    if (secret.length < 24 || secret.length > 256) throw new HttpError(400, "invalid_webhook_secret", "Secret must be 24–256 characters");
    const enabled = body.enabled === undefined ? current.enabled : body.enabled ? 1 : 0;
    this.sql.exec("UPDATE webhooks SET url=?,secret=?,enabled=? WHERE id=?", url, secret, enabled, id);
    if (!enabled) this.sql.exec("DELETE FROM webhook_jobs WHERE webhook_id=?", id);
    this.scheduleNextAlarm();
    return json({ id, url, enabled, ...(body.secret ? { secret } : {}) });
  }

  private async logout(): Promise<Response> {
    try { await this.protocol.close(); } catch { /* clear local state even when WhatsApp is unreachable */ }
    this.sql.exec("UPDATE metadata SET value='logged_out' WHERE key='state'");
    this.sql.exec("DELETE FROM events");
    this.sql.exec("DELETE FROM idempotency");
    this.sql.exec("DELETE FROM inbound_seen");
    this.sql.exec("DELETE FROM webhook_jobs");
    this.sql.exec("DELETE FROM webhook_failures");
    this.sql.exec("DELETE FROM webhooks");
    this.setMetadata("has_link", "0");
    this.setMetadata("down_since", "0");
    this.setMetadata("alert_sent", "0");
    this.setMetadata("qr", "");
    this.setMetadata("qr_expires_at", "0");
    this.setMetadata("next_reconnect_at", "0");
    await this.ctx.storage.deleteAlarm();
    return json({ state: "logged_out" });
  }
}
