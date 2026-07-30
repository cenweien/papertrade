// Supabase client - direct connection to your Supabase project.
//
// In "local" mode (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY unset) we still
// export a usable `supabase` object so every callsite in db.ts / marketData.ts
// compiles unchanged. It just rejects every method with a clear error: "Supabase
// not configured". The Dashboard renders empty, the App.tsx auth bypass kicks
// the user straight past /login, and prices still come from the local relay.
// See LOCAL_SETUP.md for the full picture.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL ?? '') as string;
export const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '') as string;

function makeMissingClient(): SupabaseClient {
  const fn = () => {
    throw new Error(
      'Supabase not configured (set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in frontend/.env.local, ' +
      'or run with VITE_AUTH_MODE=mock and VITE_DATA_MODE=direct against the local Python relay).',
    );
  };
  // Proxy every property access so .from(...).select(), .auth.getSession(),
  // .auth.signOut() etc. all surface the same clear error rather than NPE.
  const proxyTarget: any = {
    auth: {
      getSession: fn,
      getUser: fn,
      signInAnonymously: fn,
      signOut: fn,
      onAuthStateChange: fn,
    },
  };
  return new Proxy({} as SupabaseClient, {
    get: (_t, prop) => {
      if (prop === 'auth') return proxyTarget.auth;
      // For chained .from('x').select() we hand back a thenable that rejects
      // with the same error. Same shape as a real Supabase query builder.
      const query: any = {
        select: () => query,
        insert: () => query,
        update: () => query,
        upsert: () => query,
        delete: () => query,
        eq: () => query,
        neq: () => query,
        ilike: () => query,
        in: () => query,
        gte: () => query,
        lte: () => query,
        lt: () => query,
        gt: () => query,
        order: () => query,
        limit: () => query,
        range: () => query,
        maybeSingle: () => query,
        single: () => query,
        then: (onFulfilled: any, onRejected: any) =>
          Promise.reject(new Error(
            'Supabase not configured (set VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY in frontend/.env.local).',
          )).then(onFulfilled, onRejected),
      };
      return prop === 'from' ? () => query : proxyTarget[prop] ?? query;
    },
  });
}

export const supabase: SupabaseClient =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
        },
      })
    : makeMissingClient();

// Helper to call the AI Edge Function (only thing we need it for - OpenAI key protection)
export async function callAI(action: 'parse' | 'quote' | 'history', payload?: any): Promise<any> {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'callAI requires Supabase (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY). ' +
      'The local relay path does not proxy the AI Edge Function.',
    );
  }
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
