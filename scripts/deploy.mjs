#!/usr/bin/env node
/**
 * One-command deployment helper for WaSend (used by deploy.bat / `npm run deploy:auto`).
 *
 * Steps:
 *   1. Verify Wrangler authentication (runs `wrangler login` interactively if needed).
 *   2. Ensure the D1 database exists; backfill its id into wrangler.toml.
 *   3. Apply D1 migrations (remote).
 *   4. Ensure required secrets exist, generating random values for missing ones
 *      (SUPER_ADMIN_TOKEN). New values are printed ONCE and appended to
 *      .deploy-secrets.env (gitignored). Existing Cloudflare secrets are left untouched.
 *   5. Deploy the Worker.
 *   6. Report the deployed workers.dev URL.
 *
 * Usage: node scripts/deploy.mjs [--dry-run] [--skip-secrets]
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_SECRETS = process.argv.includes("--skip-secrets");

const ROOT = dirname(fileURLToPath(import.meta.url)); // scripts/
const PROJECT = dirname(ROOT);
const CONFIG = join(PROJECT, "wrangler.toml");
const SECRETS_FILE = join(PROJECT, ".deploy-secrets.env");
const REQUIRED_SECRETS = ["SUPER_ADMIN_TOKEN"];

function log(step, message) { console.log(`\x1b[36m[${step}]\x1b[0m ${message}`); }
function warn(message) { console.log(`\x1b[33m[!]\x1b[0m ${message}`); }

/** Resolve the locally installed Wrangler so this works outside npm scripts and on Windows. */
function resolveWrangler() {
  try {
    const bin = createRequire(join(PROJECT, "package.json")).resolve("wrangler/package.json");
    const candidate = join(dirname(bin), "bin", "wrangler.js");
    if (existsSync(candidate)) return { cmd: process.execPath, prefix: [candidate] };
  } catch { /* fall through to PATH lookup */ }
  return process.platform === "win32"
    ? { cmd: "wrangler.cmd", prefix: [] }
    : { cmd: "wrangler", prefix: [] };
}

const WRANGLER = resolveWrangler();

function run(args, opts = {}) {
  if (DRY_RUN && !opts.allowInDryRun) { console.log(`  (dry-run) wrangler ${args.join(" ")}`); return ""; }
  try {
    return execFileSync(WRANGLER.cmd, [...WRANGLER.prefix, ...args], {
      cwd: PROJECT,
      encoding: "utf8",
      // stdin must be a pipe when there is input to send (secret values); "ignore" would upload an empty secret.
      ...(opts.inherit ? { stdio: "inherit" } : { stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"] }),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    }) ?? "";
  } catch (error) {
    // Wrangler prints its banner on stdout and the actual error on stderr, so prefer stderr.
    const detail = (`${error.stderr ?? ""}`.trim() || `${error.stdout ?? ""}`.trim());
    throw new Error(`wrangler ${args[0]} failed${detail ? `:\n${detail.split("\n").slice(-20).join("\n")}` : ""}`);
  }
}

function tomlValue(key) {
  const match = readFileSync(CONFIG, "utf8").match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
  return match ? match[1] : "";
}

function setTomlValue(key, value) {
  const source = readFileSync(CONFIG, "utf8");
  const pattern = new RegExp(`^${key}\\s*=\\s*"[^"]*"`, "m");
  if (pattern.test(source)) writeFileSync(CONFIG, source.replace(pattern, `${key} = "${value}"`));
  else writeFileSync(CONFIG, `${source.trimEnd()}\n${key} = "${value}"\n`);
}

/** UUID of the D1 database with the given name from `wrangler d1 list --json`, or null. */
function findDatabase(name) {
  let raw = "";
  try { raw = run(["d1", "list", "--json"]); } catch { return null; }
  if (!raw.trim()) return null;
  try {
    const rows = JSON.parse(raw);
    const row = Array.isArray(rows) ? rows.find((entry) => entry?.name === name) : null;
    return typeof row?.uuid === "string" ? row.uuid : null;
  } catch { return null; }
}

function generateToken(bytes = 32) { return randomBytes(bytes).toString("base64url"); }

async function main() {
  log("0/6", `WaSend deploy${DRY_RUN ? " (dry run — nothing is changed)" : ""}`);

  // 1. Authentication
  log("1/6", "Checking Cloudflare authentication…");
  let authed = true;
  try { run(["whoami"], { allowInDryRun: true }); }
  catch { authed = false; }
  if (!authed) {
    if (DRY_RUN) warn("(dry-run) would run `wrangler login` — authorize in the browser when it opens");
    else {
      log("1/6", "Not authenticated. Opening browser login…");
      try { run(["login"], { inherit: true }); }
      catch { throw new Error("Wrangler login failed. Run `npx wrangler login` manually, or set CLOUDFLARE_API_TOKEN in the environment."); }
    }
  }

  // 2. D1 database
  const databaseName = tomlValue("database_name") || "wasend";
  let databaseId = tomlValue("database_id");
  if (!databaseId || databaseId.startsWith("REPLACE_WITH")) {
    log("2/6", `Looking up D1 database "${databaseName}"…`);
    databaseId = findDatabase(databaseName);
    if (!databaseId && !DRY_RUN) {
      log("2/6", `Creating D1 database "${databaseName}"…`);
      const created = run(["d1", "create", databaseName]);
      databaseId = created.match(/\b[0-9a-f]{32}\b/i)?.[0]
        ?? created.match(/database_id\s*=\s*"([^"]+)"/)?.[1]
        ?? findDatabase(databaseName);
    }
    if (!databaseId && !DRY_RUN) throw new Error(`Could not resolve the D1 database id for "${databaseName}".`);
    if (DRY_RUN) warn(`(dry-run) would resolve or create D1 database "${databaseName}" and write its id into wrangler.toml`);
    else { log("2/6", "Writing database_id into wrangler.toml"); setTomlValue("database_id", databaseId); }
  } else {
    log("2/6", `Using existing D1 database id ${databaseId.slice(0, 8)}…`);
  }

  // 3. Migrations
  log("3/6", "Applying D1 migrations (remote)…");
  run(["d1", "migrations", "apply", databaseName, "--remote"]);

  // 4. Secrets
  if (!SKIP_SECRETS) {
    log("4/6", "Ensuring Worker secrets…");
    const saved = new Map();
    if (existsSync(SECRETS_FILE)) {
      for (const line of readFileSync(SECRETS_FILE, "utf8").split("\n")) {
        const match = line.match(/^([A-Z0-9_]+)=(.+)$/);
        if (match) saved.set(match[1], match[2].trim());
      }
    }
    let secretNames = new Set();
    try {
      const parsed = JSON.parse(run(["secret", "list", "--json"], { allowInDryRun: true }).trim() || "[]");
      if (Array.isArray(parsed)) secretNames = new Set(parsed.map((entry) => entry?.name).filter(Boolean));
    } catch { warn("Could not read the existing secret list; assuming none are set yet."); }

    const generated = [];
    for (const name of REQUIRED_SECRETS) {
      if (secretNames.has(name)) { log("4/6", `  ${name}: already set in Cloudflare (left untouched)`); continue; }
      const value = saved.get(name) || generateToken();
      if (!saved.has(name)) generated.push([name, value]);
      log("4/6", `  ${name}: uploading new secret`);
      if (!DRY_RUN) run(["secret", "put", name], { input: `${value}\n` });
    }
    if (generated.length) {
      if (!DRY_RUN) {
        writeFileSync(SECRETS_FILE, `${generated.map(([n, v]) => `${n}=${v}`).join("\n")}\n`, { flag: "a" });
        log("4/6", `Generated secrets appended to .deploy-secrets.env (gitignored):`);
        for (const [name, value] of generated) console.log(`    ${name}=${value}`);
      }
      warn("Store these in a password manager. SUPER_ADMIN_TOKEN authorizes /v1/admin/accounts.");
    }
  } else {
    log("4/6", "Skipping secrets (--skip-secrets).");
  }

  // 5. Deploy
  log("5/6", "Deploying Worker…");
  const deployOutput = run(["deploy"]);

  // 6. Report where it landed
  const deployedUrl = deployOutput.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
  if (DRY_RUN) log("6/6", "(dry-run) would report the deployed URL");
  else log("6/6", deployedUrl ? `Deployed: ${deployedUrl}` : "Deploy finished (no workers.dev URL detected — use your configured route).");

  console.log("\n\x1b[32mDone.\x1b[0m Next: open the dashboard, create a session, then pair by QR (WhatsApp → Linked devices).");
  if (DRY_RUN) warn("This was a dry run; nothing was created or deployed.");
}

main().catch((error) => {
  console.error(`\n\x1b[31mDeploy failed:\x1b[0m ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
