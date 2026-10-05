// Small helpers for JSON responses + consistent error handling.

const JSON_HEADERS = { "content-type": "application/json" };

export function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

export function ok(data: unknown = { ok: true }): Response {
  return json(data, 200);
}

export function badRequest(message: string, details?: unknown): Response {
  return json({ error: message, details }, 400);
}

export function unauthorized(message = "Unauthorized"): Response {
  return json({ error: message }, 401);
}

export function forbidden(message = "Forbidden"): Response {
  return json({ error: message }, 403);
}

export function notFound(message = "Not found"): Response {
  return json({ error: message }, 404);
}

export function serverError(message = "Internal error", details?: unknown): Response {
  return json({ error: message, details }, 500);
}

// Wrap a handler so thrown errors never leak stack traces to clients.
export function withErrors(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await fn(req);
    } catch (err) {
      // Log the real cause; customers get a generic message (no database/internal details).
      console.error("[function error]", err);
      return serverError("Something went wrong. Please try again or call (512) 337-4340.");
    }
  };
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}
