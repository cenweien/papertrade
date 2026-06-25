// Database service - direct Supabase calls
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database.types';

// These types match the SQL schema exactly
export type Portfolio = Database['public']['Tables']['portfolios']['Row'];
export type Trade = Database['public']['Tables']['trades']['Row'];
export type Position = Database['public']['Tables']['positions']['Row'];
export type DailySnapshot = Database['public']['Tables']['daily_snapshots']['Row'];

/**
 * NYSE (US equity) market holidays for a given year. The backfill
 * writes one snapshot per calendar day, but the equity is flat on
 * these days — including them in the chart series creates fake
 * "linear" jumps and inflates Sharpe. We filter them out at the
 * snapshot source (see `getSnapshots`).
 *
 * Rules cover every annual NYSE closure:
 *   - New Year's Day (observed Fri/Mon if weekend)
 *   - MLK Day        (3rd Monday in January)
 *   - Presidents Day (3rd Monday in February)
 *   - Good Friday    (2 days before Easter Sunday)
 *   - Memorial Day   (last Monday in May)
 *   - Juneteenth     (observed Fri/Mon if weekend)
 *   - Independence Day (observed Fri/Mon if weekend)
 *   - Labor Day      (1st Monday in September)
 *   - Thanksgiving   (4th Thursday in November)
 *   - Christmas      (observed Fri/Mon if weekend)
 *
 * Includes 2-digit short-circuiting of the Anonymous Gregorian
 * algorithm for Easter (Meeus/Jones/Butcher), which Good Friday
 * depends on. Non-US tickers keep their own exchange calendars and
 * may show a flat row for those days, but the user impact is bounded
 * to one day per foreign holiday and the L/S rows are filtered out
 * by isTradingDay anyway.
 */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  // weekday: 0=Sun..6=Sat. n=1 for "1st", 3 for "3rd", -1 for "last".
  const first = new Date(Date.UTC(year, month, 1));
  const firstDow = first.getUTCDay();
  const offset = ((weekday - firstDow) + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return new Date(Date.UTC(year, month, day));
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const lastDow = last.getUTCDay();
  const offset = (lastDow - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, last.getUTCDate() - offset));
}

function observedHoliday(year: number, month: number, day: number): Date {
  const d = new Date(Date.UTC(year, month, day));
  const dow = d.getUTCDay();
  if (dow === 0) return new Date(Date.UTC(year, month, day + 1));
  if (dow === 6) return new Date(Date.UTC(year, month, day - 1));
  return d;
}

function easterSunday(year: number): Date {
  // Meeus/Jones/Butcher Anonymous Gregorian algorithm.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const L = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * L) / 451);
  const month = Math.floor((h + L - 7 * m + 114) / 31);
  const day = ((h + L - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function usMarketHolidaysForYear(year: number): Set<string> {
  const dates = new Set<string>();
  // New Year's Day (observed)
  dates.add(isoDate(observedHoliday(year, 0, 1)));
  // MLK Day — 3rd Monday in January
  dates.add(isoDate(nthWeekdayOfMonth(year, 0, 1, 3)));
  // Presidents Day — 3rd Monday in February
  dates.add(isoDate(nthWeekdayOfMonth(year, 1, 1, 3)));
  // Good Friday — 2 days before Easter Sunday
  const easter = easterSunday(year);
  const goodFriday = new Date(easter);
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  dates.add(isoDate(goodFriday));
  // Memorial Day — last Monday in May
  dates.add(isoDate(lastWeekdayOfMonth(year, 4, 1)));
  // Juneteenth (observed)
  dates.add(isoDate(observedHoliday(year, 5, 19)));
  // Independence Day (observed)
  dates.add(isoDate(observedHoliday(year, 6, 4)));
  // Labor Day — 1st Monday in September
  dates.add(isoDate(nthWeekdayOfMonth(year, 8, 1, 1)));
  // Thanksgiving — 4th Thursday in November
  dates.add(isoDate(nthWeekdayOfMonth(year, 10, 4, 4)));
  // Christmas (observed)
  dates.add(isoDate(observedHoliday(year, 11, 25)));
  return dates;
}

/**
 * Cache the holiday set per year so the chart re-render hot path
 * doesn't recompute the 10 dates on every snapshot filter.
 */
const holidayCache = new Map<number, Set<string>>();
function isUsMarketHoliday(isoDateStr: string): boolean {
  const year = Number(isoDateStr.slice(0, 4));
  let set = holidayCache.get(year);
  if (!set) {
    set = usMarketHolidaysForYear(year);
    holidayCache.set(year, set);
  }
  return set.has(isoDateStr);
}

// ============================================================
// PORTFOLIOS
// ============================================================

export async function getPortfolios(includeArchived = false): Promise<Portfolio[]> {
  let query = supabase
    .from('portfolios')
    .select('*')
    .order('created_at', { ascending: false });

  if (!includeArchived) {
    query = query.eq('is_archived', false);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getPortfolio(id: string): Promise<Portfolio | null> {
  const { data, error } = await supabase
    .from('portfolios')
    .select('*')
    .eq('id', id)
    .single();

  if (error) return null;
  return data;
}

export async function createPortfolio(input: {
  name: string;
  description?: string;
  initial_capital?: number;
}): Promise<Portfolio> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const initial = input.initial_capital ?? 100_000_000;
  const { data, error } = await supabase
    .from('portfolios')
    .insert({
      user_id: user.id,
      name: input.name,
      description: input.description || null,
      initial_capital: initial,
      current_capital: initial,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Ensure the current user has at least one portfolio. If they don't,
 * create a default "Main Portfolio" seeded with $100M of paper cash.
 * Returns the list of portfolios (existing or just-created).
 *
 * Single-flighted: concurrent callers (Layout + Dashboard both call
 * this on mount) share one in-flight promise so we never create
 * duplicates from a race. Also includes a name-collision guard as a
 * belt-and-suspenders against any leftover "Main Portfolio" rows from
 * before the single-flight lock was added.
 */
let ensureDefaultInFlight: Promise<Portfolio[]> | null = null;
export async function ensureDefaultPortfolio(): Promise<Portfolio[]> {
  if (ensureDefaultInFlight) return ensureDefaultInFlight;
  ensureDefaultInFlight = (async () => {
    const existing = await getPortfolios(true);
    if (existing.length > 0) return existing;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return existing;
    // Re-check inside the lock — another concurrent caller may have
    // raced past `getPortfolios` and already inserted one.
    const after = await getPortfolios(true);
    if (after.length > 0) return after;
    // Name-collision guard: never create a second "Main Portfolio".
    const { data: dup } = await supabase
      .from('portfolios')
      .select('id')
      .eq('user_id', user.id)
      .ilike('name', 'Main Portfolio')
      .maybeSingle();
    if (dup) return getPortfolios(true);
    await createPortfolio({ name: 'Main Portfolio' });
    return getPortfolios(true);
  })().finally(() => {
    // Reset the in-flight handle on the next microtask so future
    // calls (e.g. after a portfolio is archived) can re-check.
    queueMicrotask(() => { ensureDefaultInFlight = null; });
  });
  return ensureDefaultInFlight;
}

export async function updatePortfolio(
  id: string,
  updates: { name?: string; description?: string }
): Promise<Portfolio> {
  const { data, error } = await supabase
    .from('portfolios')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function archivePortfolio(id: string): Promise<void> {
  const { error } = await supabase
    .from('portfolios')
    .update({ is_archived: true })
    .eq('id', id);
  if (error) throw error;
}

export async function resetPortfolio(id: string): Promise<void> {
  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('initial_capital')
    .eq('id', id)
    .single();

  if (!portfolio) throw new Error('Portfolio not found');

  // Reset cash
  await supabase
    .from('portfolios')
    .update({ current_capital: portfolio.initial_capital })
    .eq('id', id);

  // Delete all positions and trades
  await supabase.from('positions').delete().eq('portfolio_id', id);
  await supabase.from('trades').delete().eq('portfolio_id', id);
}

export async function clonePortfolio(id: string, newName?: string): Promise<Portfolio> {
  const original = await getPortfolio(id);
  if (!original) throw new Error('Portfolio not found');

  const cloned = await createPortfolio({
    name: newName || `${original.name} (Copy)`,
    description: original.description || undefined,
    initial_capital: original.initial_capital,
  });

  // Clone positions
  const { data: positions } = await supabase
    .from('positions')
    .select('*')
    .eq('portfolio_id', id);

  if (positions && positions.length > 0) {
    await supabase.from('positions').insert(
      positions.map((p) => ({
        portfolio_id: cloned.id,
        ticker: p.ticker,
        qty: p.qty,
        avg_price: p.avg_price,
        current_price: p.current_price,
        sector: p.sector,
      }))
    );
  }

  return cloned;
}

// ============================================================
// TRADES
// ============================================================

export async function getTrades(portfolioId?: string, limit = 100): Promise<Trade[]> {
  let query = supabase
    .from('trades')
    .select('*')
    .order('trade_timestamp', { ascending: false })
    .limit(limit);

  if (portfolioId) {
    query = query.eq('portfolio_id', portfolioId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Resolve the live cached price for a ticker from the instrument_prices
 * cache. Returns null if no fresh price is available. Used by
 * executeTrade() to turn a notional into a qty at the moment of
 * execution, so the system — not the LLM — owns the share-count math.
 */
export async function getCachedPrice(ticker: string): Promise<number | null> {
  const quote = await getCachedQuote(ticker);
  return quote?.current_price ?? null;
}

/**
 * Read a fresh-enough quote (price + change_pct + company_name) for
 * `ticker` from the `instrument_prices` cache. Returns null when no
 * row exists OR the row is older than 10 minutes (the display TTL).
 *
 * Used by the AIChatPage refetch path so editing a leg's ticker box
 * refreshes the price without round-tripping the (LLM-backed) AI
 * Edge Function — typical latency is ~100-300ms (one Supabase read)
 * instead of ~2s.
 */
export async function getCachedQuote(
  ticker: string,
): Promise<{
  current_price: number;
  change_pct: number | null;
  company_name: string | null;
  from_cache: boolean;
  last_updated: string;
} | null> {
  const upper = ticker.toUpperCase();
  const { data, error } = await supabase
    .from('instrument_prices')
    .select('current_price, change_pct, company_name, last_updated, from_cache')
    .eq('ticker', upper)
    .maybeSingle();
  if (error || !data || data.current_price == null) return null;
  const ageMs = Date.now() - new Date(data.last_updated).getTime();
  // 10-minute window: a bit more permissive than the 5-min display
  // TTL because the user might be about to execute and we want a
  // sensible fallback even if the price is mildly stale.
  if (ageMs > 10 * 60 * 1000) return null;
  return {
    current_price: data.current_price,
    change_pct: data.change_pct ?? null,
    company_name: data.company_name ?? null,
    from_cache: data.from_cache ?? true,
    last_updated: data.last_updated,
  };
}

/**
 * Execute a trade. Supports both LONG (BUY/SELL closes) and SHORT
 * (SELL opens, BUY covers) directions, and resolves notional -> qty
 * at execution time using the latest cached price.
 *
 * The caller may pass either `qty` (share count) or `notional` (USD
 * dollars). Resolution priority: explicit `qty` wins; if only `notional`
 * is given, it's divided by the freshest cached price to get a whole
 * share count. `price` is recorded as the fill price; for market
 * orders it should be the same as the cached price the qty was
 * computed from.
 */
export async function executeTrade(input: {
  portfolio_id: string;
  ticker: string;
  side: 'BUY' | 'SELL';
  direction?: 'LONG' | 'SHORT';
  qty?: number | null;
  notional?: number | null;
  price?: number | null;
  stop_price?: number | null;
  notes?: string;
  executed_at?: string;
}): Promise<Trade> {
  const ticker = input.ticker.toUpperCase();
  const direction: 'LONG' | 'SHORT' = input.direction ?? 'LONG';

  // ---- 1. Resolve price & qty ----
  // 1a. If caller passed a notional but no qty, we need a price to
  //     convert. Use the cached price (fresh) if available, else the
  //     caller's explicit price as a last resort.
  let price: number | null = input.price ?? null;
  let qty: number | null = input.qty ?? null;

  if (qty == null && input.notional != null && input.notional > 0) {
    if (price == null || price <= 0) {
      const cached = await getCachedPrice(ticker);
      if (cached != null && cached > 0) {
        price = cached;
      }
    }
    if (price == null || price <= 0) {
      throw new Error(
        `Cannot resolve $${input.notional.toLocaleString()} notional for ${ticker}: no market price available. ` +
        `Specify a limit price or wait for the price cache to warm up.`
      );
    }
    qty = Math.floor(input.notional / price);
    if (!qty || qty <= 0) {
      throw new Error(
        `Notional $${input.notional.toLocaleString()} of ${ticker} is too small to buy 1 share at $${price.toFixed(2)}`
      );
    }
  }

  if (qty == null || qty <= 0) {
    throw new Error('Quantity is required (pass either `qty` or `notional` plus a price)');
  }
  if (price == null || price <= 0) {
    throw new Error('Price is required');
  }

  const totalCost = qty * price;

  // ---- 2. Get portfolio ----
  const { data: portfolio, error: pErr } = await supabase
    .from('portfolios')
    .select('*')
    .eq('id', input.portfolio_id)
    .single();
  if (pErr || !portfolio) throw new Error('Portfolio not found');

  // ---- 3. Get the (possibly non-existent) existing position ----
  const { data: existingPos } = await supabase
    .from('positions')
    .select('*')
    .eq('portfolio_id', input.portfolio_id)
    .eq('ticker', ticker)
    .maybeSingle();

  // ---- 4. Validation by side + direction ----
  // SELL + LONG  = close long     (need existing long, pos.qty >= qty)
  // SELL + SHORT = open short     (no existing required; skip cash check; we RECEIVE proceeds)
  // BUY  + LONG  = open long      (need cash; pos.qty was 0 or already long)
  // BUY  + SHORT = cover short    (need existing short, -pos.qty >= qty)
  if (input.side === 'SELL' && direction === 'LONG') {
    if (!existingPos || existingPos.qty < qty) {
      throw new Error(
        `Insufficient shares. Need ${qty}, have ${existingPos?.qty ?? 0}`
      );
    }
  } else if (input.side === 'SELL' && direction === 'SHORT') {
    // Opening a short: no position required, no cash check (paper trading
    // treats shorts as cash-secured, i.e. you receive the proceeds).
    // (For real margin trading we'd need a margin check here.)
  } else if (input.side === 'BUY' && direction === 'LONG') {
    if (portfolio.current_capital < totalCost) {
      throw new Error(
        `Insufficient cash. Need $${totalCost.toFixed(2)}, have $${portfolio.current_capital.toFixed(2)}`
      );
    }
  } else if (input.side === 'BUY' && direction === 'SHORT') {
    if (!existingPos || existingPos.qty >= 0 || -existingPos.qty < qty) {
      throw new Error(
        `Insufficient short position. Need ${qty} to cover, have ${existingPos ? Math.abs(Math.min(0, existingPos.qty)) : 0}`
      );
    }
    if (portfolio.current_capital < totalCost) {
      throw new Error(
        `Insufficient cash to cover short. Need $${totalCost.toFixed(2)}, have $${portfolio.current_capital.toFixed(2)}`
      );
    }
  }

  // ---- 5. Insert trade ----
  const { data: trade, error: tErr } = await supabase
    .from('trades')
    .insert({
      portfolio_id: input.portfolio_id,
      ticker,
      side: input.side,
      direction,
      qty,
      price,
      stop_price: input.stop_price ?? null,
      notes: input.notes ?? null,
      executed_at: input.executed_at ?? new Date().toISOString(),
    })
    .select()
    .single();
  if (tErr) throw tErr;

  // ---- 6. Update portfolio cash. Cash flow follows SIDE, not direction:
  //     BUY pays out; SELL receives. This is true for both opening and
  //     closing trades, longs and shorts alike.
  const cashDelta = input.side === 'BUY' ? -totalCost : totalCost;
  await supabase
    .from('portfolios')
    .update({ current_capital: portfolio.current_capital + cashDelta })
    .eq('id', input.portfolio_id);

  // ---- 7. Update position (signed qty, signed-aware average price) ----
  await updatePositionAfterTrade(
    input.portfolio_id,
    ticker,
    input.side,
    direction,
    qty,
    price,
  );

  // ---- 8. Persist a daily_snapshots row so the Risk page's L/S
  //     time series reflects this trade on the next reload. We
  //     write directly from the frontend (bypassing the
  //     compute-snapshots edge function) because the same auth chain
  //     already authorized the trade + position + cash writes above,
  //     so the snapshot write can use the same session with no
  //     extra cold start.
  //
  //     Pass the trade's `executed_at` date (not `today`) so back-
  //     dated trades — e.g. the AI chat's "buy AAPL a year ago" —
  //     stamp the snapshot for the historical date. Then backfill
  //     every calendar day from that date through today so the chart
  //     has a continuous series instead of two isolated points. ----
  const snapshotDate = (input.executed_at ?? new Date().toISOString()).slice(0, 10);
  await writeSnapshotAfterTrade(input.portfolio_id, snapshotDate);

  return trade;
}

async function updatePositionAfterTrade(
  portfolioId: string,
  ticker: string,
  side: 'BUY' | 'SELL',
  direction: 'LONG' | 'SHORT',
  qty: number,
  price: number,
): Promise<void> {
  const { data: existing } = await supabase
    .from('positions')
    .select('*')
    .eq('portfolio_id', portfolioId)
    .eq('ticker', ticker)
    .maybeSingle();

  // Signed qty delta. Opening a short makes qty more negative; covering
  // makes it less negative; longs behave as before.
  const signedDelta =
    side === 'BUY'
      ? qty                       // BUY: +qty to position (long add or cover short)
      : -qty;                     // SELL: -qty from position (close long or open short)
  const newQty = (existing?.qty ?? 0) + signedDelta;

  if (newQty === 0) {
    if (existing) {
      await supabase.from('positions').delete().eq('id', existing.id);
    }
    return;
  }

  // Average price is the cost basis. For LONG adds: weighted average.
  // For SHORT opens: the short proceeds become the basis. For closes
  // (either side) and covers, the basis is preserved (no re-average).
  let newAvgPrice: number;
  if (existing) {
    const wasLong = existing.qty > 0;
    const wasShort = existing.qty < 0;
    const openingLong = direction === 'LONG' && side === 'BUY' && !wasLong;
    const addingToLong = direction === 'LONG' && side === 'BUY' && wasLong;
    const openingShort = direction === 'SHORT' && side === 'SELL' && !wasShort;
    const addingToShort = direction === 'SHORT' && side === 'SELL' && wasShort;

    if (openingLong) {
      // Was 0 (or didn't exist); new basis = fill price.
      newAvgPrice = price;
    } else if (addingToLong) {
      // Weighted average of existing long cost basis + this fill.
      const cost = existing.qty * existing.avg_price + qty * price;
      newAvgPrice = cost / newQty;
    } else if (openingShort) {
      // First short entry: basis = fill price (the proceeds price).
      newAvgPrice = price;
    } else if (addingToShort) {
      // Adding to an existing short. existing.qty is negative; abs() it
      // for the weighted-average math.
      const existingAbs = Math.abs(existing.qty);
      const cost = existingAbs * existing.avg_price + qty * price;
      newAvgPrice = cost / (existingAbs + qty);
    } else {
      // Closing or covering: basis is preserved. (Real accounting
      // would realize P&L into the basis; for paper trading we keep
      // the running avg so the unrealized P&L display is sensible.)
      newAvgPrice = existing.avg_price;
    }
  } else {
    newAvgPrice = price;
  }

  if (existing) {
    await supabase
      .from('positions')
      .update({ qty: newQty, avg_price: newAvgPrice })
      .eq('id', existing.id);
  } else {
    await supabase
      .from('positions')
      .insert({ portfolio_id: portfolioId, ticker, qty: newQty, avg_price: newAvgPrice });
  }
}

// ============================================================
// POSITIONS
// ============================================================

export async function getPositions(portfolioId?: string): Promise<Position[]> {
  let query = supabase
    .from('positions')
    .select('*')
    .order('ticker', { ascending: true });

  if (portfolioId) {
    query = query.eq('portfolio_id', portfolioId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Compute a portfolio's total equity (cash + market value of all
 * positions) and available cash on demand, using the latest cached
 * prices from `instrument_prices`. Used by the AI chat to resolve
 * percentage / fraction commands ("spend 10% of my portfolio on
 * AAPL") to a USD notional right before executeTrade().
 *
 * Equity = current_capital + sum(qty * current_price) for every
 * position. Short positions contribute their negative market value
 * to equity (so a -100 AAPL short at $200 = -$20k of equity).
 *
 * Returns both numbers so callers can pick the base they need
 * (PCT_PORTFOLIO / PCT_CASH / FRACTION_*).
 */
export async function computePortfolioEquity(portfolioId: string): Promise<{
  cash: number;
  equity: number;
  longValue: number;
  shortValue: number;
}> {
  const [{ data: portfolio }, { data: positions }] = await Promise.all([
    supabase
      .from('portfolios')
      .select('current_capital')
      .eq('id', portfolioId)
      .maybeSingle(),
    supabase
      .from('positions')
      .select('ticker, qty, current_price')
      .eq('portfolio_id', portfolioId),
  ]);
  const cash = Number(portfolio?.current_capital ?? 0);
  let longValue = 0;
  let shortValue = 0;
  for (const p of positions ?? []) {
    const qty = Number(p.qty ?? 0);
    // Prefer the position row's current_price (written by
    // writeSnapshotAfterTrade after every trade); fall back to the
    // instrument_prices cache for positions whose mark is stale.
    let px = Number(p.current_price ?? 0);
    if (!Number.isFinite(px) || px <= 0) {
      const cached = await getCachedPrice(p.ticker);
      px = cached ?? 0;
    }
    if (!Number.isFinite(px) || px <= 0) continue;
    const mv = qty * px;
    if (mv >= 0) longValue += mv;
    else shortValue += mv;
  }
  const equity = cash + longValue + shortValue;
  return { cash, equity, longValue, shortValue };
}

export async function updatePositionPrice(
  id: string,
  currentPrice: number
): Promise<void> {
  await supabase
    .from('positions')
    .update({ current_price: currentPrice })
    .eq('id', id);
}

/**
 * "Since the buy" baseline equity for a portfolio.
 *
 * P&L denominators used to be `portfolio.initial_capital` (papertrading
 * inception), which makes a single fresh trade show a meaningless
 * fraction-of-$100M return. The user-visible contract is "since the
 * first buy", so we anchor on the equity of the earliest trade date.
 *
 * Resolution order:
 *   1. Earliest snapshot's equity (written by writeSnapshotAfterTrade's
 *      backfill — covers the trade date itself).
 *   2. Replay trades up to and including the earliest trade date using
 *      fill prices, if no snapshot exists yet (defensive: covers the
 *      window between trade and next snapshot write).
 *   3. `initial_capital` as a last resort (no trades → no return).
 */
export function computeBuyBaselineEquity(
  initialCapital: number,
  trades: Array<{ ticker: string; side: 'BUY' | 'SELL'; qty: number; price: number; executed_at: string }>,
  snapshots: Array<{ snapshot_date: string; equity: number }>,
): number {
  if (trades.length === 0) return initialCapital;
  const earliestDate = trades
    .map((t) => t.executed_at.slice(0, 10))
    .sort()[0];
  const snap = snapshots.find((s) => s.snapshot_date === earliestDate);
  if (snap && Number.isFinite(snap.equity) && snap.equity > 0) {
    return snap.equity;
  }
  let cash = initialCapital;
  const positions = new Map<string, { qty: number; avg_price: number }>();
  const sorted = [...trades].sort(
    (a, b) => a.executed_at.localeCompare(b.executed_at),
  );
  for (const t of sorted) {
    const day = t.executed_at.slice(0, 10);
    if (day > earliestDate) break;
    cash += t.side === 'BUY' ? -t.qty * t.price : t.qty * t.price;
    const tk = t.ticker.toUpperCase();
    const existing = positions.get(tk);
    const signedDelta = t.side === 'BUY' ? t.qty : -t.qty;
    const newQty = (existing?.qty ?? 0) + signedDelta;
    if (newQty === 0) {
      positions.delete(tk);
      continue;
    }
    let newAvg: number;
    if (existing) {
      const wasLong = existing.qty > 0;
      const addingToLong = t.side === 'BUY' && wasLong;
      if (addingToLong) {
        newAvg =
          (existing.qty * existing.avg_price + t.qty * t.price) / newQty;
      } else {
        newAvg = t.price;
      }
    } else {
      newAvg = t.price;
    }
    positions.set(tk, { qty: newQty, avg_price: newAvg });
  }
  let mv = 0;
  for (const pos of positions.values()) mv += pos.qty * pos.avg_price;
  return cash + mv;
}

// ============================================================
// DAILY SNAPSHOTS
// ============================================================

export async function getSnapshots(
  portfolioId: string,
  days = 90
): Promise<DailySnapshot[]> {
  const { data, error } = await supabase
    .from('daily_snapshots')
    .select('*')
    .eq('portfolio_id', portfolioId)
    .order('snapshot_date', { ascending: true })
    .limit(days);

  if (error) throw error;
  // Drop weekend + US-market-holiday rows at the source. The backfill
  // writes one row per calendar day; non-trading-day rows are flat
  // carry-forward values that distort every chart and risk metric
  // (equity curve, daily returns, drawdown walk, Sharpe window, etc.).
  // The raw rows stay in the DB for audit; we just don't surface them.
  return (data ?? []).filter((s) => isTradingDay(s.snapshot_date));
}

/**
 * True for Mon-Fri (UTC) and not a US market holiday. Used to filter
 * weekend + holiday rows out of charts and risk metrics — the
 * backfill writes a snapshot for every calendar day, but non-trading
 * days have no real price action. Including them produces flat
 * 100m points that distort the equity curve and the daily-return /
 * drawdown / Sharpe series. NYSE/US-holiday calendar is a reasonable
 * proxy for the equities in this app; non-US tickers have their own
 * exchange calendars and may show a flat row for those days, but the
 * damage is bounded (one day per foreign holiday) and the user can
 * switch the calendar here if it matters.
 */
export function isTradingDay(isoDate: string): boolean {
  const dow = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !isUsMarketHoliday(isoDate);
}

export async function createSnapshot(input: {
  portfolio_id: string;
  snapshot_date: string;
  equity: number;
  exposure: number;
  cash: number;
  daily_return?: number;
}): Promise<void> {
  await supabase.from('daily_snapshots').upsert(input, {
    onConflict: 'portfolio_id,snapshot_date',
  });
}

/**
 * Persist a `daily_snapshots` row for the portfolio right after a
 * trade executes. Computes the trade-date portfolio equity from the
 * just-written positions table, marks each position to the live
 * price from the `instrument_prices` cache (the same one the Python
 * scheduler keeps fresh from Bloomberg), and writes the row directly
 * via the Supabase client — bypassing the `compute-snapshots` Edge
 * Function entirely.
 *
 * Why direct-write instead of the edge function:
 *   - The edge function path (compute-snapshots) was unreliable in
 *     this environment: it requires either a user JWT or the
 *     INTERNAL_API_KEY shared secret, and the JWT path was
 *     occasionally rejected when the user session was stale.
 *   - The frontend is already authenticated to Supabase (it just
 *     wrote the trades row, updated positions, and updated cash).
 *     Adding one more row write uses the same auth chain, no extra
 *     cold start, no extra network hop.
 *   - The data sources are identical: positions table (canonical
 *     state after the trade) and instrument_prices cache (the same
 *     live price the position row would be marked to anywhere else
 *     in the app).
 *
 * For back-dated trades (e.g. the AI chat's "buy AAPL a year ago"),
 * `snapshotDate` is the trade's `executed_at` date — NOT today. The
 * function then replays the entire trade log from the earliest
 * affected trade through today and writes one snapshot per calendar
 * day, so the chart has a continuous series instead of two isolated
 * points. Today uses live prices; historical days use the trade
 * fill price as the mark (instrument_price_history is populated by
 * the edge function + Python scheduler and may be empty for tickers
 * the user hasn't backfilled).
 *
 * Idempotent: re-running for the same (portfolio_id, snapshot_date)
 * deletes + re-inserts the prior row.
 *
 * Errors are swallowed — the user already saw the trade succeed and
 * the trade UX must not wait on this write.
 */
export async function writeSnapshotAfterTrade(
  portfolioId: string,
  snapshotDate?: string,
): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const tradeDate = (snapshotDate ?? today).slice(0, 10);

    // 1. Fetch the just-updated positions, portfolio, and the full
    // trade log (sorted oldest-first) for replay.
    const [{ data: portfolio }, { data: positions }, { data: trades }] = await Promise.all([
      supabase
        .from('portfolios')
        .select('current_capital, initial_capital')
        .eq('id', portfolioId)
        .maybeSingle(),
      supabase
        .from('positions')
        .select('ticker, qty, avg_price, sector')
        .eq('portfolio_id', portfolioId),
      supabase
        .from('trades')
        .select('ticker, side, direction, qty, price, executed_at')
        .eq('portfolio_id', portfolioId)
        .order('executed_at', { ascending: true }),
    ]);
    if (!portfolio) return;
    const posList = positions ?? [];
    const tradeList = (trades ?? []) as Array<{
      ticker: string;
      side: 'BUY' | 'SELL';
      direction: 'LONG' | 'SHORT' | null;
      qty: number;
      price: number;
      executed_at: string;
    }>;

    // 2. Fetch the live prices for every position's ticker (in
    // parallel). Fall back to avg_price for any ticker without a
    // cached price so today's snapshot can still be written
    // (degenerate mark, but not blocking).
    const tickers = Array.from(new Set(posList.map((p) => p.ticker.toUpperCase())));
    const livePriceMap = new Map<string, number>();
    if (tickers.length > 0) {
      const { data: priceRows } = await supabase
        .from('instrument_prices')
        .select('ticker, current_price')
        .in('ticker', tickers);
      for (const r of priceRows ?? []) {
        if (r.current_price != null) {
          livePriceMap.set(r.ticker.toUpperCase(), Number(r.current_price));
        }
      }
    }

    // 3. Compute the "today" snapshot (live mark, full L/S columns).
    // This is what PerformanceCharts reads for the most recent point
    // and what the L/S strip / HHI footer read.
    const todaySnapshot = computeLiveSnapshot(
      posList,
      livePriceMap,
      Number(portfolio.current_capital) || 0,
    );

    // 4. Write today's snapshot first (delete + insert for idempotency
    // under the existing RLS grants — no UPDATE policy exists).
    // daily_return is null here; patched after backfill so the prior
    // row is yesterday (not the trade date).
    await upsertSnapshotRow(portfolioId, today, {
      equity: todaySnapshot.equity,
      exposure: todaySnapshot.grossExposure,
      cash: todaySnapshot.cash,
      daily_return: null,
      long_value: todaySnapshot.longValue,
      short_value: todaySnapshot.shortValue,
      net_value: todaySnapshot.netValue,
      long_pct: todaySnapshot.longPct,
      short_pct: todaySnapshot.shortPct,
      net_pct: todaySnapshot.netPct,
      gross_pct: todaySnapshot.grossPct,
      sector_jsonb: todaySnapshot.sectorMap,
      position_jsonb: todaySnapshot.positionJsonb,
    });

    // 5. If the trade is back-dated, backfill every calendar day
    // from the earliest trade through yesterday. Today is already
    // written above with live marks; historical days use trade fill
    // prices as the mark.
    if (tradeDate < today && tradeList.length > 0) {
      await backfillHistoricalSnapshots(portfolioId, tradeList, tradeDate, today);
    }

    // 6. Patch today's daily_return vs the prior *trading* day. Done
    // AFTER backfill so the prior row is yesterday, not the trade
    // date — otherwise the first day's chart would show the entire
    // back-dated period as a single "daily" return. We walk back
    // over weekends + US holidays so a Monday measure against the
    // prior Friday's close, not the flat Saturday carry-forward.
    const priorDate = await getPriorTradingSnapshotDate(portfolioId, today);
    if (priorDate) {
      const priorEquity = await getSnapshotEquity(portfolioId, priorDate);
      if (priorEquity != null && priorEquity > 0) {
        await patchDailyReturn(
          portfolioId,
          today,
          (todaySnapshot.equity - priorEquity) / priorEquity,
        );
      }
    }
  } catch (err) {
    console.warn('writeSnapshotAfterTrade failed (non-fatal):', err);
  }
}

// ----- Snapshot helpers -----

interface LiveSnapshot {
  cash: number;
  equity: number;
  longValue: number;
  shortValue: number;
  netValue: number;
  grossExposure: number;
  longPct: number | null;
  shortPct: number | null;
  netPct: number | null;
  grossPct: number | null;
  sectorMap: Record<string, { long: number; short: number; net: number }>;
  positionJsonb: Record<string, unknown>;
}

/**
 * Build a full snapshot row from the current positions table + a
 * mark-price map (live prices from `instrument_prices`, or any other
 * source). Mirrors the math the original writeSnapshotAfterTrade
 * used for today's row.
 */
function computeLiveSnapshot(
  posList: Array<{ ticker: string; qty: number; avg_price: number; sector: string | null }>,
  priceMap: Map<string, number>,
  cash: number,
): LiveSnapshot {
  const positionJsonb: Record<string, unknown> = {};
  let longValue = 0;
  let shortValue = 0;
  const sectorMap: Record<string, { long: number; short: number; net: number }> = {};
  for (const p of posList) {
    const tk = p.ticker.toUpperCase();
    const mark = priceMap.get(tk) ?? Number(p.avg_price) ?? 0;
    const mv = Number(p.qty) * mark;
    const avg = Number(p.avg_price);
    let returnPct: number | null = null;
    if (avg > 0 && mark > 0) {
      const priceReturn = (mark - avg) / avg;
      returnPct = Number(p.qty) >= 0 ? priceReturn * 100 : -priceReturn * 100;
    }
    positionJsonb[tk] = {
      qty: Number(p.qty),
      mv,
      sector: p.sector ?? null,
      avg_price: avg,
      price: mark,
      return_pct: returnPct,
    };
    if (mv >= 0) longValue += mv;
    else shortValue += mv;
    const sec = p.sector ?? 'Unknown';
    const entry = sectorMap[sec] ?? { long: 0, short: 0, net: 0 };
    if (mv >= 0) entry.long += mv;
    else entry.short += mv;
    entry.net = entry.long + entry.short;
    sectorMap[sec] = entry;
  }
  const netValue = longValue + shortValue;
  const grossExposure = longValue + Math.abs(shortValue);
  const equity = cash + netValue;
  return {
    cash,
    equity,
    longValue,
    shortValue,
    netValue,
    grossExposure,
    longPct: equity > 0 ? (longValue / equity) * 100 : null,
    shortPct: equity > 0 ? (shortValue / equity) * 100 : null,
    netPct: equity > 0 ? (netValue / equity) * 100 : null,
    grossPct: equity > 0 ? (grossExposure / equity) * 100 : null,
    sectorMap,
    positionJsonb,
  };
}

/**
 * Insert-or-update a snapshot row via the (portfolio_id, snapshot_date)
 * unique key. Uses Supabase's native upsert so we only need the
 * INSERT RLS policy (granted in 001_initial_schema.sql) — works
 * whether or not the UPDATE and DELETE policies from 008/010 have
 * been deployed. The previous delete+insert pattern was fragile
 * against RLS: a rejected DELETE silently left the prior row in
 * place, then the INSERT hit a unique-constraint violation and
 * silently lost the new values, leaving the row stuck on the old
 * equity (which is what produced the "no data for June 18" gap).
 */
async function upsertSnapshotRow(
  portfolioId: string,
  snapshotDate: string,
  row: Record<string, unknown>,
): Promise<void> {
  const { error: insErr } = await supabase
    .from('daily_snapshots')
    .upsert(
      { portfolio_id: portfolioId, snapshot_date: snapshotDate, ...row },
      { onConflict: 'portfolio_id,snapshot_date' },
    );
  if (insErr) {
    console.warn(`snapshot upsert failed for ${snapshotDate} (non-fatal):`, insErr);
  }
}

/**
 * Update only the `daily_return` column on an existing snapshot row.
 * Used to backfill the today-vs-yesterday return after both rows are
 * known. Reads the existing row, then upserts the full row with the
 * new daily_return value — works under the INSERT-only RLS grant
 * without needing UPDATE/DELETE policies.
 */
async function patchDailyReturn(
  portfolioId: string,
  snapshotDate: string,
  dailyReturn: number,
): Promise<void> {
  const { data: existing } = await supabase
    .from('daily_snapshots')
    .select('*')
    .eq('portfolio_id', portfolioId)
    .eq('snapshot_date', snapshotDate)
    .maybeSingle();
  if (!existing) return;
  const { error: upErr } = await supabase
    .from('daily_snapshots')
    .upsert(
      { ...existing, daily_return: dailyReturn },
      { onConflict: 'portfolio_id,snapshot_date' },
    );
  if (upErr) {
    console.warn(`daily_return patch failed for ${snapshotDate} (non-fatal):`, upErr);
  }
}

async function getPriorSnapshotDate(
  portfolioId: string,
  beforeDate: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('daily_snapshots')
    .select('snapshot_date')
    .eq('portfolio_id', portfolioId)
    .lt('snapshot_date', beforeDate)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.snapshot_date ?? null;
}

/**
 * Like getPriorSnapshotDate, but skips weekend + US-market-holiday
 * rows so the return on a Monday measures against the prior Friday's
 * close (not the flat Saturday carry-forward). Looks back up to 14
 * days — a long weekend is at most 3 calendar days, 14 is enough
 * buffer for a one-time clock skew or future holiday cluster.
 */
async function getPriorTradingSnapshotDate(
  portfolioId: string,
  beforeDate: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('daily_snapshots')
    .select('snapshot_date')
    .eq('portfolio_id', portfolioId)
    .lt('snapshot_date', beforeDate)
    .order('snapshot_date', { ascending: false })
    .limit(14);
  for (const row of data ?? []) {
    if (isTradingDay(row.snapshot_date)) return row.snapshot_date;
  }
  return null;
}

async function getSnapshotEquity(
  portfolioId: string,
  snapshotDate: string,
): Promise<number | null> {
  const { data } = await supabase
    .from('daily_snapshots')
    .select('equity')
    .eq('portfolio_id', portfolioId)
    .eq('snapshot_date', snapshotDate)
    .maybeSingle();
  return data ? Number(data.equity) : null;
}

/**
 * Fetch a `ticker -> Map<YYYY-MM-DD, close>` view of
 * `instrument_price_history` for the given tickers over [from..to]
 * (inclusive). Returns an empty map if the table has no rows for the
 * window — callers should fall back to fill-price marks in that case.
 *
 * `instrument_price_history` is populated by the
 * `market-data/historical-series` edge function (Bloomberg relay) and
 * by the bloomberg-service scheduler. The table has a public-read RLS
 * policy so the anon key can read it without authentication.
 */
async function fetchDailyCloseMap(
  tickers: string[],
  from: string,
  to: string,
): Promise<Map<string, Map<string, number>>> {
  const cleaned = Array.from(new Set(tickers.map((t) => t.toUpperCase())))
    .filter(Boolean);
  if (cleaned.length === 0) return new Map();
  const { data, error } = await supabase
    .from('instrument_price_history')
    .select('ticker, trade_date, close')
    .in('ticker', cleaned)
    .gte('trade_date', from)
    .lte('trade_date', to);
  if (error || !data) return new Map();
  const out = new Map<string, Map<string, number>>();
  for (const row of data) {
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

/**
 * In-memory trade-log replay for backfill. For each calendar day from
 * `fromDate` (inclusive) through `toDate` (exclusive — today's row is
 * written separately with live marks):
 *   - Cash = initial_capital + sum(cashDelta for trades with
 *     executed_at date <= day). SELL adds cash, BUY subtracts.
 *   - Positions = apply all trades with executed_at date <= day, in
 *     order, using the same rules as updatePositionAfterTrade
 *     (signed qty + signed-aware avg price).
 *   - Mark price for (ticker, day) = the close from
 *     `instrument_price_history` if available for that calendar day;
 *     otherwise the trade fill price of the most recent trade in or
 *     before `day` for that ticker; otherwise the position's avg_price.
 *     Using real close prices is what makes the equity curve drift
 *     realistically instead of sitting flat at cost basis.
 *   - equity = cash + sum(qty * mark).
 *
 * Each day's snapshot is written with full L/S columns where
 * computable; long_value/short_value/sector_jsonb/position_jsonb are
 * left null for historical days (PerformanceCharts and RiskPage don't
 * read them off historical rows — only the live "today" snapshot is
 * consumed by the L/S strip / HHI footer).
 */
async function backfillHistoricalSnapshots(
  portfolioId: string,
  trades: Array<{
    ticker: string;
    side: 'BUY' | 'SELL';
    direction: 'LONG' | 'SHORT' | null;
    qty: number;
    price: number;
    executed_at: string;
  }>,
  fromDate: string,
  toDateExclusive: string,
): Promise<void> {
  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('initial_capital')
    .eq('id', portfolioId)
    .maybeSingle();
  const initialCapital = Number(portfolio?.initial_capital) || 0;

  // Index trades by their YYYY-MM-DD date for fast day lookup.
  const tradesByDay = new Map<string, typeof trades>();
  for (const t of trades) {
    const day = t.executed_at.slice(0, 10);
    const list = tradesByDay.get(day) ?? [];
    list.push(t);
    tradesByDay.set(day, list);
  }

  // Best-effort fetch of real daily closes from instrument_price_history.
  // Failures (table missing, RLS, etc.) are non-fatal — we just fall
  // back to the existing fill-price mark behaviour, so the curve is
  // flat at cost basis instead of broken.
  const heldTickers = Array.from(new Set(trades.map((t) => t.ticker.toUpperCase())));
  const yesterday = new Date(`${toDateExclusive}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  const closeMap = await fetchDailyCloseMap(heldTickers, fromDate, yesterdayStr);

  // Replay state: cash and positions.
  let cash = initialCapital;
  type ReplayPos = { qty: number; avg_price: number };
  const positions = new Map<string, ReplayPos>();

  // Apply any trades strictly before fromDate first (so the fromDate
  // row reflects end-of-fromDate state, which includes trades dated
  // exactly on fromDate).
  for (const t of trades) {
    if (t.executed_at.slice(0, 10) < fromDate) {
      applyTrade(positions, cash, t);
      cash = applyCash(cash, t);
    }
  }

  // Walk every calendar day from fromDate through toDateExclusive.
  // We step in 1-day increments; up to ~365 iterations for a 1Y
  // backfill, which is cheap.
  const cursor = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDateExclusive}T00:00:00Z`);
  // Track the prior *trading-day* equity, not the prior calendar
  // day. Non-trading days (weekends + US holidays) carry forward the
  // last trading day's equity and write daily_return = 0; trading
  // days compute their return against the last real trading day so
  // Monday's bar reflects Fri→Mon move, not Fri→flat-Sun→Mon.
  // Without this, the chart and Sharpe / VaR windows pick up a
  // string of ~0 returns on weekends and a single "weekly" return
  // on Mondays, both of which distort the distribution.
  let prevTradingEquity: number | null = null;

  while (cursor < end) {
    const day = cursor.toISOString().slice(0, 10);
    const todaysTrades = tradesByDay.get(day) ?? [];
    for (const t of todaysTrades) {
      applyTrade(positions, cash, t);
      cash = applyCash(cash, t);
    }

    // Mark each open position: prefer the real daily close, fall
    // back to the most recent trade fill price on or before `day`,
    // then to avg_price. This is what makes the curve drift
    // realistically when Bloomberg history is cached, while still
    // producing a sane curve (flat at cost basis) when it isn't.
    let netValue = 0;
    let grossExposure = 0;
    for (const [tk, pos] of positions) {
      const close = closeMap.get(tk)?.get(day);
      const lastFill = lastFillPriceBefore(trades, tk, day);
      const mark = close ?? lastFill ?? pos.avg_price;
      const mv = pos.qty * mark;
      netValue += mv;
      grossExposure += Math.abs(mv);
    }
    const equity = cash + netValue;
    const isTrading = isTradingDay(day);
    // On a real trading day, the daily return is the move since the
    // prior trading day. On a non-trading day we write 0 (no price
    // action) and do NOT advance prevTradingEquity, so the next
    // trading day still measures against the last real close.
    const dailyReturn = !isTrading
      ? 0
      : prevTradingEquity != null && prevTradingEquity > 0
        ? (equity - prevTradingEquity) / prevTradingEquity
        : null;

    await upsertSnapshotRow(portfolioId, day, {
      equity,
      exposure: grossExposure,
      cash,
      daily_return: dailyReturn,
      // L/S jsonb left null for historical rows — see header.
    });

    if (isTrading) prevTradingEquity = equity;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function applyCash(
  cash: number,
  t: { side: 'BUY' | 'SELL'; qty: number; price: number },
): number {
  const totalCost = t.qty * t.price;
  // BUY pays out; SELL receives. Holds for long and short alike.
  return cash + (t.side === 'BUY' ? -totalCost : totalCost);
}

/**
 * In-memory mirror of updatePositionAfterTrade. Mutates `positions`
 * for the given trade and returns nothing. (We ignore the `cash`
 * parameter on the signature — kept for symmetry with the live
 * helper but cash flow is handled by applyCash above.)
 */
function applyTrade(
  positions: Map<string, { qty: number; avg_price: number }>,
  _cash: number,
  t: {
    ticker: string;
    side: 'BUY' | 'SELL';
    direction: 'LONG' | 'SHORT' | null;
    qty: number;
    price: number;
  },
): void {
  const tk = t.ticker.toUpperCase();
  const direction = t.direction ?? 'LONG';
  const existing = positions.get(tk);
  const signedDelta = t.side === 'BUY' ? t.qty : -t.qty;
  const newQty = (existing?.qty ?? 0) + signedDelta;
  if (newQty === 0) {
    positions.delete(tk);
    return;
  }
  let newAvg: number;
  if (existing) {
    const wasLong = existing.qty > 0;
    const wasShort = existing.qty < 0;
    const openingLong = direction === 'LONG' && t.side === 'BUY' && !wasLong;
    const addingToLong = direction === 'LONG' && t.side === 'BUY' && wasLong;
    const openingShort = direction === 'SHORT' && t.side === 'SELL' && !wasShort;
    const addingToShort = direction === 'SHORT' && t.side === 'SELL' && wasShort;
    if (openingLong) newAvg = t.price;
    else if (addingToLong) {
      newAvg = (existing.qty * existing.avg_price + t.qty * t.price) / newQty;
    } else if (openingShort) newAvg = t.price;
    else if (addingToShort) {
      const existingAbs = Math.abs(existing.qty);
      newAvg = (existingAbs * existing.avg_price + t.qty * t.price) / (existingAbs + t.qty);
    } else newAvg = existing.avg_price;
  } else {
    newAvg = t.price;
  }
  positions.set(tk, { qty: newQty, avg_price: newAvg });
}

/**
 * Find the most recent trade fill price for `ticker` on or before
 * `day`. The trade list is already sorted ascending by executed_at,
 * so a single reverse pass is enough.
 */
function lastFillPriceBefore(
  trades: Array<{ ticker: string; price: number; executed_at: string }>,
  ticker: string,
  day: string,
): number | null {
  const tk = ticker.toUpperCase();
  let best: number | null = null;
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (t.ticker.toUpperCase() !== tk) continue;
    if (t.executed_at.slice(0, 10) <= day) {
      best = Number(t.price);
      break;
    }
  }
  return best;
}

/**
 * @deprecated Use writeSnapshotAfterTrade() instead. This function
 * used to fire-and-forget call the `compute-snapshots` Edge
 * Function, but that path was unreliable in this environment. Kept
 * as a no-op stub so any lingering call sites don't break the build.
 */
export function triggerSnapshotRefresh(_portfolioId: string): void {
  // No-op: the snapshot is now written directly by
  // writeSnapshotAfterTrade (called from executeTrade).
}

/**
 * Fill any gap in `daily_snapshots` between the most recent existing
 * row and the most recent trading day. Without this, a portfolio that
 * doesn't trade for 2-3 days keeps a stale "right edge" on the equity
 * curve even though `instrument_prices` is being updated by the
 * Python scheduler — the chart is read straight from the snapshot
 * table, so a missing row reads as a flat carry-forward to the prior
 * trade date, then a sudden jump when the next trade (or the next
 * page load) finally writes today's row.
 *
 * Strategy: find the latest snapshot date, then call
 * `writeSnapshotAfterTrade(portfolioId, latestDate)`. The existing
 * `writeSnapshotAfterTrade` `tradeDate < today` branch triggers
 * `backfillHistoricalSnapshots` for every calendar day in between
 * (marked at real `instrument_price_history` close when available,
 * else the last fill price), then rewrites today's row with live
 * marks and patches today's `daily_return` against the last backfill
 * row — so the chain stays continuous and Sharpe / drawdown / L/S
 * metrics all see the freshly-inserted days.
 *
 * Idempotent: if there's no gap (latest row is already on the most
 * recent trading day) this is a single-row no-op rewrite of today.
 *
 * Errors are swallowed: same rationale as `writeSnapshotAfterTrade`
 * — the UI must not block on this.
 */
export async function fillSnapshotGap(portfolioId: string): Promise<void> {
  try {
    const { data: latest } = await supabase
      .from('daily_snapshots')
      .select('snapshot_date')
      .eq('portfolio_id', portfolioId)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    const latestDate = latest?.snapshot_date
      ? String(latest.snapshot_date).slice(0, 10)
      : undefined;
    const today = new Date().toISOString().slice(0, 10);
    // Walk back from today to the most recent trading day. Today may
    // be a weekend or US holiday; in that case the "gap" we want to
    // close is up through the last weekday.
    let cursor = new Date(`${today}T00:00:00Z`);
    while (!isTradingDay(cursor.toISOString().slice(0, 10))) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    const lastTradingDay = cursor.toISOString().slice(0, 10);
    // No snapshots at all — seed a 30-day initial-capital baseline so
    // the rolling Sharpe (20-day window) has enough observations on a
    // brand-new portfolio before its first trade. Without this, a
    // portfolio opened today shows Sharpe = N/A for the first ~20
    // days even after the daily scheduler ticks.
    if (!latestDate) {
      await seedInitialCapitalSnapshots(portfolioId, lastTradingDay);
      // After seeding, write today's live-marked row too so the
      // chart's right edge isn't pinned to the last seeded baseline.
      await writeSnapshotAfterTrade(portfolioId);
      return;
    }
    if (latestDate >= lastTradingDay) return;
    // If the latest row is itself a non-trading day (shouldn't happen
    // — getSnapshots filters them out at read time, but writes don't
    // gate on it) we still want to pass it as the start so
    // the chain re-anchors on the most recent real trading day.
    await writeSnapshotAfterTrade(portfolioId, latestDate);
  } catch (err) {
    console.warn('fillSnapshotGap failed (non-fatal):', err);
  }
}

/**
 * Seed the past 30 trading days of `daily_snapshots` for a brand-new
 * portfolio with no trade history. Every row is marked at the
 * portfolio's `current_capital` (no positions, no P&L) with
 * `daily_return = 0` — this gives the rolling Sharpe chart on the
 * Performance page enough non-null observations to compute even
 * before the first trade fires. The daily scheduler (or a subsequent
 * trade) will overwrite these rows with real marks once positions are
 * opened. Idempotent: re-running is a no-op because of the
 * upsert on (portfolio_id, snapshot_date).
 */
async function seedInitialCapitalSnapshots(
  portfolioId: string,
  endDate: string,
): Promise<void> {
  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('current_capital, initial_capital')
    .eq('id', portfolioId)
    .maybeSingle();
  if (!portfolio) return;
  const cash = Number(portfolio.current_capital) || Number(portfolio.initial_capital) || 0;
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  const rows: Array<{
    portfolio_id: string;
    snapshot_date: string;
    equity: number;
    exposure: number;
    cash: number;
    daily_return: number;
    long_value: number;
    short_value: number;
    net_value: number;
    long_pct: number | null;
    short_pct: number | null;
    net_pct: number | null;
    gross_pct: number | null;
  }> = [];
  const cursor = new Date(start);
  while (cursor <= new Date(`${endDate}T00:00:00Z`)) {
    const day = cursor.toISOString().slice(0, 10);
    rows.push({
      portfolio_id: portfolioId,
      snapshot_date: day,
      equity: cash,
      exposure: 0,
      cash,
      daily_return: 0,
      long_value: 0,
      short_value: 0,
      net_value: 0,
      long_pct: null,
      short_pct: null,
      net_pct: null,
      gross_pct: null,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (rows.length === 0) return;
  const { error } = await supabase
    .from('daily_snapshots')
    .upsert(rows, { onConflict: 'portfolio_id,snapshot_date' });
if (error) {
    console.warn('seedInitialCapitalSnapshots upsert failed:', error.message);
  }
}

/**
 * Manual "Recompute snapshots" trigger used by the Risk page's
 * debug button. Awaits the response so the caller can show success
 * / failure to the user. Delegates to `fillSnapshotGap` so the
 * behavior matches the silent page-load heal (fills any gap from the
 * latest existing row through the most recent trading day) instead
 * of the previous behavior — which only re-anchored on the earliest
 * trade date and did not refresh today when there was no recent
 * trade.
 */
export async function recomputeSnapshots(portfolioId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await fillSnapshotGap(portfolioId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ============================================================
// POSITION HISTORY (reconstructed from trades)
// ============================================================

/**
 * A single point on a reconstructed per-position P&L curve. The
 * curve is derived from the trade log — there is no historical price
 * table in this app, so we can only chart what the trades themselves
 * tell us: the running quantity and weighted-average cost basis at
 * each fill, plus a final "current mark" using the live price.
 *
 * Each entry represents the state of the position AFTER the trade
 * with the given `trade_timestamp` was applied. The "current" entry
 * is appended at the end using the live price for the P&L overlay.
 */
export interface PositionHistoryPoint {
  date: string; // ISO timestamp of the trade (or "now" for the live point)
  qty: number; // signed running quantity
  avgPrice: number; // weighted-average cost basis
  marketValue: number; // signed qty * avgPrice (mark-to-cost)
  pnl: number | null; // null for historical points (no market price); number for the live point
  pnlPct: number | null;
  isLive: boolean; // true for the trailing "now" point using a live price
}

/**
 * Replay the trade log for one (portfolio, ticker) pair in
 * chronological order and return a series of (date, qty, avgPrice,
 * marketValue, pnl, pnlPct) points. Uses the same signed-qty /
 * signed-avg rules as updatePositionAfterTrade().
 *
 * The series has one point per calendar day from the earliest trade
 * date through today (inclusive), so the chart shows a continuous
 * curve instead of disconnected trade-date dots. Each day is marked
 * at the close price from `closePriceMap` (ticker -> YYYY-MM-DD ->
 * close) if available; otherwise the most recent trade fill price on
 * or before that day; otherwise the running avg_price. P&L is only
 * populated for the trailing live mark and any days where a real
 * close exists.
 *
 * A final "live" point is appended at today's timestamp using
 * `livePrice` so the chart can show current unrealized P&L vs the
 * running cost basis. Without `livePrice`, the last calendar day's
 * close is the tail.
 */
export function buildPositionHistory(
  trades: Trade[],
  ticker: string,
  livePrice: number | null = null,
  closePriceMap: Map<string, number> = new Map(),
): PositionHistoryPoint[] {
  const upper = ticker.toUpperCase();
  const relevant = trades
    .filter((t) => t.ticker.toUpperCase() === upper)
    .sort(
      (a, b) =>
        new Date(a.trade_timestamp).getTime() -
        new Date(b.trade_timestamp).getTime(),
    );

  if (relevant.length === 0) return [];

  // Build the calendar range: earliest trade date through today.
  const earliestMs = relevant.reduce(
    (acc, t) => Math.min(acc, new Date(t.trade_timestamp).getTime()),
    Number.POSITIVE_INFINITY,
  );
  const earliestDate = new Date(earliestMs).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  // Replay trades once into a per-day state table so we know qty /
  // avgPrice at end-of-day for every day in the range.
  const sorted = [...relevant].sort((a, b) =>
    a.trade_timestamp.localeCompare(b.trade_timestamp),
  );
  let qty = 0;
  let avgPrice = 0;
  const dailyCostBasis = new Map<string, { qty: number; avgPrice: number }>();
  for (const t of sorted) {
    const tradeQty = t.qty;
    const tradePrice = t.price;
    const signedDelta = t.side === 'BUY' ? tradeQty : -tradeQty;
    const newQty = qty + signedDelta;

    if (newQty === 0) {
      qty = 0;
      avgPrice = 0;
      dailyCostBasis.set(t.trade_timestamp.slice(0, 10), { qty: 0, avgPrice: 0 });
      continue;
    }

    const wasLong = qty > 0;
    const wasShort = qty < 0;
    const direction = (t.direction ?? 'LONG') as 'LONG' | 'SHORT';
    const openingLong = direction === 'LONG' && t.side === 'BUY' && !wasLong;
    const addingToLong = direction === 'LONG' && t.side === 'BUY' && wasLong;
    const openingShort = direction === 'SHORT' && t.side === 'SELL' && !wasShort;
    const addingToShort = direction === 'SHORT' && t.side === 'SELL' && wasShort;

    let newAvg: number;
    if (openingLong || openingShort || qty === 0) {
      newAvg = tradePrice;
    } else if (addingToLong) {
      newAvg = (qty * avgPrice + tradeQty * tradePrice) / newQty;
    } else if (addingToShort) {
      const existingAbs = Math.abs(qty);
      newAvg = (existingAbs * avgPrice + tradeQty * tradePrice) / (existingAbs + tradeQty);
    } else {
      newAvg = avgPrice;
    }

    qty = newQty;
    avgPrice = newAvg;
    dailyCostBasis.set(t.trade_timestamp.slice(0, 10), { qty, avgPrice });
  }

  // Walk every calendar day from earliestDate through today.
  const series: PositionHistoryPoint[] = [];
  const cursor = new Date(`${earliestDate}T00:00:00Z`);
  const end = new Date(`${today}T00:00:00Z`);
  // Last known cost basis before/equal to cursor; updated as we pass
  // each trade day so days between trades inherit the prior basis.
  let lastQty = 0;
  let lastAvg = 0;
  let lastTradeDay: string | null = null;
  // Trade days (sorted) for forward-fill lookups.
  const tradeDayKeys = Array.from(dailyCostBasis.keys()).sort();
  let tradeDayIdx = 0;
  while (cursor <= end) {
    const day = cursor.toISOString().slice(0, 10);
    if (tradeDayIdx < tradeDayKeys.length && tradeDayKeys[tradeDayIdx] <= day) {
      while (
        tradeDayIdx < tradeDayKeys.length &&
        tradeDayKeys[tradeDayIdx] <= day
      ) {
        const basis = dailyCostBasis.get(tradeDayKeys[tradeDayIdx])!;
        lastQty = basis.qty;
        lastAvg = basis.avgPrice;
        lastTradeDay = tradeDayKeys[tradeDayIdx];
        tradeDayIdx++;
      }
    }

    const close = closePriceMap.get(day);
    // Mark priority: real close > last trade fill price on/before day >
    // running avg_price. lastTradeDay carries the fill price via the
    // running avg, so for the no-close case we just use lastAvg.
    const mark = close ?? (lastQty !== 0 ? lastAvg : null);
    const dayIsToday = day === today;
    // Only emit a point if the position existed on or before this day
    // (we know it did once we're past lastTradeDay) OR the position is
    // currently open (so we still want a "today" baseline). Skip days
    // strictly before the first trade even though the loop won't
    // reach them since we started at earliestDate.
    if (lastQty !== 0 || dayIsToday) {
      const marketValue = lastQty * (mark ?? lastAvg);
      const cost = lastQty * lastAvg;
      const hasPnl = mark != null && lastAvg > 0 && lastQty !== 0;
      const pnl = hasPnl ? marketValue - cost : null;
      const pnlPct = hasPnl && cost !== 0 ? (pnl! / Math.abs(cost)) * 100 : null;
      series.push({
        date: `${day}T00:00:00Z`,
        qty: lastQty,
        avgPrice: lastAvg,
        marketValue,
        pnl,
        pnlPct,
        isLive: false,
      });
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // Append a final live-mark point using livePrice so the user sees
  // today's unrealized P&L against the most recent cost basis.
  if (livePrice != null && livePrice > 0 && qty !== 0) {
    const mv = qty * livePrice;
    const cost = qty * avgPrice;
    const pnl = mv - cost;
    const pnlPct = cost > 0 ? (pnl / Math.abs(cost)) * 100 : 0;
    series.push({
      date: new Date().toISOString(),
      qty,
      avgPrice,
      marketValue: mv,
      pnl,
      pnlPct,
      isLive: true,
    });
  }

  return series;
}

// ============================================================
// ANALYTICS (computed client-side from snapshots)
// ============================================================

export function computePerformanceMetrics(
  portfolio: Portfolio,
  positions: Position[],
  snapshots: DailySnapshot[],
  trades: Trade[] = []
) {
  const totalExposure = positions.reduce(
    (sum, p) => sum + p.qty * (p.current_price || p.avg_price),
    0
  );
  const equity = portfolio.current_capital + totalExposure;
  const baselineEquity = trades.length > 0
    ? computeBuyBaselineEquity(portfolio.initial_capital, trades, snapshots)
    : portfolio.initial_capital;
  const totalReturn =
    baselineEquity > 0 ? ((equity - baselineEquity) / baselineEquity) * 100 : 0;

  const returns = snapshots
    .map((s) => s.daily_return)
    .filter((r): r is number => r !== null);

  const meanReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdDev =
    returns.length > 1
      ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / (returns.length - 1))
      : 0;
  const sharpeRatio = stdDev > 0 ? (meanReturn * 252 - 0.05) / (stdDev * Math.sqrt(252)) : 0;

  // Max drawdown
  let maxDrawdown = 0;
  let peak = baselineEquity;
  for (const s of snapshots) {
    if (s.equity > peak) peak = s.equity;
    const drawdown = ((peak - s.equity) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // Win rate (placeholder - we don't track closed trades PnL yet)
  const winRate = 0;

  return {
    equity,
    totalReturn,
    sharpeRatio,
    maxDrawdown,
    winRate,
    totalExposure,
    positionCount: positions.length,
  };
}
