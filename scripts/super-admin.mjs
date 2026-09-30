#!/usr/bin/env node
// Shell variables win, then .dev.env, then .env; SUPER_ADMIN_TOKEN from .dev.vars is the token fallback.
for (const file of [".dev.env", ".env", ".dev.vars"]) {
  try { process.loadEnvFile(new URL(`../${file}`, import.meta.url)); }
  catch (error) { if (error.code !== "ENOENT") fail(`Could not read ${file}: ${error.message}`); }
}
// pnpm forwards a literal "--" separator to the script; npm strips it.
const argv = process.argv.slice(2);
const [action, ...args] = argv[0] === "--" ? argv.slice(1) : argv;
const opts = Object.fromEntries(args.flatMap((v, i) => v.startsWith("--") ? [[v.slice(2), args[i + 1]]] : []));
const api = (opts.api || process.env.WASEND_API_URL || "").replace(/\/$/, "");
const token = process.env.WASEND_SUPER_ADMIN_TOKEN || process.env.SUPER_ADMIN_TOKEN;
if (!api || !token) fail("Set WASEND_API_URL and WASEND_SUPER_ADMIN_TOKEN in .dev.env, .env or the shell (or pass --api).");
const base = `${api}/v1/admin/accounts`;
let method = "GET", path = "", body;
if (action === "list") {}
else if (action === "create") {
  const password = process.env.WASEND_ACCOUNT_PASSWORD;
  if (!opts.email || !password) fail("Set WASEND_ACCOUNT_PASSWORD and use: npm run super-admin -- create --email user@example.com [--role user|admin]");
  method = "POST"; body = { email: opts.email, password, role: opts.role || "user" };
} else if (action === "update") {
  if (!opts.id) fail("Usage: npm run super-admin -- update --id acct_... [--email new@example.com] [--role user|admin] [--disabled true|false]; set WASEND_ACCOUNT_PASSWORD to reset the password");
  method = "PATCH"; path = `/${encodeURIComponent(opts.id)}`; body = {};
  if (process.env.WASEND_ACCOUNT_PASSWORD) body.password = process.env.WASEND_ACCOUNT_PASSWORD;
  if (opts.email) body.email = opts.email;
  if (opts.role) body.role = opts.role;
  if (opts.disabled !== undefined) body.disabled = opts.disabled === "true";
  if (!Object.keys(body).length) fail("Supply WASEND_ACCOUNT_PASSWORD and/or --role, or --disabled.");
} else if (action === "delete") {
  if (!opts.id) fail("Usage: npm run super-admin -- delete --id acct_...");
  method = "DELETE"; path = `/${encodeURIComponent(opts.id)}`;
} else fail("Commands: list, create, update, delete");

try {
  const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  if (!response.ok) fail(`Request failed (${response.status}): ${text}`);
  console.log(text ? JSON.stringify(JSON.parse(text), null, 2) : "Done");
} catch (error) { fail(error.message); }

function fail(message) { console.error(message); process.exit(1); }
