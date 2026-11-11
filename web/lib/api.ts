// JSON responses for the /api routes: CORS open (read-only data), explicit cache headers, and
// one error shape: { error: { code, message } }.
export const SCHEMA = "weir-site/1";

export function json(body: unknown, status = 200, maxAge = 0): Response {
  return new Response(JSON.stringify({ schema: SCHEMA, ...(body as object) }, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": maxAge > 0 ? `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 5}` : "no-store",
    },
  });
}

export const fail = (status: number, code: string, message: string, extra: object = {}) => json({ error: { code, message }, ...extra }, status);

/** A query parameter that must be a whole number. */
export function intParam(v: string | null): number | null {
  return v !== null && /^\d{1,10}$/.test(v) ? Number(v) : null;
}
