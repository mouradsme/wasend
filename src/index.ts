import type { Env } from "./types";
import { errorResponse, HttpError, json, MESSAGE_BODY_LIMIT, readJson, validId } from "./lib/http";
import { changePassword, createAccount, createApiKey, hashPassword, listApiKeys, login, requireAccount, requireSuperAdmin, revokeApiKey, sha } from "./lib/auth";
import { alertMessage, emailAvailable, getAlertSettings, parseAlertSettings, saveAlertSettings, sendAlert } from "./lib/alerts";
import { WhatsAppSession } from "./durable/session";

export { WhatsAppSession };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "wasend" });
    if (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/favicon.ico") return env.ASSETS.fetch(request);
    try {
      if (url.pathname.startsWith("/v1/") && !(await withinLimit(env.EDGE_LIMIT, request.headers.get("cf-connecting-ip") ?? "unknown"))) return rateLimited();
      if (url.pathname === "/v1/auth/login" && request.method === "POST") {
        if (!(await withinLimit(env.LOGIN_LIMIT, request.headers.get("cf-connecting-ip") ?? "unknown"))) return rateLimited();
        const body = await readJson<{ email: string; password: string }>(request);
        const result = await login(env, typeof body.email === "string" ? body.email : "", typeof body.password === "string" ? body.password : "");
        if (!result) throw new HttpError(401, "invalid_credentials", "Email or password is incorrect");
        return json(result);
      }
      if (url.pathname.startsWith("/v1/admin/accounts")) return await adminAccounts(request, env, url);

      const account = await requireAccount(request, env);
      if (!(await withinLimit(env.ACCOUNT_LIMIT, account.id))) return rateLimited();
      if (url.pathname === "/v1/auth/logout" && request.method === "POST") {
        if (account.auth !== "login") throw new HttpError(400, "login_required", "API keys are revoked from the dashboard, not logged out");
        const token = request.headers.get("authorization")!.match(/^Bearer\s+(\S+)$/i)![1];
        await env.DB.prepare("DELETE FROM access_tokens WHERE token_hash=?").bind(await sha(token)).run();
        return json({ loggedOut: true });
      }
      if (url.pathname === "/v1/auth/me" && request.method === "GET") return json({ account });
      if (url.pathname === "/v1/auth/password" && request.method === "POST") {
        if (account.auth !== "login") throw new HttpError(403, "login_required", "Change the password with a login token, not an API key");
        // Same throttle as login: this route also checks a password.
        if (!(await withinLimit(env.LOGIN_LIMIT, account.id))) return rateLimited();
        const body = await readJson<{ currentPassword?: unknown; newPassword?: unknown }>(request);
        const token = request.headers.get("authorization")!.match(/^Bearer\s+(\S+)$/i)![1];
        await changePassword(env, account.id, body.currentPassword, body.newPassword, token);
        return json({ changed: true });
      }
      const apiKey = url.pathname.match(/^\/v1\/api-keys(?:\/([\w-]+))?$/);
      if (apiKey) {
        // A leaked key must not be able to mint or revoke keys, so key management needs a dashboard login.
        if (account.auth !== "login") throw new HttpError(403, "login_required", "Manage API keys with a login token, not an API key");
        if (request.method === "GET" && !apiKey[1]) return json({ apiKeys: await listApiKeys(env, account.id) });
        if (request.method === "POST" && !apiKey[1]) return json(await createApiKey(env, account.id, (await readJson<{ name?: unknown }>(request)).name), 201);
        if (request.method === "DELETE" && apiKey[1]) { await revokeApiKey(env, account.id, apiKey[1]); return json({ revoked: true }); }
        throw new HttpError(405, "method_not_allowed", "Method not allowed for this route");
      }
      if (url.pathname === "/v1/alerts" || url.pathname === "/v1/alerts/test") {
        // Alert destinations include a Slack webhook URL, which is a credential; keep it to dashboard logins.
        if (account.auth !== "login") throw new HttpError(403, "login_required", "Manage alerts with a login token, not an API key");
        if (url.pathname === "/v1/alerts" && request.method === "GET") return json({ ...(await getAlertSettings(env, account.id)), emailAvailable: emailAvailable(env) });
        if (url.pathname === "/v1/alerts" && request.method === "PUT") {
          const settings = parseAlertSettings(await readJson<unknown>(request));
          await saveAlertSettings(env, account.id, settings);
          return json({ ...settings, emailAvailable: emailAvailable(env) });
        }
        if (url.pathname === "/v1/alerts/test" && request.method === "POST") {
          const settings = await getAlertSettings(env, account.id);
          if (!settings.slackWebhookUrl && !settings.email) throw new HttpError(400, "no_alert_destination", "Save a Slack webhook or an email address first");
          return json({ deliveries: await sendAlert(env, settings, alertMessage("test", "")) });
        }
        throw new HttpError(405, "method_not_allowed", "Method not allowed for this route");
      }
      if (url.pathname === "/v1/sessions" && request.method === "GET") {
        const rows = await env.DB.prepare("SELECT session_id AS id,created_at AS createdAt FROM account_sessions WHERE account_id=? ORDER BY created_at DESC").bind(account.id).all();
        return json({ sessions: rows.results });
      }
      if (url.pathname === "/v1/sessions" && request.method === "POST") {
        const body = await readJson<{ id: string }>(request);
        if (!validId(body.id ?? "")) throw new HttpError(400, "invalid_session_id", "Session id must be 1–64 letters, digits, _ or -");
        try { await env.DB.prepare("INSERT INTO account_sessions(account_id,session_id,created_at) VALUES(?,?,?)").bind(account.id, body.id, Date.now()).run(); }
        catch { throw new HttpError(409, "session_exists", "That session id is already registered"); }
        return json({ id: body.id, state: "unpaired" }, 201);
      }

      const match = url.pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(pair|messages|events|webhooks)(?:\/([^/]+))?)?$/);
      if (!match || !validId(match[1])) throw new HttpError(404, "not_found", "Route not found");
      const session = match[1], operation = match[2], subId = match[3];
      await assertSession(env, account.id, session);
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(session));
      if (request.method === "GET" && !operation) return stub.fetch(new Request(`https://do/status?session=${encodeURIComponent(session)}`));
      if (request.method === "POST" && operation === "pair") return stub.fetch(new Request(`https://do/pair?session=${encodeURIComponent(session)}`, { method: "POST" }));
      if (request.method === "POST" && operation === "messages") {
        if (!(await withinLimit(env.SEND_LIMIT, `${account.id}:${session}`))) return rateLimited();
        const body = await readJson<Record<string, unknown>>(request, MESSAGE_BODY_LIMIT);
        const key = request.headers.get("idempotency-key");
        if (key && !body.idempotencyKey) body.idempotencyKey = key;
        return stub.fetch(new Request(`https://do/messages?session=${encodeURIComponent(session)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      }
      if (request.method === "GET" && operation === "events") return stub.fetch(new Request("https://do/events"));
      if (request.method === "GET" && operation === "webhooks" && subId === "deliveries") return stub.fetch(new Request("https://do/webhooks/deliveries"));
      if (request.method === "GET" && operation === "webhooks") return stub.fetch(new Request("https://do/webhooks"));
      if (request.method === "POST" && operation === "webhooks") return stub.fetch(new Request("https://do/webhooks", { method: "POST", headers: { "content-type": "application/json" }, body: await request.text() }));
      if (request.method === "PATCH" && operation === "webhooks" && subId) return stub.fetch(new Request(`https://do/webhooks/${encodeURIComponent(subId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: await request.text() }));
      if (request.method === "DELETE" && operation === "webhooks" && subId) return stub.fetch(new Request(`https://do/webhooks/${encodeURIComponent(subId)}`, { method: "DELETE" }));
      if (request.method === "DELETE" && !operation) {
        const response = await stub.fetch(new Request("https://do/", { method: "DELETE" }));
        await env.DB.prepare("DELETE FROM account_sessions WHERE session_id=? AND account_id=?").bind(session, account.id).run();
        return response;
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed for this route");
    } catch (error) { return errorResponse(error); }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(env.SESSIONS.get(env.SESSIONS.idFromName("_maintenance")).fetch(new Request("https://do/internal/cron", { method: "POST" })));
  },
};

async function withinLimit(binding: RateLimit, key: string): Promise<boolean> {
  const result = await binding.limit({ key });
  return result.success;
}
function rateLimited(): Response {
  return new Response(JSON.stringify({ error: { code: "rate_limited", message: "Too many requests; retry shortly" } }), {
    status: 429, headers: { "content-type": "application/json; charset=utf-8", "retry-after": "60", "cache-control": "no-store" },
  });
}

async function assertSession(env: Env, accountId: string, session: string): Promise<void> {
  const row = await env.DB.prepare("SELECT 1 FROM account_sessions WHERE account_id=? AND session_id=?").bind(accountId, session).first();
  if (!row) throw new HttpError(404, "session_not_found", "Session does not belong to this account");
}

async function adminAccounts(request: Request, env: Env, url: URL): Promise<Response> {
  await requireSuperAdmin(request, env);
  const id = url.pathname.match(/^\/v1\/admin\/accounts\/([\w-]+)$/)?.[1];
  if (request.method === "GET" && !id) {
    const rows = await env.DB.prepare("SELECT id,email,role,disabled,created_at AS createdAt FROM accounts ORDER BY created_at DESC").all();
    return json({ accounts: rows.results });
  }
  if (request.method === "POST" && !id) {
    const body = await readJson<{ email: string; password: string; role?: "user" | "admin" }>(request);
    return json({ account: await createAccount(env, body.email, body.password, body.role === "admin" ? "admin" : "user") }, 201);
  }
  if (!id) throw new HttpError(405, "method_not_allowed", "Method not allowed");
  if (request.method === "PATCH") {
    const body = await readJson<{ email?: string; password?: string; disabled?: boolean; role?: "user" | "admin" }>(request);
    const account = await env.DB.prepare("SELECT id FROM accounts WHERE id=?").bind(id).first();
    if (!account) throw new HttpError(404, "account_not_found", "Account not found");
    if (body.email !== undefined) {
      if (typeof body.email !== "string" || !/^\S+@\S+\.\S+$/.test(body.email)) throw new HttpError(400, "invalid_email", "Use a valid email address");
      try { await env.DB.prepare("UPDATE accounts SET email=? WHERE id=?").bind(body.email.trim().toLowerCase(), id).run(); }
      catch { throw new HttpError(409, "email_exists", "An account with that email already exists"); }
    }
    if (body.password !== undefined) {
      if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 256) throw new HttpError(400, "invalid_password", "Password must be 12–256 characters");
      const { salt, hash } = await hashPassword(body.password);
      await env.DB.prepare("UPDATE accounts SET password_salt=?,password_hash=? WHERE id=?").bind(salt, hash, id).run();
      await env.DB.prepare("DELETE FROM access_tokens WHERE account_id=?").bind(id).run();
    }
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== "boolean") throw new HttpError(400, "invalid_disabled", "disabled must be a boolean");
      await env.DB.prepare("UPDATE accounts SET disabled=? WHERE id=?").bind(body.disabled ? 1 : 0, id).run();
    }
    if (body.role !== undefined) {
      if (body.role !== "user" && body.role !== "admin") throw new HttpError(400, "invalid_role", "Role must be user or admin");
      await env.DB.prepare("UPDATE accounts SET role=? WHERE id=?").bind(body.role, id).run();
    }
    const updated = await env.DB.prepare("SELECT id,email,role,disabled,created_at AS createdAt FROM accounts WHERE id=?").bind(id).first();
    return json({ account: updated });
  }
  if (request.method === "DELETE") {
    const owned = await env.DB.prepare("SELECT session_id FROM account_sessions WHERE account_id=?").bind(id).all<{ session_id: string }>();
    for (const row of owned.results) {
      await env.SESSIONS.get(env.SESSIONS.idFromName(row.session_id)).fetch(new Request("https://do/", { method: "DELETE" }));
    }
    const result = await env.DB.prepare("DELETE FROM accounts WHERE id=?").bind(id).run();
    if (!result.meta.changes) throw new HttpError(404, "account_not_found", "Account not found");
    return json({ deleted: true });
  }
  throw new HttpError(405, "method_not_allowed", "Method not allowed for this route");
}
