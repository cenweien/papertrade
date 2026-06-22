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
//   GET  /market-data/historical-series?tickers=AAPL,MSFT&start=...&end=...
//                                            - multi-ticker daily history
//                                              (writes to instrument_price_history)
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
import { jsonResponse, errorResponse, handleOptions } from '../_shared/cors.ts';

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
 * Shape the cache map into the response format expected by the frontend.
 * Each requested ticker gets its own sorted point list (or empty array if
 * Bloomberg had no data and the cache had nothing either).
 */
function buildSeriesResponse(
  tickers: string[],
  cachedByTicker: Record<string, { trade_date: string; close: number }[]>,
): { ticker: string; points: { trade_date: string; close: number }[] }[] {
  return tickers.map((t) => ({
    ticker: t,
    points: (cachedByTicker[t] ?? []).map((p) => ({
      trade_date: p.trade_date,
      close: p.close,
    })),
  }));
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

/**
 * Fetch multiple quotes in a single relay call. The relay groups
 * tickers by asset class and makes one bdp() per group, which keeps
 * the B-PIPE request rate well below the per-second entitlement
 * limit. Looping /quote per ticker (the old behaviour) tripped
 * the rate limiter when HotStocksPage refreshed 7 tickers at once
 * and we saw them all 404 simultaneously in the relay log.
 *
 * Returns a map of bare ticker -> RelayQuote. Tickers that the relay
 * couldn't fetch (404, timeout, etc.) are simply absent from the map
 * — callers should treat missing entries as a hard "no data" signal
 * and fall back to the cache or surface an error state.
 */
async function fetchBloombergQuotes(
  tickers: string[],
  assetClass?: string,
): Promise<Record<string, RelayQuote>> {
  if (!BLOOMBERG_RELAY_URL) {
    console.error('BLOOMBERG_RELAY_URL not configured');
    return {};
  }
  if (!tickers || tickers.length === 0) return {};
  const params = new URLSearchParams({ tickers: tickers.join(',') });
  if (assetClass) params.set('asset_class', assetClass);
  const url = `${BLOOMBERG_RELAY_URL.replace(/\/$/, '')}/quotes?${params.toString()}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BLOOMBERG_TIMEOUT_MS);

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (BLOOMBERG_RELAY_KEY) headers['X-API-Key'] = BLOOMBERG_RELAY_KEY;

  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) {
      console.error(`Bloomberg relay /quotes error: ${res.status} for ${tickers.join(',')}`);
      return {};
    }
    const body = await res.json();
    // The relay returns either a bare map (legacy) or { data: { ... } }.
    const map = (body?.data ?? body) as Record<string, RelayQuote | null> | null;
    if (!map || typeof map !== 'object') return {};
    const out: Record<string, RelayQuote> = {};
    for (const [k, v] of Object.entries(map)) {
      if (v && typeof (v as RelayQuote).current_price === 'number' && (v as RelayQuote).current_price !== 0) {
        out[k] = v as RelayQuote;
      }
    }
    return out;
  } catch (err) {
    console.error(`Bloomberg relay /quotes fetch failed:`, err);
    return {};
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

// CORS handling is in _shared/cors.ts. Functions deployed with
// `--no-verify-jwt` have the gateway forward OPTIONS into the body
// and strip the gateway's own CORS headers, so we set them here on
// every response (preflight + actual).

serve(async (req: Request) => {
  // Short-circuit CORS preflight. The Supabase gateway would normally
  // do this, but with --no-verify-jwt it forwards OPTIONS into the
  // function body — and the body has no Authorization header on a
  // preflight, so the auth check below would 401 and the browser
  // would block the request (no Access-Control-Allow-Origin).
  if (req.method === 'OPTIONS') {
    return handleOptions(req);
  }

  // Optional Origin allowlist (ALLOWED_ORIGINS env var). Single config
  // point, no CORS header duplication with the gateway.
  const originErr = checkOrigin(req);
  if (originErr) return originErr;

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

      // One batched call to the relay instead of N parallel /quote
      // calls. The relay groups by asset class internally and makes
      // one bdp() per group (typically 2-4 bdp() calls total),
      // which keeps the B-PIPE per-second request rate well below
      // the entitlement limit. The previous parallel /quote
      // approach made 5-7 separate bdp() calls in a few hundred ms
      // and tripped the rate limiter, causing every ticker in the
      // batch to 404 simultaneously (visible in the uvicorn log as
      // a wall of 404s from a single client IP).
      const failures: string[] = [];
      const refreshed: string[] = [];
      if (toRefresh.length > 0) {
        const freshMap = await fetchBloombergQuotes(toRefresh);
        for (const t of toRefresh) {
          const quote = freshMap[t];
          if (quote) {
            const cachedT = cache[t];
            const merged: CachedPrice = {
              ticker: t,
              current_price: quote.current_price!,
              previous_close: quote.previous_close ?? null,
              change_pct: quote.change_pct ?? null,
              day_high: quote.day_high ?? null,
              day_low: quote.day_low ?? null,
              day_open: quote.day_open ?? null,
              volume: quote.volume ?? null,
              company_name: quote.company_name ?? cachedT?.company_name ?? null,
              sector: quote.sector ?? cachedT?.sector ?? null,
              asset_class: quote.asset_class ?? cachedT?.asset_class ?? null,
              bbg_symbol: quote.bbg_symbol ?? cachedT?.bbg_symbol ?? null,
              contract_size: quote.contract_size ?? cachedT?.contract_size ?? null,
              currency: quote.currency ?? cachedT?.currency ?? null,
              expiry_date: quote.expiry_date ?? cachedT?.expiry_date ?? null,
              last_updated: new Date().toISOString(),
            };
            await writeCache(supabase, t, merged);
            results[t] = merged;
            refreshed.push(t);
          } else {
            // Relay had no data for this ticker. Fall back to stale
            // cache (if any) and mark as failed so the frontend can
            // render an explicit "no data" state.
            failures.push(t);
            if (cache[t]) {
              results[t] = { ...cache[t], _stale: true } as any;
            }
          }
        }
      }

      return jsonResponse({
        success: true,
        data: results,
        refreshed,
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

    // ---- GET /historical-series?tickers=AAPL,MSFT&start=YYYY-MM-DD&end=YYYY-MM-DD ----
    // Multi-ticker daily close history, used by the Risk page for
    // market-derived Sharpe / VaR / CVaR / Sortino. Reads from the
    // instrument_price_history cache and backfills any missing
    // sub-ranges from the Bloomberg relay in one shot.
    if (req.method === 'GET' && route === 'historical-series') {
      const tickersParam = searchParams.get('tickers')?.trim();
      const start = searchParams.get('start')?.trim();
      const end = searchParams.get('end')?.trim();
      if (!tickersParam) return errorResponse('Missing ?tickers= param', 400);
      if (!start || !end) return errorResponse('Missing ?start= or ?end= param', 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return errorResponse('Invalid ?start= format', 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return errorResponse('Invalid ?end= format', 400);
      if (start > end) return errorResponse('?start= must be <= ?end=', 400);

      const tickers = tickersParam.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
      if (tickers.length === 0) return errorResponse('No valid tickers provided', 400);
      if (tickers.length > 50) return errorResponse('Max 50 tickers per request', 400);
      for (const t of tickers) {
        if (!/^[A-Z0-9.\-]{1,15}$/.test(t)) return errorResponse(`Invalid ticker format: ${t}`, 400);
      }

      // 1. Read what's already cached for the window. We pull a slightly
      //    wider window than [start..end] so we have a prev-close for the
      //    first in-window day (needed for return calc); the frontend
      //    already includes that boundary in its request.
      const { data: cachedRows, error: cacheErr } = await supabase
        .from('instrument_price_history')
        .select('ticker, trade_date, close')
        .in('ticker', tickers)
        .gte('trade_date', start)
        .lte('trade_date', end)
        .order('trade_date', { ascending: true });
      if (cacheErr) {
        console.error('historical-series cache read failed:', cacheErr);
        return errorResponse('Cache read failed', 500);
      }

      const cachedByTicker: Record<string, { trade_date: string; close: number }[]> = {};
      const cachedDatesByTicker: Record<string, Set<string>> = {};
      for (const t of tickers) {
        cachedByTicker[t] = [];
        cachedDatesByTicker[t] = new Set();
      }
      for (const r of (cachedRows ?? []) as { ticker: string; trade_date: string; close: number }[]) {
        const tk = r.ticker.toUpperCase();
        if (!cachedByTicker[tk]) continue;
        cachedByTicker[tk].push({ trade_date: r.trade_date, close: Number(r.close) });
        cachedDatesByTicker[tk].add(r.trade_date);
      }

      // 2. Decide which tickers need a Bloomberg backfill. We require at
      //    least 60% of the expected trading days to be cached; below
      //    that we re-pull the whole window from Bloomberg so the cache
      //    converges. 252 trading days * 0.6 = ~151 dates. This avoids
      //    incremental fetches when a portfolio holds a brand-new ticker.
      const MS_PER_DAY = 24 * 60 * 60 * 1000;
      const totalDays = Math.round((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / MS_PER_DAY) + 1;
      const expectedTradingDays = Math.max(1, Math.round(totalDays * (5 / 7))); // rough weekend filter
      const CACHE_HIT_RATIO = 0.6;

      const tickersNeedingBackfill: string[] = [];
      for (const t of tickers) {
        const have = cachedDatesByTicker[t]?.size ?? 0;
        if (have < expectedTradingDays * CACHE_HIT_RATIO) {
          tickersNeedingBackfill.push(t);
        }
      }

      // 3. If any ticker needs a backfill, ask the Bloomberg relay for the
      //    whole [start..end] window in one call and upsert the result.
      if (tickersNeedingBackfill.length > 0) {
        const relayUrl =
          `${BLOOMBERG_RELAY_URL.replace(/\/$/, '')}/history-series` +
          `?tickers=${encodeURIComponent(tickersNeedingBackfill.join(','))}` +
          `&start=${encodeURIComponent(start)}` +
          `&end=${encodeURIComponent(end)}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), BLOOMBERG_TIMEOUT_MS * 4); // 4x for batch
        const headers: Record<string, string> = { 'Accept': 'application/json' };
        if (BLOOMBERG_RELAY_KEY) headers['X-API-Key'] = BLOOMBERG_RELAY_KEY;
        try {
          const res = await fetch(relayUrl, { signal: controller.signal, headers });
          const body = await res.json().catch(() => null);
          if (!res.ok || !body || body.success !== true || !Array.isArray(body.data)) {
            const msg = body?.error || body?.detail || `Bloomberg relay error: ${res.status}`;
            console.error('historical-series relay error:', msg);
            // Don't fail the whole request — return whatever the cache had
            // (or an empty series for tickers with no cache) plus a warning.
            return jsonResponse({
              success: true,
              data: buildSeriesResponse(tickers, cachedByTicker),
              from_cache: true,
              warning: `Bloomberg backfill failed: ${msg}`,
              backfilled: [],
              partial: true,
            }, 200);
          }
          const upserts: { ticker: string; trade_date: string; close: number }[] = [];
          for (const series of body.data as { ticker: string; points: { date: string; close: number }[] }[]) {
            const tk = (series.ticker || '').toUpperCase();
            if (!tk || !series.points?.length) continue;
            // Initialise the cache bucket for this ticker (may not have
            // existed in cachedByTicker if the ticker had zero cache rows
            // but Bloomberg returned data).
            if (!cachedByTicker[tk]) cachedByTicker[tk] = [];
            for (const p of series.points) {
              if (!p.date || p.close == null || !Number.isFinite(p.close) || p.close <= 0) continue;
              upserts.push({ ticker: tk, trade_date: p.date, close: Number(p.close) });
              // Merge into the response bucket (replace cached if any).
              const bucket = cachedByTicker[tk];
              const existingIdx = bucket.findIndex((x) => x.trade_date === p.date);
              const point = { trade_date: p.date, close: Number(p.close) };
              if (existingIdx >= 0) bucket[existingIdx] = point;
              else bucket.push(point);
            }
          }
          if (upserts.length > 0) {
            // upsert in chunks of 500 to stay under Supabase's row cap.
            const CHUNK = 500;
            for (let i = 0; i < upserts.length; i += CHUNK) {
              const slice = upserts.slice(i, i + CHUNK);
              const { error: writeErr } = await supabase
                .from('instrument_price_history')
                .upsert(slice, { onConflict: 'ticker,trade_date' });
              if (writeErr) {
                console.error('historical-series cache upsert failed:', writeErr);
              }
            }
          }
          // Sort each ticker bucket (we may have appended out-of-order).
          for (const tk of Object.keys(cachedByTicker)) {
            cachedByTicker[tk].sort((a, b) => a.trade_date.localeCompare(b.trade_date));
          }
        } catch (err) {
          const msg = (err as Error).name === 'AbortError'
            ? `Bloomberg relay timed out after ${BLOOMBERG_TIMEOUT_MS * 4}ms`
            : `Bloomberg relay fetch failed: ${(err as Error).message}`;
          console.error('historical-series relay error:', err);
          return jsonResponse({
            success: true,
            data: buildSeriesResponse(tickers, cachedByTicker),
            from_cache: true,
            warning: msg,
            backfilled: [],
            partial: true,
          }, 200);
        } finally {
          clearTimeout(timeoutId);
        }
      }

      return jsonResponse({
        success: true,
        data: buildSeriesResponse(tickers, cachedByTicker),
        from_cache: tickersNeedingBackfill.length === 0,
        backfilled: tickersNeedingBackfill,
        partial: false,
      }, 200);
    }

    return errorResponse(`Unknown route: ${req.method} /${route}`, 404);
  } catch (err) {
    console.error('market-data error:', err);
    return errorResponse((err as Error).message || 'Internal error', 500);
  }
});
