/** Clean-room Workers-compatible protocol boundary; intentionally fails closed until implemented. */
export interface IncomingText { id: string; from: string; text: string; timestamp: number; }
export interface ProtocolClient {
  start(onText: (message: IncomingText) => Promise<void>, onState: (state: "connected" | "disconnected") => Promise<void>): Promise<void>;
  pair(): Promise<{ qr: string }>;
  sendText(to: string, text: string): Promise<{ providerMessageId: string }>;
  close(): Promise<void>;
}
export class UnimplementedProtocolClient implements ProtocolClient {
  async start(): Promise<void> { throw new Error("WhatsApp Web protocol client is not implemented"); }
  async pair(): Promise<{ qr: string }> { throw new Error("WhatsApp Web pairing is not implemented"); }
  async sendText(): Promise<{ providerMessageId: string }> { throw new Error("WhatsApp Web text transport is not implemented"); }
  async close(): Promise<void> {}
}
