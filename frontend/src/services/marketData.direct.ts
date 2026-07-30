// Direct relay client — used when VITE_DATA_MODE=direct. The frontend calls
// the bloomberg-service Python relay on localhost (or any host) instead of
// going through Supabase Edge Functions. Same response shape as the
// Supabase-wrapped `marketData.ts` so the rest of the app is unaware of the
// difference.
//
// Auth: when `VITE_RELAY_API_KEY` is set, we attach an X-API-Key header
// matching bloomberg-service's RELAY_API_KEY. When it's blank we send no
// header and rely on the relay running with AUTH_DISABLED=true (the default
// in the local setup script).

import type { StockQuote, HistorySeries, HistoryPoint } from './marketData.types';

const RELAY_URL = (import.meta.env.VITE_RELAY_URL ?? 'http://localhost:8000').replace(/\/$/, '');
const RELAY_KEY = (import.meta.env.VITE_RELAY_API_KEY ?? '') as string;

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (RELAY_KEY) h['X-API-Key'] = RELAY_KEY;
  return h;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${RELAY_URL}${path}`, { method: 'GET', headers: headers() });
  const raw = await res.text();
  if (!raw) throw new Error(`Relay ${path} returned empty body (status ${res.status})`);
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Relay ${path} returned non-JSON (status ${res.status}): ${raw.slice(0, 200)}`);
  }
  if (!res.ok) {
    const detail = json?.detail ?? json?.error ?? `HTTP ${res.status}`;
    throw new Error(`Relay ${path} failed: ${detail}`);
  }
  return json as T;
}

export async function getQuote(ticker: string): Promise<StockQuote | null> {
  const upper = ticker.trim().toUpperCase();
  if (!upper) return null;
  try {
    const data = await get<StockQuote>(`/quote?ticker=${encodeURIComponent(upper)}`);
    return { ...data, from_cache: false };
  } catch (err) {
    console.error(`[direct-relay] getQuote(${upper}) failed:`, err);
    return null;
  }
}

export async function getQuotes(tickers: string[]): Promise<Record<string, StockQuote>> {
  const cleaned = tickers.map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (cleaned.length === 0) return {};
  try {
    const out = await get<Record<string, StockQuote | null>>(
      `/quotes?tickers=${encodeURIComponent(cleaned.join(','))}`,
    );
    const filtered: Record<string, StockQuote> = {};
    for (const [k, v] of Object.entries(out ?? {})) {
      if (v) filtered[k] = { ...v, from_cache: false };
    }
    return filtered;
  } catch (err) {
    console.error('[direct-relay] getQuotes failed:', err);
    return {};
  }
}

export async function refreshQuote(ticker: string): Promise<StockQuote | null> {
  const upper = ticker.trim().toUpperCase();
  if (!upper) return null;
  try {
    const res = await fetch(`${RELAY_URL}/refresh?ticker=${encodeURIComponent(upper)}`, {
      method: 'POST',
      headers: headers(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.detail ?? `HTTP ${res.status}`);
    return { ...(data as StockQuote), from_cache: false };
  } catch (err) {
    console.error(`[direct-relay] refreshQuote(${upper}) failed:`, err);
    return null;
  }
}

export async function searchTickers(query: string): Promise<Array<{ ticker: string; description: string; type: string }>> {
  const q = query.trim();
  if (!q) return [];
  try {
    const out = await get<Array<{ ticker: string; description: string; asset_class?: string | null }>>(
      `/search?q=${encodeURIComponent(q)}`,
    );
    return (out ?? []).map((r) => ({
      ticker: r.ticker,
      description: r.description ?? '',
      type: r.asset_class ?? 'EQUITY',
    }));
  } catch (err) {
    console.error('[direct-relay] searchTickers failed:', err);
    return [];
  }
}

export async function getHistorySeries(
  tickers: string[],
  start: string,
  end: string,
): Promise<HistorySeries[]> {
  const cleaned = tickers.map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (cleaned.length === 0) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error('start/end must be YYYY-MM-DD');
  }
  try {
    // The relay's /history-series uses `date` per point; the Edge Function
    // remaps that to `trade_date` to match the SQL cache table convention.
    // We do the same remap here so downstream callers (riskMetrics etc.)
    // don't care which transport produced the series.
    const out = await get<{
      success: boolean;
      data: Array<{ ticker: string; asset_class?: string | null; points: Array<{ date: string; close: number }> }>;
      warning?: string;
    }>(
      `/history-series?tickers=${encodeURIComponent(cleaned.join(','))}` +
        `&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    );
    if (out?.warning) console.warn(`[direct-relay] history-series: ${out.warning}`);
    return (out?.data ?? []).map((s) => ({
      ticker: s.ticker,
      asset_class: s.asset_class ?? null,
      points: (s.points ?? []).map((p) => ({ trade_date: p.date, close: p.close })),
    }));
  } catch (err) {
    throw new Error(`getHistorySeries failed: ${(err as Error).message}`);
  }
}
