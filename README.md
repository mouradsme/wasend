# WaSend

WaSend is an early Cloudflare Workers foundation for a text-only WhatsApp transactional gateway. The current code provides the API/DO boundary and SQLite schema. **The WhatsApp Web protocol is not implemented:** pairing and message sending return `503 protocol_not_implemented`; this repository is not yet a usable WhatsApp gateway.

## Local development

Requires Node.js and npm. Install dependencies with `npm install`, create `.dev.vars` with a long random `API_TOKEN`, then run `npm run dev`. `.dev.vars` is ignored by Git.

Set the production secret with `npx wrangler secret put API_TOKEN`, then deploy with `npm run deploy`. Wrangler provisions the SQLite Durable Object migration declared in `wrangler.toml`. Use one session per logical WhatsApp account; session identifiers are 1–64 letters, digits, underscores, or hyphens.

## API

All `/v1` requests require `Authorization: Bearer <API_TOKEN>`. `GET /health` is public.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/v1/sessions/{session}` | Read session state |
| `POST` | `/v1/sessions/{session}/pair` | Begin QR pairing (protocol work pending) |
| `POST` | `/v1/sessions/{session}/messages` | Send text (protocol work pending) |
| `DELETE` | `/v1/sessions/{session}` | Close and clear session data |

Message JSON: `{"to":"+15551234567","text":"Your order shipped","kind":"transactional","idempotencyKey":"order-123"}`. Use `kind: "otp"` and optional `expiresInSeconds` (clamped to 60–900 seconds) for OTP messages. The request body is not retained by this foundation; only a minimal event envelope is retained temporarily. Supply idempotency through the JSON field or `Idempotency-Key` header.

## Current limits and next implementation gates

- `src/protocol/client.ts` defines the clean-room protocol seam. Its implementation must cover WebSocket framing, authentication, cryptographic handshake/session persistence, QR linking, reconnect and text send/receive before pairing can work.
- `API_TOKEN` is a single shared bearer credential for this bootstrap. Add tenant/key storage and rate limiting before multi-customer exposure.
- Webhook HMAC signing helper exists, but webhook management, queued dispatch, backoff/dead-letter behavior and event delivery guarantees are not yet wired.
- SQLite tables are scoped to each session DO. Per-object alarms clean retained rows; Cron is reserved for bounded maintenance and must not be used to keep the socket alive.
- This foundation deliberately excludes media, calls, groups, contact sync and history import. No browser runtime, VPS or third-party WhatsApp client is used.

Do not advertise or expose this as a functioning WhatsApp sender until the protocol gate and security/webhook work are complete.
