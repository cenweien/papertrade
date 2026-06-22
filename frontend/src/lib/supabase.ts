// Supabase client - direct connection to your Supabase project
import { createClient } from '@supabase/supabase-js';

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase env vars. Create frontend/.env.local with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});

// Helper to call the AI Edge Function (only thing we need it for - OpenAI key protection)
export async function callAI(action: 'parse' | 'quote' | 'history', payload?: any): Promise<any> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const url = `${supabaseUrl}/functions/v1/ai-service/${action}`;

  const response = await fetch(url, {
    method: action === 'history' ? 'GET' : 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      // The Supabase gateway expects the anon key on every Edge Function
      // call (even authenticated ones). Without it some gateway configs
      // return 401/non-JSON, and `response.json()` then throws a generic
      // "Failed to fetch" that swallows the real cause.
      'apikey': supabaseAnonKey,
      'Content-Type': 'application/json',
    },
    body: action === 'history' ? undefined : JSON.stringify(payload),
  });

  // Defensive: the gateway can return non-JSON (e.g. an empty body on
  // a 502/504 from the upstream relay). Surface a useful error instead
  // of an opaque "Unexpected token" SyntaxError.
  const raw = await response.text();
  let data: any = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        `AI call returned non-JSON (status ${response.status}): ${raw.slice(0, 200)}`,
      );
    }
  }
  if (!response.ok || data?.success === false) {
    const msg = data?.error || data?.msg || `AI call failed: ${response.status}`;
    throw new Error(msg);
  }
  return data?.data;
}