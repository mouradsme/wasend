import type { WaEvent } from "../types";
import { validateWebhookUrl } from "./url-safety";
export async function signPayload(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
  return [...signature].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function deliverWebhook(url: string, secret: string, event: WaEvent, hostAllowlist = ""): Promise<boolean> {
  let parsed: URL;
  try { parsed = await validateWebhookUrl(url, hostAllowlist); } catch { return false; }
  const body = JSON.stringify(event), timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await signPayload(secret, timestamp, body);
  try {
    const response = await fetch(parsed, { method: "POST", redirect: "manual", body, signal: AbortSignal.timeout(8_000), headers: { "content-type": "application/json", "x-wasend-event": event.type, "x-wasend-event-id": event.id, "x-wasend-timestamp": timestamp, "x-wasend-signature": `sha256=${signature}` } });
    return response.ok;
  } catch { return false; }
}
