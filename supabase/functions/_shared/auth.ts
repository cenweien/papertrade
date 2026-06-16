// Minimal auth helper for Edge Functions.
//
// The Supabase gateway already handles CORS and (when --verify-jwt is on)
// JWT verification. This helper does one thing: extract the authenticated
// user from the request's Authorization header by asking GoTrue to verify
// the JWT signature. It returns the user or null.
//
// No soft-decode fallback, no service-key short-circuit, no caching —
// keep it simple. If something breaks, there's exactly one place to look.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface AuthUser {
  id: string;
  email: string | null;
}

let _admin: SupabaseClient | null = null;
function getAdmin(): SupabaseClient {
  if (_admin) return _admin;
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SERVICE_KEY')!;
  _admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _admin;
}

/**
 * Extract and verify the user from the Authorization header.
 * Returns null if the header is missing, malformed, or the JWT is invalid.
 */
export async function getUserFromRequest(req: Request): Promise<AuthUser | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  if (!token) return null;
  const { data, error } = await getAdmin().auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

/**
 * Optional Origin allowlist. When ALLOWED_ORIGINS is set (comma-separated),
 * reject requests from origins not on the list with a 403. When unset,
 * accept all origins and rely on the gateway's CORS config.
 *
 * This is a single, explicit config point — no CORS headers, no OPTIONS
 * short-circuit, no overlap with the gateway.
 */
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function checkOrigin(req: Request): Response | null {
  if (ALLOWED_ORIGINS.length === 0) return null;
  const origin = req.headers.get('Origin');
  if (!origin || ALLOWED_ORIGINS.includes(origin)) return null;
  return new Response(
    JSON.stringify({ success: false, error: 'Origin not allowed' }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );
}
