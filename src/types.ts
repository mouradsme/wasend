export interface Env {
  SESSIONS: DurableObjectNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  EDGE_LIMIT: RateLimit;
  LOGIN_LIMIT: RateLimit;
  ACCOUNT_LIMIT: RateLimit;
  SEND_LIMIT: RateLimit;
  ENVIRONMENT: string;
  MAX_MESSAGE_CHARS: string;
  SUPER_ADMIN_TOKEN?: string;
  WEBHOOK_ALLOWED_HOSTS?: string;
  /** Cloudflare Email Service binding; only present when email alerts are set up (see README). */
  EMAIL?: SendEmail;
  /** Sender address for alert emails, on a domain onboarded to Cloudflare Email Service. */
  ALERT_EMAIL_FROM?: string;
}

export type SessionState = "unpaired" | "pairing" | "connected" | "disconnected" | "logged_out" | "unsupported";
export interface WaEvent<T = Record<string, unknown>> { id: string; type: string; session: string; createdAt: string; data: T; }
export interface MessageRequest { to: string; text: string; idempotencyKey?: string; kind?: "otp" | "transactional"; }
