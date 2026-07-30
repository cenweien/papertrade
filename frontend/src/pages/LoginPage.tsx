// LoginPage - Anonymous sign-in (no email required)
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { isMockAuth } from '@/lib/mockAuth';

export function LoginPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    if (isMockAuth()) {
      navigate('/');
      return;
    }
    if (!supabase) {
      setError('Supabase not configured. See LOCAL_SETUP.md.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      // onAuthStateChange listener in App.tsx will redirect to dashboard automatically
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-primary-50 to-slate-100 p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="mb-2 text-4xl font-bold text-slate-900">📊 PaperTrade</h1>
          <p className="text-slate-600">Multi-Portfolio Paper Trading Platform</p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="mb-2 text-xl font-semibold text-slate-900">Welcome</h2>
          <p className="mb-6 text-sm text-slate-600">
            Click below to start paper trading. No email or password required.
          </p>

          <button
            onClick={handleSignIn}
            disabled={loading}
            className="btn-primary w-full"
          >
            {loading ? 'Loading...' : 'Continue'}
          </button>

          {error && (
            <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-slate-500">
          By using this app, you agree to use it for paper trading only.
        </p>
      </div>
    </div>
  );
}
