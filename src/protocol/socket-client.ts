/**
 * In-Durable-Object WhatsApp transport: the session DO holds the WhatsApp Web socket itself, so
 * nothing runs outside Cloudflare Workers. The protocol work is delegated to the Baileys library;
 * `ws` and `whatsapp-rust-bridge` are aliased to Workers-compatible shims in wrangler.toml.
 *
 * Linked-device credentials and Signal keys live in the DO's SQLite (`wa_auth`). The socket only
 * exists while the DO is in memory, so the DO re-opens it from its alarm after an eviction.
 */
import makeWASocket, { Browsers, BufferJSON, DisconnectReason, initAuthCreds, normalizeMessageContent, proto } from "baileys";
import type { AuthenticationCreds, ConnectionState, SignalDataSet, SignalDataTypeMap, SignalKeyStore, WAMessage, WASocket } from "baileys";
import { renderSVG } from "uqr";
import { HttpError } from "../lib/http";
import type { IncomingText, ProtocolClient, ProtocolState } from "./client";

/** How long start() waits for an already-linked account to come online. */
const OPEN_TIMEOUT_MS = 20_000;
/** How long pair() waits for WhatsApp to hand out the first QR reference. */
const QR_TIMEOUT_MS = 30_000;

// The library logs key material at info/debug level; keep it out of Workers logs entirely.
const quietLogger = {
  level: "silent",
  child() { return quietLogger; },
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
};

/** Digits of a phone-number JID (`15551234567:3@s.whatsapp.net` → `15551234567`), or null for any other JID kind. */
export function phoneFromJid(jid: string | null | undefined): string | null {
  const match = /^(\d{7,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid ?? "");
  return match ? match[1] : null;
}

export function jidFromPhone(phone: string): string { return `${phone.replace(/\D/g, "")}@s.whatsapp.net`; }

/** QR payload as an image data URL, which is what the dashboard and API clients render. */
export function qrDataUrl(payload: string): string {
  return `data:image/svg+xml;base64,${btoa(renderSVG(payload, { border: 2 }))}`;
}

export interface SocketClientHooks {
  /** Called with each rotated QR image (data URL), and with null once the QR is no longer valid. */
  onQr(qr: string | null): void;
}

export class SocketProtocolClient implements ProtocolClient {
  private sock: WASocket | null = null;
  private generation = 0;
  private current: ProtocolState;
  private qr: string | null = null;
  private readonly waiters = new Set<() => void>();
  private onText: (message: IncomingText) => Promise<void> = async () => {};
  private onState: (state: ProtocolState) => Promise<void> = async () => {};

  constructor(private readonly sql: SqlStorage, private readonly hooks: SocketClientHooks) {
    this.sql.exec("CREATE TABLE IF NOT EXISTS wa_auth (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.current = this.registered ? "disconnected" : "unpaired";
  }

  /** True while a socket exists (connecting or open). */
  get live(): boolean { return this.sock !== null; }

  /** True once a WhatsApp account has been linked and its credentials are stored. */
  get registered(): boolean { return Boolean(this.read<AuthenticationCreds>("creds")?.me?.id); }

  async start(onText: (message: IncomingText) => Promise<void>, onState: (state: ProtocolState) => Promise<void>): Promise<void> {
    this.onText = onText;
    this.onState = onState;
    if (!this.sock) this.connect();
    // A linked account normally comes online within seconds; waiting lets callers see "connected".
    if (this.registered) await this.waitFor(() => this.current === "connected" || !this.sock, OPEN_TIMEOUT_MS);
  }

  async pair(): Promise<{ qr: string }> {
    if (!this.sock) this.connect();
    await this.waitFor(() => this.qr !== null || this.current === "connected" || !this.sock, QR_TIMEOUT_MS);
    if (this.qr) return { qr: this.qr };
    throw new HttpError(504, "pairing_unavailable", "WhatsApp did not provide a pairing QR code in time; try again");
  }

  async state(): Promise<ProtocolState> { return this.current; }

  async sendText(to: string, text: string): Promise<{ providerMessageId: string }> {
    const sock = await this.open();
    let id: string | null | undefined;
    try { id = (await sock.sendMessage(jidFromPhone(to), { text }))?.key?.id; }
    catch (error) { throw new HttpError(502, "send_failed", `WhatsApp rejected the send: ${error instanceof Error ? error.message : "send failed"}`); }
    if (!id) throw new HttpError(502, "send_failed", "WhatsApp did not confirm the send");
    return { providerMessageId: id };
  }

  /** Unlink the device on WhatsApp's side when possible, then forget all credentials. */
  async close(): Promise<void> {
    let sock: WASocket | null = null;
    if (this.registered) { try { sock = await this.open(); } catch { /* offline: forget locally anyway */ } }
    else sock = this.sock;
    this.generation += 1; // detach handlers so the teardown below does not echo back as state changes
    this.sock = null;
    if (sock) {
      try { if (this.registered) await sock.logout(); else sock.end(undefined); }
      catch { /* best effort */ }
    }
    this.clearAuth();
    this.setQr(null);
    this.current = "logged_out";
    this.wake();
  }

  /** The open socket, connecting first if the DO was evicted since the last call. */
  private async open(): Promise<WASocket> {
    if (!this.registered) throw new HttpError(409, "session_not_connected", "Pair and connect the session before sending");
    if (!this.sock) this.connect();
    await this.waitFor(() => this.current === "connected" || !this.sock, OPEN_TIMEOUT_MS);
    if (this.current === "connected" && this.sock) return this.sock;
    throw new HttpError(503, "session_unavailable", "The WhatsApp connection is not available right now; retry shortly");
  }

  private connect(): void {
    const generation = ++this.generation;
    const creds = this.read<AuthenticationCreds>("creds") ?? initAuthCreds();
    const sock = makeWASocket({
      auth: { creds, keys: this.keyStore() },
      browser: Browsers.ubuntu("Chrome"),
      logger: quietLogger as never,
      // Text-only gateway: skip chat history and anything else that costs CPU without being used.
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    const mine = () => generation === this.generation;
    sock.ev.on("creds.update", () => { if (mine()) this.write("creds", creds); });
    sock.ev.on("connection.update", (update) => { if (mine()) void this.onConnectionUpdate(update); });
    sock.ev.on("messages.upsert", ({ messages, type }) => { if (mine() && type === "notify") void this.onMessages(sock, messages); });
  }

  private async onConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    if (update.qr) {
      this.setQr(qrDataUrl(update.qr));
      await this.setState("pairing");
    }
    if (update.connection === "open") {
      this.setQr(null);
      await this.setState("connected");
    }
    if (update.connection === "close") {
      this.sock = null;
      const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      // WhatsApp closes the socket right after a successful QR scan and expects a fresh login.
      if (code === DisconnectReason.restartRequired) { this.connect(); return; }
      this.setQr(null);
      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
        this.clearAuth();
        await this.setState("logged_out");
        return;
      }
      await this.setState(this.registered ? "disconnected" : "unpaired");
    }
  }

  private async onMessages(sock: WASocket, messages: WAMessage[]): Promise<void> {
    for (const message of messages) {
      const key = message.key as WAMessage["key"] & { remoteJidAlt?: string };
      if (!key?.id || key.fromMe) continue;
      const content = normalizeMessageContent(message.message);
      const text = content?.conversation ?? content?.extendedTextMessage?.text;
      if (!text) continue;
      const from = await this.senderPhone(sock, key.remoteJid, key.remoteJidAlt);
      if (!from) continue; // groups, broadcasts, channels, or a sender whose number is unknown
      const seconds = Number(message.messageTimestamp?.toString() ?? 0);
      try { await this.onText({ id: key.id, from, text, timestamp: seconds ? seconds * 1000 : Date.now() }); }
      catch { /* one bad message must not stop the rest */ }
    }
  }

  /** Individual chats may be addressed by privacy ID (`@lid`); resolve those back to a phone number. */
  private async senderPhone(sock: WASocket, jid?: string | null, alt?: string | null): Promise<string | null> {
    const direct = phoneFromJid(jid) ?? phoneFromJid(alt);
    if (direct || !jid?.endsWith("@lid")) return direct;
    try { return phoneFromJid(await sock.signalRepository.lidMapping.getPNForLID(jid)); }
    catch { return null; }
  }

  private setQr(qr: string | null): void {
    if (this.qr === qr) return;
    this.qr = qr;
    this.hooks.onQr(qr);
    this.wake();
  }

  private async setState(state: ProtocolState): Promise<void> {
    this.current = state;
    this.wake();
    try { await this.onState(state); }
    catch { /* state bookkeeping must not break the socket handlers */ }
  }

  private wake(): void { for (const waiter of [...this.waiters]) waiter(); }

  private waitFor(done: () => boolean, timeoutMs: number): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.waiters.delete(check); resolve(); };
      const check = () => { if (done()) finish(); };
      const timer = setTimeout(finish, timeoutMs);
      this.waiters.add(check);
    });
  }

  private keyStore(): SignalKeyStore {
    return {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const found: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          let value = this.read<unknown>(`${type}:${id}`);
          if (value && type === "app-state-sync-key") value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
          if (value) found[id] = value as SignalDataTypeMap[T];
        }
        return found;
      },
      set: async (data: SignalDataSet) => {
        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries ?? {})) {
            if (value) this.write(`${type}:${id}`, value);
            else this.sql.exec("DELETE FROM wa_auth WHERE key=?", `${type}:${id}`);
          }
        }
      },
    };
  }

  private read<T>(key: string): T | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM wa_auth WHERE key=?", key).toArray()[0];
    return row ? JSON.parse(row.value, BufferJSON.reviver) as T : null;
  }

  private write(key: string, value: unknown): void {
    this.sql.exec("INSERT INTO wa_auth(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(value, BufferJSON.replacer));
  }

  private clearAuth(): void { this.sql.exec("DELETE FROM wa_auth"); }
}
