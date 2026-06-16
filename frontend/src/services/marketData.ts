// Market Data Service - calls the Supabase market-data Edge Function
// which fetches real-time US stock quotes from Finnhub (with caching).
//
// This service exposes:
//   - getQuote(ticker)               - single quote, cache-aware
//   - getQuotes(tickers[])           - batch quotes
//   - refreshQuote(ticker)           - force-refresh a single ticker
//   - searchTickers(q)               - search for ticker symbols
//   - useLivePrices(tickers, ms)     - React hook with auto-refresh
//
// All endpoints require a logged-in Supabase user. The user's session
// access_token is automatically attached by the supabase-js client.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/market-data`;

export interface StockQuote {
  ticker: string;
  current_price: number;
  previous_close: number | null;
  change_pct: number | null;
  day_high: number | null;
  day_low: number | null;
  day_open: number | null;
  volume: number | null;
  company_name: string | null;
  sector: string | null;
  asset_class?: string | null;
  bbg_symbol?: string | null;
  contract_size?: number | null;
  currency?: string | null;
  expiry_date?: string | null;
  last_updated: string;
  from_cache?: boolean;
  _stale?: boolean;
}

interface QuoteResponse {
  success: boolean;
  data: StockQuote;
  from_cache?: boolean;
  warning?: string;
  error?: string;
}

interface BatchResponse {
  success: boolean;
  data: Record<string, StockQuote>;
  refreshed: string[];
  cached: number;
  error?: string;
}

interface SearchResult {
  ticker: string;
  description: string;
  type: string;
}

/**
 * Get the user's current access token, refreshing if needed.
 * Returns null if the user is not authenticated.
 */
async function getAuthHeader(): Promise<Record<string, string> | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return null;
  return {
    Authorization: `Bearer ${session.access_token}`,
    apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  };
}

/**
 * Fetch a single quote. Cache-aware (5 min TTL on server).
 * Returns null on error (caller should fall back to avg_price).
 */
export async function getQuote(ticker: string): Promise<StockQuote | null> {
  const headers = await getAuthHeader();
  if (!headers) throw new Error('Not authenticated');
  const upper = ticker.trim().toUpperCase();
  if (!upper) return null;

  const res = await fetch(`${FN_BASE}/quote?ticker=${encodeURIComponent(upper)}`, {
    method: 'GET',
    headers,
  });
  const json: QuoteResponse = await res.json();
  if (!res.ok || !json.success) {
    console.error(`getQuote(${upper}) failed:`, json.error || res.status);
    return null;
  }
  return json.data;
}

/**
 * Fetch multiple quotes at once. Server returns cached values for fresh
 * tickers and refreshes stale/missing ones. Up to 50 tickers per call.
 */
export async function getQuotes(tickers: string[]): Promise<Record<string, StockQuote>> {
  const headers = await getAuthHeader();
  if (!headers) throw new Error('Not authenticated');
  if (!tickers || tickers.length === 0) return {};

  const cleaned = tickers
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  if (cleaned.length === 0) return {};

  const res = await fetch(`${FN_BASE}/quotes?tickers=${cleaned.join(',')}`, {
    method: 'GET',
    headers,
  });
  const json: BatchResponse = await res.json();
  if (!res.ok || !json.success) {
    console.error(`getQuotes failed:`, json.error || res.status);
    return {};
  }
  return json.data || {};
}

/**
 * Force-refresh a single ticker, bypassing the cache.
 */
export async function refreshQuote(ticker: string): Promise<StockQuote | null> {
  const headers = await getAuthHeader();
  if (!headers) throw new Error('Not authenticated');
  const upper = ticker.trim().toUpperCase();
  if (!upper) return null;

  const res = await fetch(`${FN_BASE}/refresh?ticker=${encodeURIComponent(upper)}`, {
    method: 'POST',
    headers,
  });
  const json: QuoteResponse = await res.json();
  if (!res.ok || !json.success) {
    console.error(`refreshQuote(${upper}) failed:`, json.error || res.status);
    return null;
  }
  return json.data;
}

/**
 * Search for ticker symbols matching a query string.
 * Returns up to 10 common-stock matches.
 */
export async function searchTickers(query: string): Promise<SearchResult[]> {
  const headers = await getAuthHeader();
  if (!headers) throw new Error('Not authenticated');
  const q = query.trim();
  if (!q) return [];

  const res = await fetch(`${FN_BASE}/search?q=${encodeURIComponent(q)}`, {
    method: 'GET',
    headers,
  });
  const json = await res.json();
  if (!res.ok || !json.success) return [];
  return json.data || [];
}

/**
 * React hook: returns a live-updating map of ticker -> StockQuote.
 * Auto-refreshes every `intervalMs` milliseconds (default 60s).
 * Skips fetching if `tickers` is empty.
 */
export function useLivePrices(
  tickers: string[],
  intervalMs: number = 60_000,
): {
  quotes: Record<string, StockQuote>;
  loading: boolean;
  refreshing: boolean;
  lastUpdated: Date | null;
  refresh: () => Promise<void>;
} {
  const [quotes, setQuotes] = useState<Record<string, StockQuote>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refresh = async () => {
    if (!tickers || tickers.length === 0) {
      setLoading(false);
      return;
    }
    const isFirst = loading;
    if (isFirst) setLoading(true); else setRefreshing(true);
    try {
      const data = await getQuotes(tickers);
      setQuotes(data);
      setLastUpdated(new Date());
    } catch (err) {
      console.error('useLivePrices refresh failed:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    refresh();
    if (tickers.length === 0) return;
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers.join(','), intervalMs]);

return { quotes, loading, refreshing, lastUpdated, refresh };
}
