// Market Data Edge Function
// Thin relay to the bloomberg-service Python app (which lives on the firm's
// LAN and speaks to Bloomberg SAPI/B-PIPE via xbbg_sapi). The Deno runtime
// here cannot load the `blpapi` native C++ library, so we proxy HTTP calls
// to the Python service and write the responses into the `instrument_prices`
// cache table (renamed from stock_prices in migration 005) for the frontend
// and ai-service to read.
//
// Routes (unchanged from the old Finnhub-based version, so the frontend
// does not need to change):
//   GET  /market-data/quote?ticker=AAPL&asset_class=EQUITY
//                                            - single quote (cache-first)
//   GET  /market-data/quotes?tickers=AAPL,TSLA    - batch quotes
//   POST /market-data/refresh?ticker=AAPL         - force refresh
//   GET  /market-data/search?q=apple              - search for tickers
//   GET  /market-data/historical?ticker=AAPL&date=2026-06-09
//                                            - historical close (no cache)
//
// Auth: requires a valid user JWT in the Authorization header (verified
// by GoTrue). ai-service forwards the browser's JWT on inner calls —
// no separate service-to-service key. The service-role DB key never
// appears in any HTTP header.
//
// Secrets (set via `supabase secrets set`):
//   BLOOMBERG_RELAY_URL  - URL of the bloomberg-service Python app
//   BLOOMBERG_RELAY_KEY  - shared secret matching bloomberg-service's
//                          RELAY_API_KEY env var
//   SERVICE_KEY          - Supabase secret key (for writing to instrument_prices)
//   SUPABASE_URL         - auto-injected by Supabase
//   ALLOWED_ORIGINS      - optional, comma-separated (see _shared/auth.ts)
//
// Cache: 5-minute TTL on instrument_prices. The Python scheduler can also
// pre-populate the cache for tickers_in_use() in the background.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { getUserFromRequest, checkOrigin } from '../_shared/auth.ts';
import { supabaseAdmin } from '../_shared/db.ts';

// Bloomberg relay (Python service on the firm LAN).
const BLOOMBERG_RELAY_URL = Deno.env.get('BLOOMBERG_RELAY_URL') ?? '';
const BLOOMBERG_RELAY_KEY = Deno.env.get('BLOOMBERG_RELAY_KEY') ?? '';
const BLOOMBERG_TIMEOUT_MS = 8000;
const CACHE_TTL_MINUTES = 5;

interface CachedPrice {
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
  asset_class: string | null;
  bbg_symbol: string | null;
  contract_size: number | null;
  currency: string | null;
  expiry_date: string | null;
  last_updated: string;
}

interface RelayQuote {
  current_price: number;
  previous_close?: number | null;
  change_pct?: number | null;
  day_high?: number | null;
  day_low?: number | null;
  day_open?: number | null;
  volume?: number | null;
  company_name?: string | null;
  sector?: string | null;
  asset_class?: string | null;
  bbg_symbol?: string | null;
  contract_size?: number | null;
  currency?: string | null;
  expiry_date?: string | null;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ success: false, error: message }, status);
}

async function readCache(
  supabase: typeof supabaseAdmin,
  ticker: string,
): Promise<CachedPrice | null> {
  const { data, error } = await supabase
    .from('instrument_prices')
    .select('*')
    .eq('ticker', ticker.toUpperCase())
    .single();

  if (error || !data) return null;
  return data as CachedPrice;
}

async function readCacheBatch(
  supabase: typeof supabaseAdmin,
  tickers: string[],
): Promise<Record<string, CachedPrice>> {
  const { data, error } = await supabase
    .from('instrument_prices')
    .select('*')
    .in('ticker', tickers.map((t) => t.toUpperCase()));

  if (error || !data) return {};
  const map: Record<string, CachedPrice> = {};
  for (const row of data as CachedPrice[]) {
    map[row.ticker] = row;
  }
  return map;
}

function isFresh(cached: CachedPrice): boolean {
  const ageMs = Date.now() - new Date(cached.last_updated).getTime();
  return ageMs < CACHE_TTL_MINUTES * 60 * 1000;
}

/**
 * Fetch a quote from the bloomberg-service relay. Passes through the
 * `asset_class` hint so the relay can route to the right BBG suffix
 * (US Equity vs Index for futures vs Curncy for FX vs HK Equity).
 */
async function fetchBloombergQuote(
  ticker: string,
  assetClass?: string,
): Promise<RelayQuote | null> {
  if (!BLOOMBERG_RELAY_URL) {
    console.error('BLOOMBERG_RELAY_URL not configured');
    return null;
  }
  const params = new URLSearchParams({ ticker });
  if (assetClass) params.set('asset_class', assetClass);
  const url = `${BLOOMBERG_RELAY_URL.replace(/\/$/, '')}/quote?${params.toString()}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BLOOMBERG_TIMEOUT_MS);

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (BLOOMBERG_RELAY_KEY) headers['X-API-Key'] = BLOOMBERG_RELAY_KEY;

  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) {
      console.error(`Bloomberg relay error: ${res.status} for ${ticker}`);
      return null;
    }
    const body = await res.json();
    const quote = body?.data ?? body;
    if (!quote || typeof quote.current_price !== 'number' || quote.current_price === 0) {
      console.error(`Bloomberg relay returned no data for ${ticker}`);
      return null;
    }
    return quote as RelayQuote;
  } catch (err) {
    console.error(`Bloomberg relay fetch failed for ${ticker}:`, err);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function writeCache(
  supabase: typeof supabaseAdmin,
  ticker: string,
  quote: Partial<CachedPrice>,
) {
  const { error } = await supabase
    .from('instrument_prices')
    .upsert(
      {
        ticker: ticker.toUpperCase(),
        ...quote,
        last_updated: new Date().toISOString(),
      },
      { onConflict: 'ticker' },
    );
  if (error) console.error(`Cache write failed for ${ticker}:`, error);
}

/**
 * Refresh a single ticker: hit the Bloomberg relay, update cache,
 * return fresh data.
 */
async function refreshOne(
  supabase: typeof supabaseAdmin,
  ticker: string,
  assetClass?: string,
): Promise<{ data: CachedPrice; from_cache: boolean; fetch_failed?: boolean; not_found?: boolean }> {
  const upper = ticker.toUpperCase();
  const [quote, cached] = await Promise.all([
    fetchBloombergQuote(upper, assetClass),
    readCache(supabase, upper),
  ]);

  if (quote) {
    const merged = {
      ticker: upper,
      current_price: quote.current_price!,
      previous_close: quote.previous_close ?? null,
      change_pct: quote.change_pct ?? null,
      day_high: quote.day_high ?? null,
      day_low: quote.day_low ?? null,
      day_open: quote.day_open ?? null,
      volume: quote.volume ?? null,
      company_name: quote.company_name ?? cached?.company_name ?? null,
      sector: quote.sector ?? cached?.sector ?? null,
      asset_class: quote.asset_class ?? cached?.asset_class ?? null,
      bbg_symbol: quote.bbg_symbol ?? cached?.bbg_symbol ?? null,
      contract_size: quote.contract_size ?? cached?.contract_size ?? null,
      currency: quote.currency ?? cached?.currency ?? null,
      expiry_date: quote.expiry_date ?? cached?.expiry_date ?? null,
      last_updated: new Date().toISOString(),
    };
    await writeCache(supabase, upper, merged);
    return { data: merged as CachedPrice, from_cache: false };
  }

  if (cached) {
    return { data: cached, from_cache: true, fetch_failed: true };
  }

  // Clean "no Bloomberg data + no cache" miss: surface as not_found so
  // the route handler can return 404, and ai-service can produce a
  // user-friendly "no data for {ticker}" reason instead of a generic
  // 500.
  return { data: null as unknown as CachedPrice, from_cache: false, not_found: true };
}

serve(async (req: Request) => {
  // Optional Origin allowlist (ALLOWED_ORIGINS env var). Single config
  // point, no CORS header duplication with the gateway. Skip this check
  // for OPTIONS — the gateway handles preflight.
  if (req.method !== 'OPTIONS') {
    const originErr = checkOrigin(req);
    if (originErr) return originErr;
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return errorResponse('Unauthorized', 401);

    if (!BLOOMBERG_RELAY_URL) {
      return errorResponse('BLOOMBERG_RELAY_URL not configured', 500);
    }

    const supabase = supabaseAdmin;
    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const route = pathParts[pathParts.length - 1] || '';
    const searchParams = url.searchParams;

    // ---- GET /quote?ticker=AAPL&asset_class=EQUITY ----
    if (req.method === 'GET' && route === 'quote') {
      const ticker = searchParams.get('ticker')?.trim().toUpperCase();
      const assetClass = searchParams.get('asset_class')?.trim() || undefined;
      if (!ticker) return errorResponse('Missing ?ticker= param', 400);
      // Tightened: no whitespace. The bloomberg-service does the real
      // validation, but accepting spaces here lets malformed inputs flow
      // into the outbound URL.
      if (!/^[A-Z0-9.\-]{1,15}$/.test(ticker)) return errorResponse('Invalid ticker format', 400);

      const cached = await readCache(supabase, ticker);
      if (cached && isFresh(cached)) {
        return jsonResponse({ success: true, data: cached, from_cache: true }, 200);
      }

      const { data, from_cache, fetch_failed, not_found } = await refreshOne(supabase, ticker, assetClass);
      if (not_found) return errorResponse(`No data available for ${ticker}`, 404);
      return jsonResponse({
        success: true,
        data,
        from_cache,
        ...(fetch_failed && { warning: 'Serving stale cache; upstream fetch failed' }),
      }, 200);
    }

    // ---- GET /quotes?tickers=AAPL,TSLA,NVDA ----
    if (req.method === 'GET' && route === 'quotes') {
      const tickersParam = searchParams.get('tickers')?.trim();
      if (!tickersParam) return errorResponse('Missing ?tickers= param', 400);
      const tickers = tickersParam.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
      if (tickers.length === 0) return errorResponse('No valid tickers provided', 400);
      if (tickers.length > 50) return errorResponse('Max 50 tickers per request', 400);
      // Reject any malformed ticker early.
      for (const t of tickers) {
        if (!/^[A-Z0-9.\-]{1,15}$/.test(t)) return errorResponse(`Invalid ticker format: ${t}`, 400);
      }

      const cache = await readCacheBatch(supabase, tickers);
      const results: Record<string, CachedPrice> = {};
      const toRefresh: string[] = [];

      for (const t of tickers) {
        if (cache[t] && isFresh(cache[t])) {
          results[t] = cache[t];
        } else {
          toRefresh.push(t);
        }
      }

      // Small concurrency limit to avoid hammering the Bloomberg relay.
      const CONCURRENCY = 5;
      let i = 0;
      const failures: string[] = [];
      const workers = Array.from({ length: Math.min(CONCURRENCY, toRefresh.length) }, async () => {
        while (i < toRefresh.length) {
          const idx = i++;
          const t = toRefresh[idx];
          try {
            const { data, fetch_failed, not_found } = await refreshOne(supabase, t);
            if (not_found) {
              failures.push(t);
            } else if (data) {
              results[t] = fetch_failed ? { ...data, _stale: true } as any : data;
            } else if (cache[t]) {
              results[t] = { ...cache[t], _stale: true } as any;
            }
          } catch (err) {
            console.error(`Failed to refresh ${t}:`, err);
            failures.push(t);
            if (cache[t]) results[t] = { ...cache[t], _stale: true } as any;
          }
        }
      });
      await Promise.all(workers);

      return jsonResponse({
        success: true,
        data: results,
        refreshed: toRefresh.filter((t) => !failures.includes(t)),
        not_found: failures,
        cached: tickers.length - toRefresh.length,
      }, 200);
    }

    // ---- POST /refresh?ticker=AAPL&asset_class=EQUITY ----
    if (req.method === 'POST' && route === 'refresh') {
      const ticker = searchParams.get('ticker')?.trim().toUpperCase();
      const assetClass = searchParams.get('asset_class')?.trim() || undefined;
      if (!ticker) return errorResponse('Missing ?ticker= param', 400);
      if (!/^[A-Z0-9.\-]{1,15}$/.test(ticker)) return errorResponse('Invalid ticker format', 400);
      const { data, fetch_failed, not_found } = await refreshOne(supabase, ticker, assetClass);
      if (not_found) return errorResponse(`No data available for ${ticker}`, 404);
      return jsonResponse({
        success: true,
        data,
        from_cache: false,
        ...(fetch_failed && { warning: 'Refresh failed; served cache' }),
      }, 200);
    }

    // ---- GET /search?q=apple ----
    if (req.method === 'GET' && route === 'search') {
      const q = searchParams.get('q')?.trim();
      if (!q) return errorResponse('Missing ?q= param', 400);
      // Proxy to the bloomberg-service /search endpoint (which
      // implements a thin bds() wrapper — see bloomberg-service/app.py).
      const url = `${BLOOMBERG_RELAY_URL.replace(/\/$/, '')}/search?q=${encodeURIComponent(q)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), BLOOMBERG_TIMEOUT_MS);
      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (BLOOMBERG_RELAY_KEY) headers['X-API-Key'] = BLOOMBERG_RELAY_KEY;
      try {
        const res = await fetch(url, { signal: controller.signal, headers });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const msg = body?.error || body?.detail || `Bloomberg relay error: ${res.status}`;
          return errorResponse(msg, res.status);
        }
        return jsonResponse(body, 200);
      } catch (err) {
        const msg = (err as Error).name === 'AbortError'
          ? `Bloomberg relay timed out after ${BLOOMBERG_TIMEOUT_MS}ms`
          : `Bloomberg relay fetch failed: ${(err as Error).message}`;
        return errorResponse(msg, 502);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // ---- GET /historical?ticker=TSLA&date=2026-06-09 ----
    if (req.method === 'GET' && route === 'historical') {
      const ticker = searchParams.get('ticker')?.trim().toUpperCase();
      const date = searchParams.get('date')?.trim();
      if (!ticker) return errorResponse('Missing ?ticker= param', 400);
      if (!/^[A-Z0-9.\-]{1,15}$/.test(ticker)) return errorResponse('Invalid ticker format', 400);
      if (!date) return errorResponse('Missing ?date= param', 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return errorResponse('Invalid date format (expected YYYY-MM-DD)', 400);

      const url = `${BLOOMBERG_RELAY_URL.replace(/\/$/, '')}/historical?ticker=${encodeURIComponent(ticker)}&date=${encodeURIComponent(date)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), BLOOMBERG_TIMEOUT_MS);

      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (BLOOMBERG_RELAY_KEY) headers['X-API-Key'] = BLOOMBERG_RELAY_KEY;

      try {
        const res = await fetch(url, { signal: controller.signal, headers });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const msg = body?.error || body?.detail || `Bloomberg relay error: ${res.status}`;
          return errorResponse(msg, res.status === 404 ? 404 : 502);
        }
        if (!body || body.success !== true || !body.data) {
          return errorResponse('Bloomberg relay returned an invalid response', 502);
        }
        return jsonResponse({ success: true, data: body.data }, 200);
      } catch (err) {
        const msg = (err as Error).name === 'AbortError'
          ? `Bloomberg relay timed out after ${BLOOMBERG_TIMEOUT_MS}ms`
          : `Bloomberg relay fetch failed: ${(err as Error).message}`;
        console.error('historical relay error:', err);
        return errorResponse(msg, 502);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return errorResponse(`Unknown route: ${req.method} /${route}`, 404);
  } catch (err) {
    console.error('market-data error:', err);
    return errorResponse((err as Error).message || 'Internal error', 500);
  }
});
