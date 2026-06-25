// Market History Service
//
// Fetches daily close-price history for a list of tickers via the
// Supabase `market-data/historical-series` Edge Function. The edge
// function reads the `instrument_price_history` cache and backfills
// any missing sub-ranges from the Bloomberg relay, so callers can
// treat this as "give me ~1y of daily closes for these tickers, I
// don't care about the plumbing."
//
// This series is the input the Risk page now uses for market-derived
// Sharpe / VaR / CVaR / Sortino (see riskMetrics.ts:
// `buildMarketPortfolioReturns`).

import { supabase } from '@/lib/supabase';

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/market-data`;

export interface HistoryPoint {
  trade_date: string;     // YYYY-MM-DD
  close: number;
}

export interface HistorySeries {
  ticker: string;
  points: HistoryPoint[];
}

interface HistorySeriesResponse {
  success: boolean;
  data: HistorySeries[];
  from_cache?: boolean;
  backfilled?: string[];
  partial?: boolean;
  warning?: string;
  error?: string;
}

async function getAuthHeader(): Promise<Record<string, string> | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return null;
  return {
    Authorization: `Bearer ${session.access_token}`,
    apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  };
}

/**
 * Fetch daily close history for `tickers` over [start..end] (inclusive,
 * YYYY-MM-DD). Returns the same shape per ticker regardless of whether
 * the data came from cache or Bloomberg. Empty `points` array means
 * Bloomberg had no data for that ticker in the window.
 */
export async function getHistorySeries(
  tickers: string[],
  start: string,
  end: string,
): Promise<HistorySeries[]> {
  const headers = await getAuthHeader();
  if (!headers) throw new Error('Not authenticated');
  const cleaned = (tickers ?? [])
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  if (cleaned.length === 0) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error('start/end must be YYYY-MM-DD');
  }

  const res = await fetch(
    `${FN_BASE}/historical-series?tickers=${encodeURIComponent(cleaned.join(','))}` +
      `&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    { method: 'GET', headers },
  );
  // Defensive: the gateway can return non-JSON on a 502/504 upstream
  // failure. Same pattern as callAI() in lib/supabase.ts.
  const raw = await res.text();
  let json: HistorySeriesResponse | null = null;
  if (raw) {
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(
        `getHistorySeries returned non-JSON (status ${res.status}): ${raw.slice(0, 200)}`,
      );
    }
  }
  if (!res.ok || !json || json.success === false) {
    const msg = json?.error || json?.warning || `getHistorySeries failed: ${res.status}`;
    throw new Error(msg);
  }
  if (json.partial && json.warning) {
    // Partial backfill — surface to console but don't fail the caller;
    // riskMetrics will fall back to null metrics when there are too few
    // observations.
    console.warn(`getHistorySeries: ${json.warning}`);
  }
  // The edge function preserves the order of requested tickers. Keep
  // the contract honest for downstream consumers (map builds keyed by
  // ticker).
  return json.data ?? [];
}

/**
 * Convenience: pull the last `days` calendar days of history for the
 * given tickers, ending today (UTC). The Risk page uses this so the
 * caller doesn't have to format dates.
 */
export async function getHistorySeriesLastDays(
  tickers: string[],
  days: number,
): Promise<HistorySeries[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return getHistorySeries(tickers, fmt(start), fmt(end));
}