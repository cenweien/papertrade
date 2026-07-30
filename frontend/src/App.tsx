// App.tsx - Main app with routing
import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { isMockAuth, mockSession } from '@/lib/mockAuth';
import { Layout } from '@/components/Layout';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { PortfolioDetailPage } from '@/pages/PortfolioDetailPage';
import { AIChatPage } from '@/pages/AIChatPage';
import { ComparisonPage } from '@/pages/ComparisonPage';
import { HotStocksPage } from '@/pages/HotStocksPage';
import { RiskPage } from '@/pages/RiskPage';

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Mock auth: synthesise a session, skip all network calls, render the app.
    // Database reads (db.ts) will fail with "Supabase not configured", which
    // the page-level error boundaries already tolerate — they render empty
    // charts/tables instead of crashing. See LOCAL_SETUP.md.
    if (isMockAuth()) {
      setSession(mockSession());
      setLoading(false);
      return;
    }

    if (!supabase) {
      // Supabase env not set but we weren't in mock mode either.
      // Most likely the user copied .env.example without filling it in.
      setLoading(false);
      return;
    }

    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="text-slate-600">Loading...</div>
      </div>
    );
  }

  // Mock auth always has a session (set in the effect above).
  // Otherwise: no Supabase env → show a one-line hint + login page (so the
  // user isn't bounced around without context).
  if (!session) {
    const showEnvHint = !supabase;
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="*"
          element={
            showEnvHint ? (
              <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
                <div className="max-w-lg rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
                  <p className="mb-2 font-semibold">Supabase not configured</p>
                  <p>
                    Set <code>VITE_SUPABASE_URL</code> and{' '}
                    <code>VITE_SUPABASE_ANON_KEY</code> in{' '}
                    <code>frontend/.env.local</code>, or run with{' '}
                    <code>VITE_AUTH_MODE=mock</code> for the local-only path
                    (no portfolio persistence). See{' '}
                    <code>LOCAL_SETUP.md</code>.
                  </p>
                </div>
              </div>
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />
      </Routes>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/hot" element={<HotStocksPage />} />
        <Route path="/portfolio/:id" element={<PortfolioDetailPage />} />
        <Route path="/ai" element={<AIChatPage />} />
        <Route path="/comparison" element={<ComparisonPage />} />
        <Route path="/risk" element={<RiskPage />} />
        <Route path="/risk/:portfolioId" element={<RiskPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export default App;
