# WaSend Implementation Specification

**Status:** MVP implementation plan  
**Product:** WaSend — a from-scratch, text-only WhatsApp transactional messaging gateway  
**Deployment target:** Cloudflare Workers Free plan and its free services; no VPS  
**Last checked:** 2026-09-29

## 1. Purpose and scope

WaSend exposes an authenticated REST API for applications that need to deliver OTPs and short transactional text messages through a paired WhatsApp account. It also receives inbound text messages and delivers them to customer-configured HTTPS webhooks. OTP data is short-lived and deleted as soon as practical. The service stores only the state required to operate WhatsApp sessions, process pending work, and provide short-lived operational status.

This is a clean-room implementation. Do not port or fork OpenWA, Baileys, or another WhatsApp client. Do not use Puppeteer, Chromium, browser automation, a VPS, or an always-on external server. WhatsApp Web protocol work must be implemented directly with Workers-compatible TypeScript, Web Crypto, WebSockets, and supported runtime primitives, subject to legal and platform terms review.

### In scope for MVP

- One or more explicitly provisioned WhatsApp sessions, with a conservative default cap of one session during protocol validation.
- QR-based account pairing and session status management.
- Persistent WhatsApp Web connection owned by a SQLite-backed Durable Object (DO) per session.
- Outbound text messages for OTPs and transactional updates.
- Inbound text messages from individual chats.
- Delivery/failure status events where the protocol exposes them reliably.
- Signed webhooks, bounded retries, idempotency, and minimal event retention.
- OTP expiration and deletion.

### Explicitly out of scope

Media/files, voice/video calls, groups, broadcast lists, contact sync, presence, chat history import, message search, bulk marketing, template management, multi-device administration UI, and general-purpose WhatsApp replacement features. Do not persist message bodies except where a short-lived OTP operation explicitly requires it or where a customer has opted into receiving inbound text in a webhook. Never archive full chats.

## 2. Architecture

```text
Customer application
  │ HTTPS + API key / idempotency key
  ▼
Cloudflare Worker (REST, auth, validation, quotas)
  ├── D1 (optional control-plane records: tenants, API keys, webhook config)
  ├── Durable outbox in D1 or DO SQLite (durable work + webhook retry schedule)
  └── Durable Object namespace: WhatsAppSession
        ├── one named DO per paired WhatsApp account
        ├── protocol state machine + outbound WebSocket
        ├── encrypted auth/session material in DO SQLite
        ├── outbound send queue + message state
        └── inbound event normalization
                 │ HTTPS webhook dispatch via Worker fetch
                 ▼
        Customer HTTPS endpoint

Cron Trigger → bounded cleanup/retry sweep → enqueue/dispatch due work
```

The Worker is stateless and handles short HTTP requests. A DO is the single-writer authority for one WhatsApp session and owns its socket, protocol state, sequencing, authentication material, send queue, and inbound deduplication. A DO must never be relied on to stay continuously active merely because Cron runs. Cron is for bounded cleanup and due retries; it is not a connection keepalive. Reconnects are performed by DO lifecycle logic and alarms, and by the next authenticated API request when a disconnected object has hibernated or restarted.

### Cloudflare components (Free offerings only)

| Component | Use | Design constraint |
|---|---|---|
| Workers | REST API, auth, webhook HTTP dispatch, scheduled handler | Free plan has daily request and CPU limits; validate the current account limits before launch. |
| SQLite-backed Durable Objects | Persistent per-session coordination, WebSocket, local SQLite state | Free-plan DOs require SQLite storage. Keep the socket protocol implementation small and isolate each account. |
| D1 (optional) | Tenant/API-key metadata and webhook endpoint configuration | Keep D1 out of the hot send/receive path where possible. Daily quota exhaustion can make queries fail. |
| Cron Triggers | Periodic bounded retry and cleanup sweep | Never use frequent polling to keep sessions alive. One or a few schedules; keep each batch bounded. |
| Web Crypto API | HMAC signatures, token hashing, cryptographic protocol primitives | Check algorithm and runtime support before protocol design commits to a primitive. |
| Workers Secrets | Root secrets and deployment credentials | Never put secrets in source, vars, logs, or client responses. |

No paid Queues, R2, KV, Analytics Engine, Workflows, external database, paid plan feature, or third-party always-on compute is required for the proposed MVP. If the protocol needs a primitive or runtime capability unavailable in Workers, treat that as a feasibility blocker; do not silently move processing to a VPS.

### State ownership

- **Session DO SQLite:** protocol credentials/keys (encrypted at rest at application layer when practical), socket generation, session state, outbound message state, dedupe keys, retry metadata, OTP entries if the OTP operation is scoped to this session, and short-lived webhook outbox records.
- **D1:** tenant, hashed API-key metadata, session ownership/config, webhook URL and signing secret reference, rate-limit counters if needed, and control-plane audit metadata. Keep message/OTP hot data out of D1 unless a concrete multi-object transaction needs it.
- **Secrets:** deployment-level master key and administrative bootstrap token only. Derive per-tenant/per-session encryption keys using HKDF; store encrypted protocol credentials in DO SQLite. Rotation must be designed before production pairing.
- **No durable body archive:** persist only IDs, hashes, timestamps, status, and bounded error codes for normal messages. Webhook bodies may contain inbound text in delivery payloads but must not be copied to general logs.

## 3. Runtime and quota plan

Cloudflare Free limits are account-wide in several dimensions and can change. Current official documentation checked for this spec lists Workers at 100,000 requests/day and 10 ms CPU per HTTP/Cron invocation, with 128 MB memory and 50 subrequests per invocation; Cron has a 10 ms CPU limit on Free. SQLite DO Free allowances currently list 100,000 requests/day, 13,000 GB-s/day, 5 million row reads/day, 100,000 row writes/day, and 5 GB total SQL storage. D1 Free currently lists 5 million rows read/day, 100,000 rows written/day, 5 GB total account storage, 10 databases, and a 500 MB per-database limit. Check the account dashboard and official pages again before deployment because quotas and enforcement behavior can change. Exceeding a free quota can cause operations to fail until reset; this is an availability boundary, not merely a billing alert.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Quota-conscious rules:

1. Use one API request to validate and enqueue each send; return `202` with a message ID. Do not synchronously wait for end-to-end delivery.
2. Bound every list/sweep to a small page (for example, 25–100 due rows) and checkpoint progress. Avoid full-table scans; index `status`, `next_attempt_at`, `expires_at`, and tenant/session keys.
3. Batch SQL writes and avoid duplicate status writes. Acknowledge WebSocket protocol frames without writing a row for every transient frame.
4. Use DO alarms for per-object due work when useful; each alarm/write consumes quota. Use Cron as a coarse safety sweep, not per-message polling.
5. Apply tenant and session caps, queue limits, and per-recipient rate limits before persistence.
6. Add a circuit breaker when quota/storage errors occur. Return retryable `503` for accepted work that cannot be durably recorded; never claim a send was accepted before persistence succeeds.
7. Include account-wide shared-use headroom: the listed free quotas may be consumed by other Workers/DOs/D1 databases in the same Cloudflare account.
8. Design for bounded backpressure. When a session is offline or its queue reaches its cap, reject new sends (`429` or `503`) rather than accumulating unlimited data.

## 4. WhatsApp session lifecycle

### States

`unpaired → pairing → connecting → authenticated → online → reconnecting → online`, with terminal/operator states `logged_out`, `revoked`, `disabled`, and `protocol_error`.

Each state transition records `state`, `state_changed_at`, a sanitized `last_error_code`, and a monotonically increasing `connection_generation`. Never expose raw keys, challenge data, tokens, or protocol payloads in status endpoints.

### Pairing flow

1. An administrator creates a session through a protected control-plane route. The API allocates a stable opaque session ID and named DO ID; session creation is not available to an untrusted public caller.
2. `POST /v1/sessions/{id}/pairing` authorizes the tenant/admin, asks the DO to start pairing, and returns a short-lived QR payload or a one-time polling handle. QR material is secret and must be returned with `Cache-Control: no-store`, never logged, stored only as long as needed, and never included in analytics.
3. The client renders the QR locally. The DO processes the protocol pairing response, validates the account/device response, establishes authentication keys, and persists the minimum credentials atomically.
4. The client polls `GET /v1/sessions/{id}` or receives a future explicitly scoped status webhook until the session becomes `online` or fails.
5. On success, invalidate the QR payload, rotate the session generation, and report only masked account identity if available and necessary.
6. A logout/revoke operation clears protocol credentials, socket state, pending sends, QR material, and session-scoped OTPs according to a documented deletion policy.

QR expiration should be short (for example, 2–5 minutes); generate a fresh pairing challenge on expiry. Rate-limit pairing attempts and require admin authentication. Never allow QR retrieval through a guessed session ID alone.

### Persistent socket and reconnect

- The DO owns one outbound WebSocket to WhatsApp and serializes all protocol reads/writes through one state machine.
- Use DO WebSocket support/hibernation only if compatible with the required protocol timers and in-memory state. A live WebSocket may keep the DO from hibernating depending on the chosen API/lifecycle; measure actual duration behavior early. A persistent socket is the principal Free-tier uncertainty.
- Persist protocol state required to resume after isolate eviction. On constructor/alarm/request, load state and reconcile socket generation before opening a new connection. Prevent duplicate sockets for one session.
- Reconnect with capped exponential backoff and full jitter, e.g. 1s, 2s, 4s, 8s… capped at 5 minutes; reset backoff only after a stable online period. Respect server-provided retry hints and explicit logout/revocation responses.
- Maintain heartbeat/ping handling only as required by the protocol. Do not make synthetic Cron requests to keep the socket alive.
- On transient disconnect, retain accepted outbound jobs and retry according to their idempotency/delivery state. On authentication failure or revoked session, stop retries and mark the session `logged_out`/`revoked`, then emit a session event.
- Handle DO eviction, deployment restart, regional interruption, network loss, Cloudflare quota exhaustion, and protocol version changes as expected fault paths.

## 5. REST API contract

Base path `/v1`. All requests use HTTPS, JSON, strict schemas, bounded body sizes, and an API key in `Authorization: Bearer ...`. API keys are high-entropy, shown once, stored hashed (HMAC or a slow password hash appropriate to the key format), scoped to tenant/session/actions, revocable, and rotated without exposing secrets. Require `Idempotency-Key` for send operations. Responses include a stable `request_id`.

### Endpoints

| Method and route | Purpose | Typical response |
|---|---|---|
| `POST /v1/sessions` | Admin creates a session | `201 {id,state}` |
| `GET /v1/sessions/{id}` | Read sanitized session state | `200 {id,state,updated_at,last_error}` |
| `POST /v1/sessions/{id}/pairing` | Start or refresh QR pairing | `200 {qr,expires_at}`; no-store |
| `DELETE /v1/sessions/{id}` | Disable/logout and erase session data | `202 {id,state:"disabling"}` |
| `POST /v1/messages` | Enqueue transactional text | `202 {id,status:"queued"}` |
| `POST /v1/otp` | Enqueue OTP text with TTL policy | `202 {id,status:"queued",expires_at}` |
| `POST /v1/otp/verify` | Optional server-side OTP verify flow | `200 {verified:true}` or generic invalid/expired result |
| `GET /v1/messages/{id}` | Read bounded status metadata | `200 {id,status,created_at,updated_at}` |
| `POST /v1/webhooks` | Configure endpoint and event subscriptions | `201 {id,secret_once}` |
| `GET /v1/webhooks/{id}` | Read configuration without secret | `200 {id,url,events,enabled}` |
| `DELETE /v1/webhooks/{id}` | Disable endpoint and purge pending deliveries | `204` |

Example transactional request:

```http
POST /v1/messages
Authorization: Bearer ws_live_...
Idempotency-Key: order-1842-shipped-v1
Content-Type: application/json
```

```json
{
  "session_id": "ses_...",
  "to": "+213555000000",
  "text": "Order 1842 has shipped. Track it: https://example.test/t/1842",
  "expires_in_seconds": 3600
}
```

Example OTP request:

```json
{
  "session_id": "ses_...",
  "to": "+213555000000",
  "code": "583921",
  "ttl_seconds": 300,
  "purpose": "sign_in"
}
```

The API formats the OTP message using a configurable fixed template; do not accept arbitrary multi-kilobyte content on the OTP route. Validate E.164-like phone input and normalize to protocol JID internally. Limit text size to a small documented maximum, e.g. 2,000 Unicode code points / protocol-compatible encoded size, and reject control characters or unsupported payloads.

### Error format

```json
{
  "error": {
    "code": "session_offline",
    "message": "The session is not currently available.",
    "retryable": true
  },
  "request_id": "req_..."
}
```

Use consistent codes: `invalid_request`, `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `idempotency_conflict`, `session_offline`, `queue_full`, `quota_exceeded`, `upstream_unavailable`, and `internal_error`. Do not expose stack traces or WhatsApp protocol internals.

## 6. Message and event model

### Message lifecycle

`accepted → queued → sending → sent → delivered` where the upstream protocol provides each acknowledgement. Failures use `failed`, with a normalized failure code and retryable flag. If the remote protocol does not establish delivery, report `sent`/`accepted_by_upstream`; never label that as delivered. `unknown` is valid after an ambiguous socket failure where the upstream may have accepted the message. Do not blindly resend ambiguous sends; use protocol message IDs/deduplication support where available and document residual duplicate risk.

Message record fields: `message_id`, `tenant_id`, `session_id`, `direction`, `to/from` (minimize or hash where not needed), `kind` (`otp` or `transactional`), `status`, `created_at`, `expires_at`, `upstream_message_id`, `attempt_count`, `last_error_code`, `idempotency_key_hash`. No routine text body storage.

### Event envelope

```json
{
  "id": "evt_01...",
  "type": "message.received",
  "created_at": "2026-09-29T12:00:00.000Z",
  "api_version": "2026-01",
  "tenant_id": "ten_...",
  "session_id": "ses_...",
  "data": {
    "message_id": "msg_...",
    "from": "+213555000000",
    "kind": "text",
    "text": "Where is my order?",
    "timestamp": "2026-09-29T11:59:58.000Z"
  }
}
```

MVP event types: `message.queued`, `message.sent`, `message.delivered`, `message.failed`, `message.received`, `session.online`, `session.disconnected`, and `session.reauthentication_required`. Emit only events supported by observed protocol signals. Inbound text is customer content: deliver only to configured subscribers, redact from logs, and retain only until webhook retry/retention expiry.

Deduplicate inbound events by upstream message ID plus session ID and a bounded time window. Deduplicate API sends by tenant + route + idempotency key; same key and same normalized request returns the original ID, while same key with different request hash returns `409 idempotency_conflict`.

## 7. Webhook delivery

Webhook delivery is asynchronous. Persist an outbox record before acknowledging event creation. Dispatch via Worker `fetch()` to customer-owned HTTPS URLs. Require HTTPS except local development; validate DNS/IP destinations and re-check redirects to prevent SSRF, block loopback/private/link-local/metadata addresses, limit response/read time, response body size, and redirects. Prevent customers from selecting arbitrary headers; allow only a small safe custom-header set.

Sign exact raw request bytes with HMAC-SHA-256 and a per-endpoint secret:

- `WaSend-Event-Id: evt_...`
- `WaSend-Event: message.received`
- `WaSend-Timestamp: <unix-seconds>`
- `WaSend-Signature: v1=<hex HMAC(timestamp + "." + raw_body)>`

Document constant-time verification and timestamp tolerance (for example ±5 minutes). Include the event ID for receiver-side idempotency. Show the secret once at configuration time; support rotation with a short overlap period.

Retry network errors and `408`, `425`, `429`, and `5xx` with exponential backoff + jitter, honoring bounded `Retry-After`. Do not retry ordinary `4xx` except configured `429`; cap attempts (for example 8) and total age (for example 24 hours), then mark dead-lettered and expose status for operator inspection. Retain delivery attempts/status only for a short period (e.g. 7 days); never keep successful payload copies. Retry sweeps are bounded, indexed, and quota-aware. If delivery is delayed by a free-quota ceiling, preserve outbox rows until their retention deadline and surface degraded state.

## 8. OTP security, TTL, and privacy

Prefer WaSend as a delivery gateway while the consuming application remains authoritative for OTP validation. If WaSend hosts verification, store only a keyed hash of code + challenge ID, bind it to tenant, purpose, recipient, expiry, and attempt count, compare in constant time, and never return the code. Use a dedicated keyed HMAC secret so a database leak does not enable offline guessing of short numeric codes. Delete on successful verification, expiration, attempt cap, session deletion, and tenant deletion.

TTL is enforced at read/verify time; cleanup is eventual and runs on DO alarm/Cron. Expired records are invalid immediately even if deletion is delayed. Default TTL: 5 minutes; maximum configurable TTL: 10 minutes. Store only a masked/hash recipient where feasible. Rate limit by API key, tenant, session, recipient, IP, and purpose, with a conservative daily/per-minute cap and resend cooldown. Avoid account enumeration: verification responses should not distinguish unknown recipient from wrong/expired code where applicable.

Keep inbound text only as long as needed to dispatch webhooks. Restrict access by tenant, encrypt sensitive credentials, audit administrative session changes, implement tenant export/delete semantics, and publish a privacy/retention policy before production.

## 9. Security and abuse controls

- Validate bearer key, tenant ownership, scopes, session binding, and request signature/transport on every route.
- Rate limit at Worker layer and enforce a second queue/rate limit inside the session DO to serialize sends and protect the WhatsApp account.
- Enforce per-tenant recipient cooldown, per-session send pacing, maximum queue depth, daily send budget, OTP resend limits, and pairing attempt caps. Defaults are configuration, not promises of upstream allowance.
- Reject malformed phone numbers, overlong text, unknown fields where practical, invalid UTF-8, oversized JSON, and unsupported message types.
- Protect webhook configuration against SSRF, DNS rebinding, redirects to prohibited ranges, and secret leakage. Validate destination at dispatch time as well as setup time.
- Redact API keys, QR data, OTP codes, auth material, message bodies, and webhook signatures from logs/traces.
- Use CSRF protection only if a browser-based dashboard with cookie auth is later added; MVP API is bearer-token only.
- Add admin emergency controls: disable session, revoke tenant key, suspend endpoint, pause retries, and purge credentials/data.
- Treat WhatsApp account/number restrictions and platform terms as operational/legal risks. Clearly disclose that this is an unofficial protocol implementation unless formal access is obtained; users must assess applicable terms and local law.

## 10. TypeScript project structure

```text
src/
  index.ts                         # Worker fetch/scheduled entrypoint
  env.ts                           # Env bindings and validated config types
  router/
    routes.ts                      # Route table
    middleware.ts                  # Auth, request ID, CORS policy, rate limits
    schemas.ts                     # Zod/Valibot request and response schemas
    errors.ts                      # Stable API error mapping
  api/
    sessions.ts                    # Session control and pairing endpoints
    messages.ts                    # Transactional send/status endpoints
    otp.ts                         # OTP issue/verify and TTL rules
    webhooks.ts                    # Endpoint CRUD and delivery status
  auth/
    api-keys.ts                    # Key creation, hashing, validation, scopes
    rate-limit.ts                  # Tenant/IP/recipient budgets
    encryption.ts                  # HKDF + AES-GCM envelope helpers
  storage/
    control-db.ts                  # D1 repository; optional/minimal
    migrations/                    # D1 SQL migrations
    session-schema.ts              # DO SQLite schema/migrations
    outbox.ts                      # Durable outbox and retry queries
  session/
    WhatsAppSessionDO.ts           # One DO instance per account
    lifecycle.ts                   # Pairing/connect/reconnect state machine
    socket.ts                      # Workers-compatible WebSocket wrapper
    commands.ts                    # DO RPC command validation and serialization
    inbound.ts                     # Normalize/dedupe inbound text events
    outbound.ts                    # Queue/send/status reconciliation
  protocol/                        # Clean-room, isolated protocol implementation
    framing.ts                     # Binary node framing/stream codec
    crypto.ts                      # Protocol-required crypto adapter
    handshake.ts                   # Authenticated transport handshake
    pairing.ts                     # QR challenge and pairing exchange
    nodes.ts                        # Minimal text message/ack node codecs
    version.ts                     # Protocol compatibility gate; no silent drift
    fixtures/                      # Synthetic/redacted protocol fixtures only
  webhooks/
    dispatcher.ts                  # SSRF-safe HTTPS delivery
    signing.ts                     # HMAC v1 signatures
    retry.ts                       # Backoff, classification, dead-lettering
  jobs/
    scheduled.ts                   # Bounded cleanup/retry sweep
    retention.ts                   # Expiration and purge routines
  observability/
    logger.ts                      # Structured redacted logs
    metrics.ts                     # Counters/timers without message contents
wrangler.toml                      # SQLite DO binding, D1, cron, compatibility date
```

Protocol modules must have explicit interfaces and synthetic test fixtures. Do not copy third-party protocol source or fixtures containing real credentials. Pin a compatibility date and runtime/toolchain. Keep generated bundles within Workers Free deployment constraints; validate bundle size and startup time.

### Core interfaces

```ts
export interface MessageCommand {
  messageId: string;
  to: string;             // normalized E.164 at API boundary; protocol JID internally
  text: string;
  expiresAt: number;
  idempotencyHash: string;
}

export interface SessionPort {
  getStatus(): Promise<SessionStatus>;
  beginPairing(): Promise<PairingChallenge>;
  enqueueText(command: MessageCommand): Promise<{ messageId: string; status: MessageStatus }>;
  logout(reason: "operator" | "revoked"): Promise<void>;
}

export interface WebhookEvent<T = unknown> {
  id: string;
  type: string;
  createdAt: string;
  tenantId: string;
  sessionId: string;
  data: T;
}
```

## 11. D1 and Durable Object schema sketches

D1 is optional in the first single-tenant prototype. If used, keep schemas small and indexes targeted:

```sql
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX api_keys_tenant_idx ON api_keys(tenant_id);
CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  events_json TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX webhook_endpoints_tenant_idx ON webhook_endpoints(tenant_id, enabled);
```

DO SQLite tables should include `messages`, `otp_challenges`, `inbound_dedupe`, `webhook_outbox`, and `session_meta`. Use integer epoch timestamps, bounded payload columns, explicit indexes for due/expiry queries, and migrations that are idempotent. Avoid storing ciphertext/protocol frames longer than required. Delete expired rows in bounded batches and vacuum only if/when documented storage behavior requires it; do not run expensive maintenance on every request.

## 12. MVP phases and exit criteria

### Phase 0 — Runtime feasibility spike

- Confirm Workers Free WebSocket behavior, outbound connection requirements, Web Crypto primitives, bundle/startup limits, DO SQLite APIs, and measured active duration.
- Implement only a protocol transport skeleton and synthetic handshake harness.
- **Exit:** demonstrated that a DO can own the required outbound socket, persist/reload small state, and reconnect after eviction without relying on Cron. Document measured quota use and unsupported primitives.
- **Stop condition:** if protocol crypto/authentication cannot be safely implemented within Workers runtime and Free-tier CPU/duration constraints, revise feasibility before building product endpoints.

### Phase 1 — Protocol proof of concept

- Clean-room connection/authentication, QR pairing, session persistence, reconnect, one outbound text, upstream acknowledgment, inbound text parsing.
- **Exit:** repeatable pair → send → receive/ack → restart/reconnect cycle on Cloudflare deployment, with no browser, VPS, or paid service.

### Phase 2 — Single-tenant API

- Worker routes, API key, session status, send queue, message status, idempotency, input limits, redacted logs.
- **Exit:** API accepts a valid send once, returns stable ID, rejects duplicates safely, handles offline/backpressure behavior, and never reports delivery without an upstream delivery signal.

### Phase 3 — OTP and webhook delivery

- OTP TTL issue/verify policy, outbox, signing, retry classification, endpoint SSRF protections, event subscriptions, retention cleanup.
- **Exit:** OTP cannot be verified after expiry/deletion; webhook signatures verify against raw bytes; duplicate webhook is identifiable by event ID; retries stop at configured cap.

### Phase 4 — Free-tier hardening

- Bounded scheduled jobs, quota/error mapping, load simulation, abuse limits, operational runbook, tenant deletion, credential rotation.
- **Exit:** measured test workload stays within an explicit daily budget with headroom; storage cleanup is proven; quota exhaustion produces clear backpressure and does not lose already persisted work silently.

Do not add media, calls, groups, contacts, or full history before the text-only product is stable and separately re-scoped.

## 13. Testing and local development

Use TypeScript, a pinned Wrangler version, and Cloudflare’s local simulator (`wrangler dev`) for Worker routing, DO SQLite, alarms, and scheduled handler behavior. “Run locally without Wrangler” is not a requirement for protocol correctness: a lightweight unit harness is useful, but Cloudflare-specific bindings and lifecycle must also be exercised in the official local runtime. Local WhatsApp integration tests must use a dedicated test account and never production recipient data.

Test layers:

1. Unit tests: API schemas, phone normalization, idempotency hash, OTP HMAC/expiry, signature generation/verification, retry schedule, error classification, protocol codecs against synthetic fixtures.
2. DO tests: persistence across object reconstruction, concurrent send serialization, dedupe, queue cap, alarms, reconnect generation, atomic auth-state update.
3. Worker integration tests: auth/scope checks, routes, API errors, request limits, D1 failure mapping, webhook SSRF checks.
4. Protocol integration tests: QR pairing, reconnect, send text, inbound text, upstream ack, revoked session, protocol version mismatch. Keep a manual compatibility checklist because the upstream protocol can change without notice.
5. Failure injection: socket closes during send, ambiguous acknowledgment, duplicate inbound frame, DO eviction, malformed protocol frame, webhook timeout/429/500, quota/storage errors, expired OTP, key rotation.
6. Cloudflare deployment smoke test: verify bindings, logs are redacted, Cron runs bounded work, DO and Worker quotas visible in dashboard, no paid service bindings present.

Never use real OTP codes in fixtures. Do not add tests that automate bulk sends or abuse a real account.

## 14. Observability and operations

Emit structured logs with `request_id`, `tenant_id` (opaque), `session_id` (opaque), event type, duration, and normalized error code. Do not log phone numbers in full, text bodies, OTPs, QR contents, secrets, auth blobs, raw protocol frames, or webhook signatures. Record counters for API accepted/rejected, sends by terminal status, inbound received, reconnect attempts, session online duration, webhook outcomes/attempts, cleanup rows, queue depth, and quota/storage failures.

Cloudflare dashboard logs/metrics are the initial observability surface. Provide an authenticated status endpoint with session health and queue counts; avoid a public dashboard in MVP. Alerting can initially rely on Cloudflare notifications and an operator health check. Define runbooks for revoked account, repeated disconnect, protocol drift, quota exhaustion, webhook backlog, key compromise, and session deletion.

## 15. Failure behavior

| Failure | Required behavior |
|---|---|
| Session offline before acceptance | Reject with retryable `503`, unless durable queueing is explicitly enabled and queue has capacity. |
| Disconnect after acceptance, before send | Keep queued; retry after reconnect with a bounded TTL. |
| Disconnect during send / unknown upstream result | Mark `unknown`; reconcile or use upstream idempotency; never blindly duplicate an OTP. |
| Authentication revoked | Stop sends/retries, mark session revoked, emit event, require fresh pairing. |
| Protocol version mismatch | Fail closed; mark `protocol_error`; do not emit malformed messages or loop reconnects indefinitely. |
| Free request/CPU/storage quota exceeded | Backpressure with retryable error, preserve already persisted work, reduce job batch, surface operator alert. |
| Webhook endpoint unavailable | Retry asynchronously according to bounded schedule; retain only until retention deadline. |
| Webhook invalid/prohibited target | Reject setup or suspend destination; never perform private-network fetch. |
| OTP database/storage unavailable | Fail closed; do not send an OTP that cannot be tracked/verified when WaSend owns verification. |
| Cleanup delayed | TTL checks still invalidate expired data; cleanup catches up in bounded batches. |

## 16. Principal technical risk and go/no-go

The hardest part is implementing the WhatsApp Web protocol, authentication, encryption, pairing, transport framing, and text send/receive from scratch in the Cloudflare Workers runtime. The API, database, OTP TTL, and webhook portions are conventional. The protocol is a moving target, may require cryptographic primitives or binary codecs that need careful runtime validation, and can consume the persistent connection/duration budget even while little application work is happening. Durable Objects provide stateful WebSocket coordination, but that does not guarantee that a continuously connected WhatsApp client remains free under actual account-level quotas or that every required protocol operation fits Workers constraints.

Treat the Phase 0/1 proof as a hard gate. Measure live connection duration, DO requests/WebSocket messages, storage writes, reconnect behavior, and CPU under realistic traffic. Do not promise “free forever” or scale claims from nominal request limits. If the proof fails, report the exact runtime/protocol blocker and revisit the product boundary; do not introduce OpenWA, Puppeteer, Chromium, a VPS, or a paid Cloudflare feature as a hidden workaround.

## 17. MVP acceptance checklist

- [ ] Deployment contains only Cloudflare Free-compatible bindings/services and no VPS/browser runtime.
- [ ] One session can pair by QR; QR is secret, short-lived, uncached, and admin-protected.
- [ ] DO persists/reloads credentials and reconnects after restart without Cron keepalive.
- [ ] Authenticated API can enqueue OTP and transactional text with validation, idempotency, rate limits, and bounded queue depth.
- [ ] Inbound text is normalized, deduplicated, and delivered only to configured webhook subscriptions.
- [ ] Message status distinguishes accepted/sent/delivered/failed/unknown accurately.
- [ ] Webhooks use HMAC signatures, event IDs, bounded retries, SSRF defenses, and short retention.
- [ ] OTP codes are not logged, expire on time even if cleanup is delayed, and are deleted after verification/expiry policy.
- [ ] Session and webhook secrets are protected, rotatable, and purgeable.
- [ ] Quota exhaustion, socket failure, protocol mismatch, and webhook backlog produce explicit operational states.
- [ ] No media, calls, groups, history, contact sync, or unrelated features are included.
- [ ] Current account-specific Cloudflare quotas are checked and documented before deployment.
