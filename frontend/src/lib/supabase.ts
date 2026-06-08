// Supabase client - direct connection to your Supabase project
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

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
export async function callAI(action: 'parse' | 'history', payload?: any): Promise<any> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const url = `${supabaseUrl}/functions/v1/ai-service/${action}`;
  
  const response = await fetch(url, {
    method: action === 'parse' ? 'POST' : 'GET',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: action === 'parse' ? JSON.stringify(payload) : undefined,
  });

  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `AI call failed: ${response.status}`);
  }
  return data.data;
}