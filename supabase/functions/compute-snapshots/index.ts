// compute-snapshots Edge Function
// Replays a portfolio's trade log up to a given date, derives the
// signed (qty, avg_price) per ticker, marks each to the live price
// from the `instrument_prices` cache, and writes a row into
// `daily_snapshots` with full L/S decomposition.
//
// Routes:
//   POST /compute-snapshots?portfolio_id=<uuid>&date=YYYY-MM-DD&days=N
//     - portfolio_id optional; iterates all portfolios when omitted
//     - date optional; defaults to today (UTC). When `days` > 1, this
//       is the LATEST date in the rolling window.
//     - days optional; default 1, max 5. When days=N, writes one row
//       per day for the last N UTC days ending at `date` (inclusive).
//       The trade replay is end-of-day for each day, so the resulting
//       daily_return series is the real per-day change in equity
//       (number of shares) — the only thing our data can't reproduce
//       is intra-day price movement, which the system has no source
//       for in any case.
//
// Idempotent: re-running for the same (portfolio_id, snapshot_date)
// upserts in place. The trade replay is per-day end-of-day, so the
// "executeTrade → triggerSnapshotRefresh(days=5)" path produces
// consistent state and the rolling window auto-refreshes the most
// recent 5 days on every trade.
//
// Auth: accepts either a user JWT OR the INTERNAL_API_KEY Bearer
// (matches the pattern documented in SETUP.md / DEPLOYMENT.md).
// Service-to-service callers (frontend's triggerSnapshotRefresh, or
// the Python scheduler tick) pass INTERNAL_API_KEY.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { getUserFromRequest, checkInternalApiKey, checkOrigin } from '../_shared/auth.ts';
import { supabaseAdmin } from '../_shared/db.ts';
import { jsonResponse, errorResponse, handleOptions } from '../_shared/cors.ts';

const STALE_PRICE_DAYS = 7;

interface TradeRow {
  id: string;
  portfolio_id: string;
  ticker: string;
  side: 'BUY' | 'SELL';
  direction: 'LONG' | 'SHORT';
  qty: number;
  price: number;
  trade_timestamp: string;
  // executed_at present from migration 003; not used here — we
  // replay in trade_timestamp order per the frontend convention
  // (see buildPositionHistory in db.ts).
  executed_at?: string;
}

interface PositionRow {
  ticker: string;
  qty: number;
  avg_price: number;
  sector: string | null;
  updated_at: string;
}

interface InstrumentPriceRow {
  ticker: string;
  current_price: number;
  last_updated: string;
  sector: string | null;
}

/**
 * Replay trades for one portfolio strictly before `asOf` (end-of-day
 * inclusive) in trade_timestamp order. Returns per-ticker signed qty
 * and weighted-average cost basis. Mirrors `buildPositionHistory` /
 * `updatePositionAfterTrade` rules in the frontend db.ts so the
 * derived positions match the live `positions` table.
 */
function replayTrades(trades: TradeRow[], asOfIso: string): Map<
  string,
  { qty: number; avgPrice: number }
> {
  const filtered = trades
    .filter((t) => new Date(t.trade_timestamp).getTime() <= new Date(asOfIso).getTime())
    .sort(
      (a, b) =>
        new Date(a.trade_timestamp).getTime() - new Date(b.trade_timestamp).getTime(),
    );

  const state = new Map<string, { qty: number; avgPrice: number }>();

  for (const t of filtered) {
    const tk = t.ticker.toUpperCase();
    const cur = state.get(tk) ?? { qty: 0, avgPrice: 0 };
    const signedDelta = t.side === 'BUY' ? t.qty : -t.qty;
    const newQty = cur.qty + signedDelta;

    if (newQty === 0) {
      state.set(tk, { qty: 0, avgPrice: 0 });
      continue;
    }

    const wasLong = cur.qty > 0;
    const wasShort = cur.qty < 0;
    const openingLong = t.direction === 'LONG' && t.side === 'BUY' && !wasLong;
    const addingToLong = t.direction === 'LONG' && t.side === 'BUY' && wasLong;
    const openingShort = t.direction === 'SHORT' && t.side === 'SELL' && !wasShort;
    const addingToShort = t.direction === 'SHORT' && t.side === 'SELL' && wasShort;

    let newAvg: number;
    if (openingLong || openingShort || cur.qty === 0) {
      newAvg = t.price;
    } else if (addingToLong) {
      newAvg = (cur.qty * cur.avgPrice + t.qty * t.price) / newQty;
    } else if (addingToShort) {
      const existingAbs = Math.abs(cur.qty);
      newAvg = (existingAbs * cur.avgPrice + t.qty * t.price) / (existingAbs + t.qty);
    } else {
      newAvg = cur.avgPrice;
    }

    state.set(tk, { qty: newQty, avgPrice: newAvg });
  }

  return state;
}

async function listPortfolios(): Promise<{ id: string; current_capital: number; initial_capital: number }[]> {
  const { data, error } = await supabaseAdmin
    .from('portfolios')
    .select('id, current_capital, initial_capital');
  if (error) throw error;
  return (data ?? []) as { id: string; current_capital: number; initial_capital: number }[];
}

async function fetchTrades(portfolioId: string): Promise<TradeRow[]> {
  // Pull all trades for the portfolio. The 1000-row cap is a safety
  // belt — a single paper-trading portfolio won't get there. If it
  // does, switch to a date-windowed fetch and run the edge function
  // per-window.
  const { data, error } = await supabaseAdmin
    .from('trades')
    .select('id, portfolio_id, ticker, side, direction, qty, price, trade_timestamp, executed_at')
    .eq('portfolio_id', portfolioId)
    .order('trade_timestamp', { ascending: true })
    .limit(1000);
  if (error) throw error;
  return (data ?? []) as TradeRow[];
}

async function fetchCurrentPositions(portfolioId: string): Promise<PositionRow[]> {
  const { data, error } = await supabaseAdmin
    .from('positions')
    .select('ticker, qty, avg_price, sector, updated_at')
    .eq('portfolio_id', portfolioId);
  if (error) throw error;
  return (data ?? []) as PositionRow[];
}

async function fetchPrices(tickers: string[]): Promise<Map<string, InstrumentPriceRow>> {
  const out = new Map<string, InstrumentPriceRow>();
  if (tickers.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from('instrument_prices')
    .select('ticker, current_price, last_updated, sector')
    .in('ticker', tickers.map((t) => t.toUpperCase()));
  if (error) throw error;
  for (const row of (data ?? []) as InstrumentPriceRow[]) {
    out.set(row.ticker.toUpperCase(), row);
  }
  return out;
}

/**
 * Fetch real daily closes from `instrument_price_history` for the
 * given (tickers, dateWindow). Returns a 2-level map:
 *   ticker -> (YYYY-MM-DD -> close)
 * Days with no row in the table are simply absent — callers fall back
 * to the live `current_price` or `avg_price`. This mirrors the
 * `fetchDailyCloseMap` helper on the frontend
 * (`backfillHistoricalSnapshots` in db.ts) and is what lets the
 * 5-day rolling-window snapshot path actually drift with AMD's real
 * close-to-close moves instead of marking every day at the same live
 * tick (which produced a flat equity line and Sharpe = N/A for
 * positions held longer than one trading day).
 */
async function fetchHistoryCloseMap(
  tickers: string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, Map<string, number>>> {
  const cleaned = Array.from(new Set(tickers.map((t) => t.toUpperCase())))
    .filter(Boolean);
  const out = new Map<string, Map<string, number>>();
  if (cleaned.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from('instrument_price_history')
    .select('ticker, trade_date, close')
    .in('ticker', cleaned)
    .gte('trade_date', startDate)
    .lte('trade_date', endDate);
  if (error) {
    console.warn('instrument_price_history read failed:', error.message);
    return out;
  }
  for (const row of (data ?? []) as { ticker: string; trade_date: string; close: number }[]) {
    const tk = String(row.ticker).toUpperCase();
    let inner = out.get(tk);
    if (!inner) {
      inner = new Map();
      out.set(tk, inner);
    }
    inner.set(String(row.trade_date), Number(row.close));
  }
  return out;
}

async function fetchPrevEquity(
  portfolioId: string,
  dateStr: string,
): Promise<number | null> {
  // Most recent snapshot strictly before `dateStr`.
  const { data, error } = await supabaseAdmin
    .from('daily_snapshots')
    .select('equity, snapshot_date')
    .eq('portfolio_id', portfolioId)
    .lt('snapshot_date', dateStr)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return (data as { equity: number }).equity;
}

interface SnapshotWrite {
  portfolio_id: string;
  snapshot_date: string;
  equity: number;
  exposure: number;
  cash: number;
  daily_return: number | null;
  long_value: number;
  short_value: number;
  net_value: number;
  long_pct: number | null;
  short_pct: number | null;
  net_pct: number | null;
  gross_pct: number | null;
  sector_jsonb: Record<string, { long: number; short: number; net: number }> | null;
  position_jsonb: Record<string, { qty: number; mv: number; sector: string | null }> | null;
}

async function computeAndWriteOne(
  portfolioId: string,
  dateStr: string,
  asOfIso: string,
  historyCloseMap?: Map<string, Map<string, number>>,
): Promise<{ ok: boolean; error?: string; staleTickers: string[] }> {
  const [portfolioRes, trades, positions, prevEquity] = await Promise.all([
    supabaseAdmin
      .from('portfolios')
      .select('id, current_capital, initial_capital')
      .eq('id', portfolioId)
      .maybeSingle(),
    fetchTrades(portfolioId),
    fetchCurrentPositions(portfolioId),
    fetchPrevEquity(portfolioId, dateStr),
  ]);
  if (portfolioRes.error || !portfolioRes.data) {
    return { ok: false, error: 'Portfolio not found', staleTickers: [] };
  }
  const portfolio = portfolioRes.data as { id: string; current_capital: number; initial_capital: number };

  // Replay trades up to end of `dateStr`.
  const replayState = replayTrades(trades, asOfIso);

  // For the live mark, we use the current `positions` table (which
  // is the canonical "now" state). We still respect the replay for
  // historical dates by computing quantities/avg-prices from the
  // trade log. For TODAY we use positions directly so the snapshot
  // matches what the user sees on the Risk page.
  const todayStr = new Date().toISOString().slice(0, 10);
  const isToday = dateStr === todayStr;

  // Collect tickers we need prices for.
  const tickersForPrice = new Set<string>();
  if (isToday) {
    for (const p of positions) tickersForPrice.add(p.ticker.toUpperCase());
  } else {
    for (const tk of replayState.keys()) tickersForPrice.add(tk.toUpperCase());
  }
  const priceMap = await fetchPrices(Array.from(tickersForPrice));

  const staleCutoffMs = Date.now() - STALE_PRICE_DAYS * 24 * 60 * 60 * 1000;
  const staleTickers: string[] = [];

  // Build the per-ticker valuation.
  const perTicker: {
    ticker: string;
    qty: number;
    avgPrice: number;
    price: number;
    mv: number;
    sector: string | null;
  }[] = [];

  if (isToday) {
    for (const p of positions) {
      const tk = p.ticker.toUpperCase();
      const pxRow = priceMap.get(tk);
      let price = pxRow?.current_price ?? p.avg_price;
      if (pxRow && new Date(pxRow.last_updated).getTime() < staleCutoffMs) {
        staleTickers.push(tk);
      }
      perTicker.push({
        ticker: tk,
        qty: p.qty,
        avgPrice: p.avg_price,
        price,
        mv: p.qty * price,
        sector: p.sector ?? pxRow?.sector ?? null,
      });
    }
  } else {
    for (const [tk, st] of replayState.entries()) {
      if (st.qty === 0) continue;
      const pxRow = priceMap.get(tk);
      // Historical-date mark preference:
      //   1. Real daily close from instrument_price_history (best — true
      //      close-to-close mark, produces accurate day-over-day drift).
      //   2. Live current_price from instrument_prices (acceptable — at
      //      least reflects a real market tick, so the chart isn't flat
      //      at cost basis even when the history cache hasn't caught up
      //      for a freshly-held ticker like a brand-new AMD buy).
      //   3. avgPrice (cost basis) — used only as a last-resort fallback
      //      when neither cache has data for this ticker at all.
      //
      // The strict "real close only" rule from the previous version
      // was too aggressive: it dropped the entire day's snapshot if ANY
      // held ticker lacked a cached close, which produced flat equity
      // lines for any ticker whose history hadn't been backfilled yet
      // (e.g. a newly-bought ticker). The user pointed out that
      // switching to any other ticker reproduces the flat-line bug
      // because of this — even tickers with real closes were being
      // skipped because a sibling ticker in the same portfolio lacked
      // its history cache entry. Relaxed back to the chain above, but
      // the skip rule below still removes rows where NO ticker has any
      // real mark (every one fell back to cost basis) — those are the
      // truly degenerate "equity resets to initial capital" rows.
      const closeOnDate = historyCloseMap?.get(tk)?.get(dateStr);
      const price = closeOnDate ?? pxRow?.current_price ?? st.avgPrice;
      if (pxRow && new Date(pxRow.last_updated).getTime() < staleCutoffMs) {
        staleTickers.push(tk);
      }
      // `hasRealMark` is true when the mark came from a cache (close or
      // live) rather than a cost-basis fallback. The skip rule uses
      // this to drop rows where every ticker fell back to cost basis.
      const hasRealMark = closeOnDate != null || pxRow?.current_price != null;
      perTicker.push({
        ticker: tk,
        qty: st.qty,
        avgPrice: st.avgPrice,
        price,
        mv: st.qty * price,
        sector: pxRow?.sector ?? null,
        hasRealMark,
      });
    }
  }

  // Compute aggregates.
  const longValue = perTicker.reduce((s, t) => s + Math.max(0, t.mv), 0);
  const shortValue = perTicker.reduce((s, t) => s + Math.min(0, t.mv), 0); // negative
  const netValue = longValue + shortValue;
  const grossExposure = longValue + Math.abs(shortValue);
  const equity = portfolio.current_capital + netValue;
  const longPct = equity > 0 ? (longValue / equity) * 100 : null;
  const shortPct = equity > 0 ? (shortValue / equity) * 100 : null;
  const netPct = equity > 0 ? (netValue / equity) * 100 : null;
  const grossPct = equity > 0 ? (grossExposure / equity) * 100 : null;

  // Sector L/S aggregate. We rely on the per-position sector (which
  // can be enriched by the live price cache's sector field) and
  // bucket signed MV. Empty sector -> "Unknown" to match the
  // frontend convention.
  const sectorMap = new Map<
    string,
    { long: number; short: number; net: number }
  >();
  for (const t of perTicker) {
    const sector = t.sector ?? 'Unknown';
    const entry = sectorMap.get(sector) ?? { long: 0, short: 0, net: 0 };
    if (t.mv >= 0) entry.long += t.mv;
    else entry.short += t.mv; // negative
    entry.net = entry.long + entry.short;
    sectorMap.set(sector, entry);
  }
  const sectorJsonb: Record<string, { long: number; short: number; net: number }> = {};
  for (const [k, v] of sectorMap.entries()) sectorJsonb[k] = v;

  // Per-position detail. We also store the position's holding-period
  // return as a percentage of entry notional, so the Risk page (and
  // future P&L charts) can show a real "since open" or "1Y" return
  // per position without recomputing on the frontend.
  //
  //   return_pct for LONG:  (price - avgPrice) / avgPrice * 100
  //   return_pct for SHORT: (avgPrice - price) / avgPrice * 100
  //                         (a short that dropped in price has a
  //                          positive return — the price-relative %
  //                          mirrors the P&L sign convention)
  const positionJsonb: Record<string, {
    qty: number;
    mv: number;
    sector: string | null;
    avg_price: number;
    price: number;
    return_pct: number | null;
  }> = {};
  for (const t of perTicker) {
    let returnPct: number | null = null;
    if (t.avgPrice > 0 && t.price > 0) {
      const priceReturn = (t.price - t.avgPrice) / t.avgPrice;
      returnPct = t.qty >= 0 ? priceReturn * 100 : -priceReturn * 100;
    }
    positionJsonb[t.ticker] = {
      qty: t.qty,
      mv: t.mv,
      sector: t.sector,
      avg_price: t.avgPrice,
      price: t.price,
      return_pct: returnPct,
    };
  }

  // Daily return: (equity - prevEquity) / prevEquity. Null when no
  // previous snapshot OR prev equity is 0/negative.
  let dailyReturn: number | null = null;
  if (prevEquity != null && prevEquity > 0) {
    dailyReturn = (equity - prevEquity) / prevEquity;
  }

  // No-data skip: for a HISTORICAL date, skip the day's write only if
// NO held ticker has any real market mark (every one fell back to
// `avgPrice` because neither `instrument_price_history` nor
// `instrument_prices` had a row for it). Those fully-degenerate rows
// produce equity ≈ initial_capital × qty + cash — visually a flat
// reset to initial capital, which the user described as "equity
// returns to 0 when there is no data." Skipping them is what the
// user asked for: "if no data that day should be removed."
//
// A more aggressive rule (skip if ANY ticker lacks a close) was tried
// but caused the chart to flatline for every ticker in a multi-
// ticker portfolio whenever a single sibling ticker hadn't been
// backfilled yet — the user reported that switching to any other
// ticker reproduced the flat-line bug. Per-ticker fallback
// (`closeOnDate ?? current_price ?? avgPrice`) keeps the chart alive
// even when one ticker's history is still warming up.
//
// Self-healing: when we skip, also DELETE any existing row for this
// (portfolio, date). Otherwise phantom rows written by previous
// versions of this code would persist indefinitely.
//
// Today's row is never skipped (no historical close for today exists
// yet; we mark at current_price).
if (!isToday && perTicker.length > 0) {
  const tickersWithoutRealMark = perTicker.filter((t) => !t.hasRealMark);
  if (tickersWithoutRealMark.length === perTicker.length) {
    console.log(
      `compute-snapshots: skipping ${dateStr} for ${portfolioId} — no real price marks for any ticker (cache empty)`,
    );
    const { error: deleteErr } = await supabaseAdmin
      .from('daily_snapshots')
      .delete()
      .eq('portfolio_id', portfolioId)
      .eq('snapshot_date', dateStr);
    if (deleteErr) {
      console.warn(
        `compute-snapshots: failed to delete phantom row for ${dateStr}:`,
        deleteErr.message,
      );
    }
    return { ok: true, staleTickers };
  }
}

  const row: SnapshotWrite = {
    portfolio_id: portfolioId,
    snapshot_date: dateStr,
    equity,
    exposure: grossExposure,
    cash: portfolio.current_capital,
    daily_return: dailyReturn,
    long_value: longValue,
    short_value: shortValue,
    net_value: netValue,
    long_pct: longPct,
    short_pct: shortPct,
    net_pct: netPct,
    gross_pct: grossPct,
    sector_jsonb: sectorJsonb,
    position_jsonb: positionJsonb,
  };

  const { error: writeErr } = await supabaseAdmin
    .from('daily_snapshots')
    .upsert(row, { onConflict: 'portfolio_id,snapshot_date' });
  if (writeErr) {
    return { ok: false, error: writeErr.message, staleTickers };
  }
  return { ok: true, staleTickers };
}

function isAuthorized(req: Request): Promise<boolean> | boolean {
  // Two ways in:
  //   1. INTERNAL_API_KEY Bearer — service-to-service (Python
  //      scheduler, etc).
  //   2. User JWT — the frontend's triggerSnapshotRefresh forwards
  //      `supabase.auth.getSession().access_token`. Note: the
  //      Supabase gateway is already configured with --no-verify-jwt
  //      (per SETUP.md), so the gateway lets ALL requests through.
  //      The function still verifies here as a defense-in-depth
  //      check, but accepts any well-formed user JWT (including
  //      expired-but-not-revoked ones, which `getUser` validates
  //      leniently).
  if (checkInternalApiKey(req)) return true;
  return getUserFromRequest(req).then((u) => u != null);
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return handleOptions(req);
  const originErr = checkOrigin(req);
  if (originErr) return originErr;

  try {
    const authorized = await isAuthorized(req);
    if (!authorized) return errorResponse('Unauthorized', 401);

    if (req.method !== 'POST') {
      return errorResponse('Use POST', 405);
    }

    const url = new URL(req.url);
    const portfolioId = url.searchParams.get('portfolio_id')?.trim() || null;
    const dateParam = url.searchParams.get('date')?.trim() || null;
    // `days` controls the rolling window size. Capped at 30 so the
    // 23:55 UTC scheduler tick can capture a full month of price drift
    // (was 5; raised so idle portfolios get enough history for Sharpe
    // / Sortino / VaR to compute without depending on a trade firing
    // each day). The cap exists as a back-pressure guard against
    // accidentally requesting a multi-year replay in one call.
    const daysParam = url.searchParams.get('days')?.trim();
    let days = 1;
    if (daysParam) {
      const parsed = parseInt(daysParam, 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 30) {
        days = parsed;
      } else {
        return errorResponse('Invalid ?days= (must be 1..30)', 400);
      }
    }

    let endDateStr: string;
    if (dateParam) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return errorResponse('Invalid ?date= format (YYYY-MM-DD)', 400);
      endDateStr = dateParam;
    } else {
      endDateStr = new Date().toISOString().slice(0, 10);
    }

    // Build the list of dates from (endDateStr - days + 1) to
    // endDateStr, inclusive. Dates are iterated in chronological
    // order so the daily_return chain is correct (each day's prev
    // equity is the row written the iteration before).
    const endDate = new Date(`${endDateStr}T00:00:00.000Z`);
    const dateList: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(endDate.getTime() - i * 24 * 60 * 60 * 1000);
      dateList.push(d.toISOString().slice(0, 10));
    }
    const windowStart = dateList[0];
    const windowEnd = dateList[dateList.length - 1];

    const portfolios = portfolioId
      ? [{ id: portfolioId }]
      : await listPortfolios();
    if (portfolios.length === 0) {
      return jsonResponse({ success: true, data: { written: 0, portfolios: [] } });
    }

    const results: {
      portfolio_id: string;
      ok: boolean;
      error?: string;
      staleTickers?: string[];
      dates_written: string[];
    }[] = [];

    for (const p of portfolios) {
      const portfolioResults: typeof results[number] = {
        portfolio_id: p.id,
        ok: true,
        staleTickers: [],
        dates_written: [],
      };
      // Pull real daily closes for every ticker this portfolio has
      // EVER held across the full window in one query, then share the
      // map with each per-date snapshot write. We over-fetch slightly
      // (all tickers in the trade log) so we have a close to fall
      // back to even if the position was closed mid-window.
      let historyCloseMap = new Map<string, Map<string, number>>();
      try {
        const { data: allTrades } = await supabaseAdmin
          .from('trades')
          .select('ticker')
          .eq('portfolio_id', p.id);
        const everHeldTickers = Array.from(
          new Set(
            (allTrades ?? [])
              .map((r: { ticker: string }) => String(r.ticker).toUpperCase())
              .filter(Boolean),
          ),
        );
        if (everHeldTickers.length > 0) {
          historyCloseMap = await fetchHistoryCloseMap(
            everHeldTickers,
            windowStart,
            windowEnd,
          );
        }
      } catch (err) {
        console.warn(
          `history-close fetch failed for ${p.id}; falling back to live marks:`,
          (err as Error).message,
        );
      }
      for (const dateStr of dateList) {
        // asOfIso = end-of-day in UTC, so trades stamped at 23:59:59
        // on `dateStr` are included.
        const asOfIso = `${dateStr}T23:59:59.999Z`;
        const r = await computeAndWriteOne(p.id, dateStr, asOfIso, historyCloseMap);
        if (!r.ok) {
          portfolioResults.ok = false;
          portfolioResults.error = r.error;
        } else {
          portfolioResults.dates_written.push(dateStr);
        }
        portfolioResults.staleTickers = r.staleTickers;
      }
      results.push(portfolioResults);
    }

    const failed = results.filter((r) => !r.ok);
    const totalWritten = results.reduce((s, r) => s + r.dates_written.length, 0);
    if (failed.length > 0) {
      return jsonResponse(
        {
          success: false,
          error: `${failed.length}/${results.length} portfolio(s) failed`,
          data: { written: totalWritten, results },
        },
        207, // Multi-Status
      );
    }

    return jsonResponse({
      success: true,
      data: {
        written: totalWritten,
        results,
      },
    });
  } catch (err) {
    console.error('compute-snapshots error:', err);
    return errorResponse((err as Error).message || 'Internal error', 500);
  }
});
