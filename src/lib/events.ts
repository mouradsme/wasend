import type { WaEvent } from "../types";
export function makeEvent<T>(session: string, type: string, data: T): WaEvent<T> {
  return { id: `evt_${crypto.randomUUID()}`, type, session, createdAt: new Date().toISOString(), data };
}
