import type { Env } from "./types";
import { errorResponse, HttpError, json, readJson, validId } from "./lib/http";
import { WhatsAppSession } from "./durable/session";

export { WhatsAppSession };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "wasend" });
    try {
      authenticate(request, env);
      const match = url.pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(pair|messages))?$/);
      if (!match || !validId(match[1])) throw new HttpError(404, "not_found", "Route not found");
      const session = match[1];
      const operation = match[2];
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(session));
      if (request.method === "GET" && !operation) return stub.fetch(new Request("https://do/status?session=" + encodeURIComponent(session)));
      if (request.method === "POST" && operation === "pair") return stub.fetch(new Request("https://do/pair?session=" + encodeURIComponent(session), { method: "POST" }));
      if (request.method === "POST" && operation === "messages") {
        const body = await readJson<Record<string, unknown>>(request);
        const key = request.headers.get("idempotency-key");
        if (key && !body.idempotencyKey) body.idempotencyKey = key;
        return stub.fetch(new Request("https://do/messages?session=" + encodeURIComponent(session), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      }
      if (request.method === "DELETE" && !operation) return stub.fetch(new Request("https://do/", { method: "DELETE" }));
      throw new HttpError(405, "method_not_allowed", "Method not allowed for this route");
    } catch (error) { return errorResponse(error); }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cron performs bounded retention cleanup only; it never maintains WhatsApp connections.
    ctx.waitUntil(env.SESSIONS.get(env.SESSIONS.idFromName("_maintenance")).fetch(new Request("https://do/internal/cron", { method: "POST" })));
  },
};

function authenticate(request: Request, env: Env): void {
  if (!env.API_TOKEN) throw new HttpError(503, "not_configured", "Set API_TOKEN as a secret before using the API");
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!supplied || !constantTimeEqual(supplied, env.API_TOKEN)) throw new HttpError(401, "unauthorized", "A valid bearer token is required");
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
