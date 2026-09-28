export interface Env {
  SESSIONS: DurableObjectNamespace;
  ENVIRONMENT: string;
  MAX_MESSAGE_CHARS: string;
  API_TOKEN?: string;
}

export type SessionState = "unpaired" | "pairing" | "connected" | "disconnected" | "logged_out" | "unsupported";
export interface WaEvent<T = Record<string, unknown>> { id: string; type: string; session: string; createdAt: string; data: T; }
export interface MessageRequest { to: string; text: string; idempotencyKey?: string; expiresInSeconds?: number; kind?: "otp" | "transactional"; }
