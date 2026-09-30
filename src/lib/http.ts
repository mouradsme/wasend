export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
export async function readJson<T>(request: Request): Promise<T> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) throw new HttpError(415, "content_type_required", "Send application/json");
  if (Number(request.headers.get("content-length") ?? 0) > 16_384) throw new HttpError(413, "body_too_large", "Request body exceeds 16 KiB");
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 16_384) throw new HttpError(413, "body_too_large", "Request body exceeds 16 KiB");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}
export class HttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
  return json({ error: { code: "internal_error", message: "Request could not be completed" } }, 500);
}
export function validId(value: string): boolean { return /^[a-zA-Z0-9_-]{1,64}$/.test(value); }
