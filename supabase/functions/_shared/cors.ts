// Shared CORS helper for Edge Functions.
//
// Background
// ----------
// The Supabase gateway normally handles CORS preflights and adds
// `Access-Control-Allow-Origin: *` to every response. When a function
// is deployed with `--no-verify-jwt`, the gateway forwards OPTIONS
// into the function body AND strips its own CORS headers from the
// response, leaving the function responsible for CORS end-to-end.
//
// Without these headers, the browser blocks every cross-origin fetch
// from the Vercel-hosted frontend with:
//   "No 'Access-Control-Allow-Origin' header is present on the
//    requested resource."
//
// Usage
// -----
//   import { corsHeaders, jsonResponse, errorResponse, handleOptions } from "../_shared/cors.ts";
//
//   serve(async (req: Request) => {
//     if (req.method === "OPTIONS") return handleOptions(req);
//     // ... your handler
//     return jsonResponse({ data: ... });  // includes CORS headers
//   });
//
// `handleOptions` returns a 204 with the CORS headers. `jsonResponse`
// and `errorResponse` wrap JSON bodies with the same headers so that
// the actual response (not just the preflight) is allowed by browsers.
//
// The CORS policy here is intentionally permissive (Access-Control-Allow-Origin: *)
// because the functions are read-only public-data wrappers (market quotes, AI chat)
// that authenticate via the Supabase anon key + user JWT. Tighten Allow-Origin
// to a specific list if you ever add write operations.

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
  // Vary on Origin so caches don't serve a wildcard CORS response to a
  // credentialed request and vice versa.
  'Vary': 'Origin',
};

export function handleOptions(_req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ success: false, error: message }, status);
}
