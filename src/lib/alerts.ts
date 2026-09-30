/**
 * Session alerts: tell the account owner, by Slack and/or email, when one of their WhatsApp
 * sessions stops working. Destinations are set per account; the session Durable Object decides
 * when an alert is due and calls notifySessionOwner.
 */
import type { Env } from "../types";
import { HttpError } from "./http";

export interface AlertSettings { email: string; slackWebhookUrl: string; delayMinutes: number; }

export type AlertKind = "down" | "logged_out" | "recovered" | "test";

export interface AlertDelivery { channel: "slack" | "email"; ok: boolean; error?: string; }

export const DEFAULT_ALERT_DELAY_MINUTES = 5;

const DEFAULTS: AlertSettings = { email: "", slackWebhookUrl: "", delayMinutes: DEFAULT_ALERT_DELAY_MINUTES };

/** Email alerts need the EMAIL binding and a sender address on a domain set up for Cloudflare Email Service. */
export function emailAvailable(env: Env): boolean { return Boolean(env.EMAIL && env.ALERT_EMAIL_FROM); }

/** Validates caller input and returns the settings to store. Empty strings switch a channel off. */
export function parseAlertSettings(input: unknown): AlertSettings {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new HttpError(400, "invalid_alert_email", "Enter a valid email address, or leave it empty to turn email alerts off");
  const slackWebhookUrl = typeof body.slackWebhookUrl === "string" ? body.slackWebhookUrl.trim() : "";
  // Only Slack's own incoming-webhook host is accepted, so this setting cannot be pointed at arbitrary servers.
  if (slackWebhookUrl && !/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,200}$/.test(slackWebhookUrl)) throw new HttpError(400, "invalid_slack_webhook", "Use a Slack incoming webhook URL starting with https://hooks.slack.com/services/, or leave it empty");
  const delayMinutes = body.delayMinutes === undefined ? DEFAULT_ALERT_DELAY_MINUTES : Number(body.delayMinutes);
  if (!Number.isInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > 120) throw new HttpError(400, "invalid_alert_delay", "delayMinutes must be a whole number from 1 to 120");
  return { email, slackWebhookUrl, delayMinutes };
}

export async function getAlertSettings(env: Env, accountId: string): Promise<AlertSettings> {
  const row = await env.DB.prepare("SELECT email,slack_webhook_url AS slackWebhookUrl,delay_minutes AS delayMinutes FROM alert_settings WHERE account_id=?").bind(accountId).first<AlertSettings>();
  return row ?? { ...DEFAULTS };
}

export async function saveAlertSettings(env: Env, accountId: string, settings: AlertSettings): Promise<void> {
  await env.DB.prepare("INSERT INTO alert_settings(account_id,email,slack_webhook_url,delay_minutes,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET email=excluded.email,slack_webhook_url=excluded.slack_webhook_url,delay_minutes=excluded.delay_minutes,updated_at=excluded.updated_at")
    .bind(accountId, settings.email, settings.slackWebhookUrl, settings.delayMinutes, Date.now()).run();
}

/** Alert settings of the account that owns a session, or null when the session has no owner. */
export async function getSessionAlertSettings(env: Env, session: string): Promise<AlertSettings | null> {
  const row = await env.DB.prepare("SELECT s.account_id AS accountId,a.email,a.slack_webhook_url AS slackWebhookUrl,a.delay_minutes AS delayMinutes FROM account_sessions s LEFT JOIN alert_settings a ON a.account_id=s.account_id WHERE s.session_id=?")
    .bind(session).first<{ accountId: string; email: string | null; slackWebhookUrl: string | null; delayMinutes: number | null }>();
  if (!row) return null;
  return { email: row.email ?? "", slackWebhookUrl: row.slackWebhookUrl ?? "", delayMinutes: row.delayMinutes ?? DEFAULT_ALERT_DELAY_MINUTES };
}

export function alertMessage(kind: AlertKind, session: string, minutesDown = 0): { subject: string; text: string } {
  switch (kind) {
    case "down": return {
      subject: `WaSend: session "${session}" is disconnected`,
      text: `The WhatsApp session "${session}" has been disconnected for ${minutesDown} minute${minutesDown === 1 ? "" : "s"}. WaSend keeps trying to reconnect; messages cannot be sent or received until it does. You will get another message when it is back.`,
    };
    case "logged_out": return {
      subject: `WaSend: session "${session}" was unlinked`,
      text: `The WhatsApp session "${session}" was unlinked from its WhatsApp account, so it can no longer send or receive messages. Open the WaSend dashboard and pair the session again by scanning a new QR code.`,
    };
    case "recovered": return {
      subject: `WaSend: session "${session}" is connected again`,
      text: `The WhatsApp session "${session}" has reconnected and is sending and receiving messages again.`,
    };
    case "test": return {
      subject: "WaSend: test alert",
      text: "This is a test alert from WaSend. Alerts about your WhatsApp sessions will arrive here.",
    };
  }
}

const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/** Sends one alert to every configured channel and reports how each delivery went. */
export async function sendAlert(env: Env, settings: AlertSettings, message: { subject: string; text: string }): Promise<AlertDelivery[]> {
  const deliveries: AlertDelivery[] = [];
  if (settings.slackWebhookUrl) {
    try {
      const response = await fetch(settings.slackWebhookUrl, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(8_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `*${message.subject}*\n${message.text}` }),
      });
      deliveries.push(response.ok ? { channel: "slack", ok: true } : { channel: "slack", ok: false, error: `Slack answered HTTP ${response.status}` });
    } catch (error) {
      deliveries.push({ channel: "slack", ok: false, error: error instanceof Error ? error.message : "request failed" });
    }
  }
  if (settings.email) {
    if (!env.EMAIL || !env.ALERT_EMAIL_FROM) deliveries.push({ channel: "email", ok: false, error: "Email sending is not set up on this deployment" });
    else {
      try {
        await env.EMAIL.send({ to: settings.email, from: env.ALERT_EMAIL_FROM, subject: message.subject, text: message.text, html: `<p>${escapeHtml(message.text)}</p>` });
        deliveries.push({ channel: "email", ok: true });
      } catch (error) {
        deliveries.push({ channel: "email", ok: false, error: error instanceof Error ? error.message : "send failed" });
      }
    }
  }
  return deliveries;
}

/**
 * Alerts the owner of a session. Returns true when the alert needs no retry: it reached at least
 * one channel, or the owner has no channel configured.
 */
export async function notifySessionOwner(env: Env, session: string, kind: AlertKind, minutesDown = 0): Promise<boolean> {
  const settings = await getSessionAlertSettings(env, session);
  if (!settings || (!settings.slackWebhookUrl && !settings.email)) return true;
  const deliveries = await sendAlert(env, settings, alertMessage(kind, session, minutesDown));
  return deliveries.some((delivery) => delivery.ok);
}
