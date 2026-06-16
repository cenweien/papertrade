// Database client for Edge Functions
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SERVICE_KEY')!;

// Service role client for admin operations (bypasses RLS)
export const supabaseAdmin: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// NOTE: `createUserClient` was removed. It used `supabaseServiceKey`
// (the RLS-bypassing service-role key) while setting the caller's JWT
// as a header, producing a client that was *more* privileged than the
// user it appeared to act as. Any future helper that needs to act as
// a specific user should use the anon/publishable key so the user's
// JWT actually enforces RLS, or go through `supabaseAdmin` and add
// explicit `eq('user_id', user.id)` filters.
