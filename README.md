# WaSend

WaSend is a self-hosted WhatsApp gateway for short text messages such as one-time codes and order updates. You link a WhatsApp account by scanning a QR code, then your applications send messages through a REST API and receive incoming messages through signed webhooks.

It runs entirely on Cloudflare. There is no server, container, or browser to host.

## What it does

- Links one or more WhatsApp accounts ("sessions") by QR code, the same way WhatsApp Web does.
- Sends text messages through `POST /v1/sessions/{session}/messages`, authenticated with an API key.
- Delivers incoming text messages and connection changes to your HTTPS webhooks, HMAC-signed and retried.
- Provides a dashboard for sessions, pairing, test sends, API keys, webhooks, recent events, and alerts.
- Alerts you on Slack or by email when a session stays disconnected or gets unlinked.
- Supports multiple dashboard accounts, each limited to its own sessions.

It is text-only: no media, calls, groups, contact sync, or chat history.

## Cloudflare services used

| Service | What WaSend uses it for |
| --- | --- |
| Workers | The REST API, authentication, and routing. |
| Durable Objects (SQLite-backed) | One object per WhatsApp session. It holds the live WhatsApp connection, the linked-device credentials, recent events, and the webhook retry queue. Its alarm reconnects the session and delivers due webhooks. |
| D1 | Accounts, login tokens, API keys, and which account owns which session. |
| Workers Static Assets | The dashboard, a Svelte app in `dashboard/` that is built into `public/` on every deploy. |
| Rate Limiting bindings | Per-IP, per-login, per-account, and per-session send limits. |
| Cron Triggers | A maintenance sweep every five minutes. |
| Secrets | `SUPER_ADMIN_TOKEN`, which authorizes account management. |
| Email Service (optional) | Alert emails. Off until you set it up; see [Alerts](#alerts). |

The WhatsApp protocol work comes from the [Baileys](https://github.com/WhiskeySockets/Baileys) library, bundled into the Worker. Two of its dependencies do not run on Workers (`ws` and a WebAssembly helper), so `wrangler.toml` aliases them to small stand-ins in `src/shims/`.

## Deploy

You need Node.js 20 or newer and a Cloudflare account.

```bat
pnpm install
deploy.bat
```

`npm install` works too. On macOS or Linux, run `npm run deploy:auto` instead of `deploy.bat`.

The script does everything in one run:

1. Logs you in to Cloudflare (a browser window opens the first time).
2. Creates the D1 database if it does not exist and writes its ID into `wrangler.toml`.
3. Applies the database migrations.
4. Generates and uploads `SUPER_ADMIN_TOKEN` if it is not set yet. The value is printed once and saved to `.deploy-secrets.env`, which is gitignored.
5. Builds the dashboard, deploys the Worker, and prints its URL.

Running it again is safe: the existing database and secret are left untouched. Add `--dry-run` to preview the steps without changing anything, or `--skip-secrets` to manage the secret yourself.

If the rate-limit namespace IDs in `wrangler.toml` clash with others in your Cloudflare account, change them to any unused numbers.

### After the first deploy

1. Create a dashboard account. In PowerShell:

   ```powershell
   $env:WASEND_SUPER_ADMIN_TOKEN = "<SUPER_ADMIN_TOKEN from .deploy-secrets.env>"
   $env:WASEND_ACCOUNT_PASSWORD = "<a password of at least 12 characters>"
   npm run super-admin -- create --email you@example.com --role admin --api https://<your-worker>.workers.dev
   ```

2. Open the Worker URL and sign in.
3. Create a session, click **Start QR pairing**, and scan the code in WhatsApp under **Linked devices**. WhatsApp replaces the code every 20–60 seconds for about three minutes; the dashboard follows it.
4. Create an API key on the **API keys** page and start sending.
5. Set a Slack webhook or email address on the **Alerts** page so you hear about a dead session.

Other account commands: `list`, `update --id acct_... --disabled true`, and `delete --id acct_...`. Always pass `--api` with your Worker URL (or set `WASEND_API_URL`), otherwise the command targets whatever `WASEND_API_URL` your local env files contain.

## Sending a message

```sh
curl -X POST https://<your-worker>.workers.dev/v1/sessions/<session>/messages \
  -H "Authorization: Bearer wsk_..." \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-123" \
  -d '{"to":"+15551234567","text":"Your code is 123456","kind":"otp"}'
```

- `to` is an international phone number; `text` is up to 4,096 characters; `kind` is `otp` or `transactional`.
- A successful send returns `202` with `{"id":"msg_…","session":"…","status":"sent","providerMessageId":"…"}`.
- The session must be paired and `connected`, otherwise the call returns `409 session_not_connected`. Connection problems return `503 session_unavailable` or `502 send_failed`.
- Repeating a request with the same idempotency key within 24 hours returns the original result without sending again. The key can go in the `Idempotency-Key` header or an `idempotencyKey` body field.

### Authentication

Every `/v1` route except login takes `Authorization: Bearer <token>`, where the token is one of:

- **An API key (`wsk_…`)**, for your applications. It never expires until revoked, works on every session of its account, and cannot create or revoke keys. It is shown once; only its hash is stored. Each account can hold up to 20.
- **A login token**, returned by `POST /v1/auth/login` and used by the dashboard. It expires after 12 hours.

## API reference

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Public health check |
| `POST` | `/v1/auth/login` | Exchange email and password for a login token |
| `POST` | `/v1/auth/logout` | Invalidate the current login token |
| `GET` | `/v1/auth/me` | Current account |
| `GET, POST` | `/v1/api-keys` | List or create API keys (login token only) |
| `DELETE` | `/v1/api-keys/{id}` | Revoke an API key (login token only) |
| `GET, PUT` | `/v1/alerts` | Read or save alert destinations (login token only) |
| `POST` | `/v1/alerts/test` | Send a test alert to the saved destinations (login token only) |
| `GET, POST` | `/v1/sessions` | List or create sessions |
| `GET` | `/v1/sessions/{session}` | Session state, plus the current QR while pairing |
| `POST` | `/v1/sessions/{session}/pair` | Start QR pairing; returns the QR as an image data URL |
| `POST` | `/v1/sessions/{session}/messages` | Send a text message |
| `GET` | `/v1/sessions/{session}/events` | The 100 most recent events |
| `GET, POST` | `/v1/sessions/{session}/webhooks` | List or add webhooks |
| `PATCH, DELETE` | `/v1/sessions/{session}/webhooks/{id}` | Update or remove a webhook |
| `GET` | `/v1/sessions/{session}/webhooks/deliveries` | Pending and permanently failed deliveries |
| `DELETE` | `/v1/sessions/{session}` | Unlink the WhatsApp account and delete the session's data |
| `GET, POST` | `/v1/admin/accounts` | List or create accounts (super-admin token) |
| `PATCH, DELETE` | `/v1/admin/accounts/{id}` | Update or delete an account (super-admin token) |

Session IDs are 1–64 letters, digits, underscores, or hyphens.

## Webhooks

Each session can post its events to your HTTPS endpoints. Event types are `message.received`, `message.sent`, `session.connected`, `session.disconnected`, and `session.logged_out`.

Every delivery carries these headers:

- `x-wasend-event`: the event type.
- `x-wasend-event-id`: a unique ID. Delivery is at-least-once, so deduplicate on it.
- `x-wasend-timestamp` and `x-wasend-signature`: an HMAC-SHA256 signature (`sha256=…`) made with the webhook's secret, which is shown once when the webhook is created.

Failed deliveries are retried with exponential backoff up to eight times. Destinations must be public HTTPS hosts; redirects are not followed. To restrict destinations further, set `WEBHOOK_ALLOWED_HOSTS` to a comma-separated list such as `api.example.com,.trusted.example` (a leading dot allows subdomains).

## Alerts

Each account chooses where its alerts go on the dashboard's **Alerts** page: a Slack incoming webhook, an email address, or both. WaSend then sends a message when:

- a linked session has been disconnected for longer than the chosen wait (5 minutes by default, 1–120 allowed);
- a session is unlinked by WhatsApp, which is sent straight away because it needs a new QR scan;
- a session that triggered a disconnect alert is connected again.

Deleting a session yourself does not alert. **Save and send a test alert** checks each destination and shows whether it worked.

**Slack** needs no setup on the WaSend side. In Slack, create an incoming webhook (Apps → Incoming Webhooks) and paste its address. Only `https://hooks.slack.com/services/…` addresses are accepted.

**Email** is off until the deployment is set up for Cloudflare Email Service, which needs a domain that uses Cloudflare DNS:

1. Onboard the domain: `npx wrangler email sending enable yourdomain.com`.
2. In `wrangler.toml`, uncomment `ALERT_EMAIL_FROM` (set it to an address on that domain) and the `[[send_email]]` block.
3. Deploy again.

Until then the email field on the Alerts page is disabled.

Alerts are sent by the same Durable Object that holds the session, so they cannot fire if the Cloudflare account's daily usage limit is exhausted. Treat failed sends in your application as a signal too.

## Local development

```sh
pnpm install
npx wrangler d1 migrations apply wasend --local
npm run dev
```

Put `SUPER_ADMIN_TOKEN=<any long random value>` in `.dev.vars` first. `npm run dev` builds the dashboard and serves it at `http://localhost:8787/`. Pairing works locally too, since the dev server connects to WhatsApp directly.

To work on the dashboard with hot reload, also run `npm run dev:dashboard` and open `http://localhost:5173/`; it forwards API calls to the dev server above. Add `?demo` to that address to see the UI filled with sample data and no backend.

`npm test` runs the unit tests and `npm run typecheck` runs TypeScript.

## Limits and risks

- **WhatsApp terms.** Linking an automation client may violate WhatsApp's [terms of service](https://www.whatsapp.com/legal/terms-of-service) and can get the number banned. Use a dedicated number.
- **Unofficial client.** Baileys is pinned to a release candidate. A WhatsApp protocol change can break sending until the dependency is updated. After upgrading it, re-check the stand-ins in `src/shims/`; `npm test` compares one of them against the real package.
- **Free plan capacity.** A connected session keeps its Durable Object active around the clock, which uses most of the Workers Free plan's daily Durable Object duration allowance. Expect one always-on session to fit on Free; more need the Workers Paid plan.
- **Reconnects.** A deploy or a Durable Object eviction drops the WhatsApp connection. The session reconnects within about 45 seconds or on the next send, and WhatsApp delivers messages that arrived in the gap.
- **Stored data.** Linked-device credentials sit in the session's Durable Object storage without additional application-level encryption. Events are kept for 24 hours, including the text of incoming messages; the text of messages you send is not stored.
- **Rate limits.** 120 API requests per minute per IP, 8 logins per minute per IP, 120 calls per minute per account, and 20 sends per minute per session. Counters are approximate and per Cloudflare location.
- **No remote deletion.** WaSend cannot delete a sent code from the recipient's chat.
