/**
 * Contract between the session Durable Object and the WhatsApp transport.
 *
 * The WhatsApp Web protocol itself (QR linking, encryption, framing) is not implemented in this
 * repository; it comes from a client library wrapped by SocketProtocolClient (socket-client.ts),
 * which runs inside the session DO.
 */

export interface IncomingText { id: string; from: string; text: string; timestamp: number; }

export type ProtocolState = "unpaired" | "pairing" | "connected" | "disconnected" | "logged_out";

export interface ProtocolClient {
  /** Resolve once the client is listening; socket state changes arrive via onState. */
  start(onText: (message: IncomingText) => Promise<void>, onState: (state: ProtocolState) => Promise<void>): Promise<void>;
  /** Begin (or refresh) QR pairing and return the short-lived QR payload. */
  pair(): Promise<{ qr: string }>;
  /** Current protocol session state without opening a socket. */
  state(): Promise<ProtocolState>;
  sendText(to: string, text: string): Promise<{ providerMessageId: string }>;
  close(): Promise<void>;
}
