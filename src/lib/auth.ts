import type { Env } from "../types";
import { HttpError } from "./http";

const encoder = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

// Cloudflare Workers reject PBKDF2 above 100,000 iterations, so this is the platform maximum.
const PBKDF2_ITERATIONS = 100_000;

async function passwordDigest(password: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, material, 256);
  return b64(new Uint8Array(bits));
}

/** Fresh salt + digest for storing a new or changed password. */
export async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64(salt), hash: await passwordDigest(password, salt) };
}

export async function createAccount(env: Env, email: string, password: string, role: "user" | "admin" = "user") {
  if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email) || typeof password !== "string" || password.length < 12 || password.length > 256) throw new HttpError(400, "invalid_account", "Use a valid email and password of 12–256 characters");
  if (role !== "user" && role !== "admin") throw new HttpError(400, "invalid_role", "Role must be user or admin");
  const id = `acct_${crypto.randomUUID()}`;
  const { salt, hash } = await hashPassword(password);
  try {
    await env.DB.prepare("INSERT INTO accounts(id,email,password_salt,password_hash,role,created_at) VALUES(?,?,?,?,?,?)")
      .bind(id, email.trim().toLowerCase(), salt, hash, role, Date.now()).run();
  } catch (error) {
    // Only a duplicate email is a conflict; any other failure must surface as itself.
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) throw new HttpError(409, "email_exists", "An account with that email already exists");
    throw error;
  }
  return { id, email: email.trim().toLowerCase(), role };
}

export async function login(env: Env, email: string, password: string): Promise<{ token: string; expiresAt: number; account: { id: string; email: string; role: string } } | null> {
  if (typeof email !== "string" || typeof password !== "string" || password.length > 256) return null;
  const row = await env.DB.prepare("SELECT id,email,password_salt,password_hash,role,disabled FROM accounts WHERE email=? COLLATE NOCASE").bind(email.trim()).first<any>();
  if (!row || row.disabled || !safeEqual(await passwordDigest(password, unb64(row.password_salt)), row.password_hash)) return null;
  const token = `ws_${b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, "")}`;
  const expiresAt = Date.now() + 12 * 60 * 60_000;
  await env.DB.prepare("INSERT INTO access_tokens(token_hash,account_id,expires_at,created_at) VALUES(?,?,?,?)").bind(await sha(token), row.id, expiresAt, Date.now()).run();
  return { token, expiresAt, account: { id: row.id, email: row.email, role: row.role } };
}

const API_KEY_PREFIX = "wsk_";
const MAX_API_KEYS = 20;

export interface AuthenticatedAccount { id: string; email: string; role: string; /** How the caller authenticated. */ auth: "login" | "api_key"; }

/** Accepts either a 12-hour login token or a long-lived API key as the Bearer credential. */
export async function requireAccount(request: Request, env: Env): Promise<AuthenticatedAccount> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) throw new HttpError(401, "unauthorized", "A valid Bearer token is required");
  if (token.startsWith(API_KEY_PREFIX)) {
    const row = await env.DB.prepare("SELECT a.id,a.email,a.role FROM api_keys k JOIN accounts a ON a.id=k.account_id WHERE k.key_hash=? AND a.disabled=0").bind(await sha(token)).first<{ id: string; email: string; role: string }>();
    if (!row) throw new HttpError(401, "unauthorized", "API key is invalid or revoked");
    return { ...row, auth: "api_key" };
  }
  const row = await env.DB.prepare("SELECT a.id,a.email,a.role FROM access_tokens t JOIN accounts a ON a.id=t.account_id WHERE t.token_hash=? AND t.expires_at>? AND a.disabled=0").bind(await sha(token), Date.now()).first<{ id: string; email: string; role: string }>();
  if (!row) throw new HttpError(401, "unauthorized", "Bearer token is invalid or expired");
  return { ...row, auth: "login" };
}

/** Creates a long-lived key for server-to-server calls. The secret is returned once; only its hash is stored. */
export async function createApiKey(env: Env, accountId: string, name: unknown) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 64) throw new HttpError(400, "invalid_api_key_name", "name must be 1–64 characters");
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE account_id=?").bind(accountId).first<{ count: number }>();
  if ((count?.count ?? 0) >= MAX_API_KEYS) throw new HttpError(409, "api_key_limit", `An account can hold at most ${MAX_API_KEYS} API keys; revoke one first`);
  const key = `${API_KEY_PREFIX}${b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")}`;
  const record = { id: `key_${crypto.randomUUID()}`, name: name.trim(), prefix: key.slice(0, 12), createdAt: Date.now() };
  await env.DB.prepare("INSERT INTO api_keys(id,account_id,name,key_hash,key_prefix,created_at) VALUES(?,?,?,?,?,?)").bind(record.id, accountId, record.name, await sha(key), record.prefix, record.createdAt).run();
  return { ...record, key };
}

export async function listApiKeys(env: Env, accountId: string) {
  const rows = await env.DB.prepare("SELECT id,name,key_prefix AS prefix,created_at AS createdAt FROM api_keys WHERE account_id=? ORDER BY created_at DESC").bind(accountId).all();
  return rows.results;
}

export async function revokeApiKey(env: Env, accountId: string, id: string): Promise<void> {
  const result = await env.DB.prepare("DELETE FROM api_keys WHERE id=? AND account_id=?").bind(id, accountId).run();
  if (!result.meta.changes) throw new HttpError(404, "api_key_not_found", "API key not found");
}

export async function requireSuperAdmin(request: Request, env: Env): Promise<void> {
  if (!env.SUPER_ADMIN_TOKEN) throw new HttpError(503, "not_configured", "SUPER_ADMIN_TOKEN is not configured");
  const value = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  if (!safeEqual(value, env.SUPER_ADMIN_TOKEN)) throw new HttpError(403, "forbidden", "Super-admin Bearer token required");
}

export async function sha(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map(x => x.toString(16).padStart(2, "0")).join("");
}
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a), y = encoder.encode(b); let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
