// Database service - direct Supabase calls
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database.types';

// These types match the SQL schema exactly
export type Portfolio = Database['public']['Tables']['portfolios']['Row'];
export type Trade = Database['public']['Tables']['trades']['Row'];
export type Position = Database['public']['Tables']['positions']['Row'];
export type DailySnapshot = Database['public']['Tables']['daily_snapshots']['Row'];

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
  //     extra cold start. ----
  await writeSnapshotAfterTrade(input.portfolio_id);

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
  return data || [];
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
 * trade executes. Computes today's portfolio equity from the just-
 * written positions table, marks each position to the live price
 * from the `instrument_prices` cache (the same one the Python
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
 * Idempotent: re-running for the same (portfolio_id, snapshot_date)
 * upserts in place. Trade execution is the trigger; a Risk-page
 * "Recompute snapshots" click can also fire this for backfill.
 *
 * Errors are swallowed — the user already saw the trade succeed and
 * the trade UX must not wait on this write.
 */
export async function writeSnapshotAfterTrade(portfolioId: string): Promise<void> {
  try {
    // 1. Fetch the just-updated positions and portfolio.
    const [{ data: portfolio }, { data: positions }] = await Promise.all([
      supabase
        .from('portfolios')
        .select('current_capital, initial_capital')
        .eq('id', portfolioId)
        .maybeSingle(),
      supabase
        .from('positions')
        .select('ticker, qty, avg_price, sector')
        .eq('portfolio_id', portfolioId),
    ]);
    if (!portfolio) return;
    const posList = positions ?? [];

    // 2. Fetch the live prices for every position's ticker (in
    // parallel). Fall back to avg_price for any ticker without a
    // cached price so the snapshot can still be written (degenerate
    // mark, but not blocking).
    const tickers = Array.from(new Set(posList.map((p) => p.ticker.toUpperCase())));
    const priceMap = new Map<string, number>();
    if (tickers.length > 0) {
      const { data: priceRows } = await supabase
        .from('instrument_prices')
        .select('ticker, current_price')
        .in('ticker', tickers);
      for (const r of priceRows ?? []) {
        if (r.current_price != null) {
          priceMap.set(r.ticker.toUpperCase(), Number(r.current_price));
        }
      }
    }

    // 3. Compute per-ticker MV and the per-position "ratio" the
    // user calls the holding-period return. LONG:
    //   return_pct = (price - avgPrice) / avgPrice * 100
    // SHORT (qty < 0):
    //   return_pct = (avgPrice - price) / avgPrice * 100
    // (a short that dropped in price has a positive return — the
    // price-relative formula mirrors the P&L sign convention.)
    const positionJsonb: Record<string, {
      qty: number;
      mv: number;
      sector: string | null;
      avg_price: number;
      price: number;
      return_pct: number | null;
    }> = {};
    let longValue = 0;
    let shortValue = 0;
    const sectorMap: Record<string, { long: number; short: number; net: number }> = {};
    for (const p of posList) {
      const tk = p.ticker.toUpperCase();
      const mark = priceMap.get(tk) ?? Number(p.avg_price) ?? 0;
      const mv = Number(p.qty) * mark;
      let returnPct: number | null = null;
      const avg = Number(p.avg_price);
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
    const cash = Number(portfolio.current_capital) || 0;
    const equity = cash + netValue;

    // 4. daily_return vs the prior snapshot for this same portfolio.
    const today = new Date().toISOString().slice(0, 10);
    const { data: prevSnap } = await supabase
      .from('daily_snapshots')
      .select('equity, snapshot_date')
      .eq('portfolio_id', portfolioId)
      .lt('snapshot_date', today)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    let dailyReturn: number | null = null;
    if (prevSnap && Number(prevSnap.equity) > 0) {
      dailyReturn = (equity - Number(prevSnap.equity)) / Number(prevSnap.equity);
    }

    // 5. Upsert today's snapshot. We do this as a delete-then-insert
    // rather than a true upsert because the existing RLS policy set
    // on daily_snapshots only grants SELECT and INSERT — there is
    // no UPDATE policy (the original schema migration only added
    // SELECT and INSERT). Re-running this code for the same day
    // must replace the prior row with the latest mark, so:
    //   - DELETE any existing row for (portfolio, today) — DELETE
    //     works under the existing schema's grants.
    //   - INSERT the fresh row.
    // This is a small race window (two concurrent trades on the same
    // day), but that's an edge case for a single-user app.
    const row = {
      portfolio_id: portfolioId,
      snapshot_date: today,
      equity,
      exposure: grossExposure,
      cash,
      daily_return: dailyReturn,
      long_value: longValue,
      short_value: shortValue,
      net_value: netValue,
      long_pct: equity > 0 ? (longValue / equity) * 100 : null,
      short_pct: equity > 0 ? (shortValue / equity) * 100 : null,
      net_pct: equity > 0 ? (netValue / equity) * 100 : null,
      gross_pct: equity > 0 ? (grossExposure / equity) * 100 : null,
      sector_jsonb: sectorMap,
      position_jsonb: positionJsonb,
    };
    // Delete first (idempotent — silently no-ops when no row exists).
    await supabase
      .from('daily_snapshots')
      .delete()
      .eq('portfolio_id', portfolioId)
      .eq('snapshot_date', today);
    // Then insert the fresh row. RLS allows INSERT for the user's
    // own portfolios.
    const { error: insErr } = await supabase
      .from('daily_snapshots')
      .insert(row);
    if (insErr) {
      console.warn('writeSnapshotAfterTrade insert failed (non-fatal):', insErr);
    }
  } catch (err) {
    console.warn('writeSnapshotAfterTrade failed (non-fatal):', err);
  }
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
 * Manual "Recompute snapshots" trigger used by the Risk page's
 * debug button. Awaits the response so the caller can show success
 * / failure to the user. Just calls writeSnapshotAfterTrade now
 * (the edge function path was unreliable in this environment).
 */
export async function recomputeSnapshots(portfolioId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await writeSnapshotAfterTrade(portfolioId);
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
 * chronological order and return a series of (date, qty, avgPrice)
 * points. Uses the same signed-qty / signed-avg rules as
 * updatePositionAfterTrade().
 *
 * The final point is an additional "live" mark using `livePrice` (if
 * provided) so the chart can show today's unrealized P&L. Without
 * `livePrice`, the last trade point is the tail.
 */
export function buildPositionHistory(
  trades: Trade[],
  ticker: string,
  livePrice: number | null = null,
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

  let qty = 0;
  let avgPrice = 0;
  const series: PositionHistoryPoint[] = [];

  for (const t of relevant) {
    const tradeQty = t.qty;
    const tradePrice = t.price;
    const signedDelta = t.side === 'BUY' ? tradeQty : -tradeQty;
    const newQty = qty + signedDelta;

    if (newQty === 0) {
      // Position fully closed/covered. Keep prior avg as a marker, qty = 0.
      series.push({
        date: t.trade_timestamp,
        qty: 0,
        avgPrice,
        marketValue: 0,
        pnl: null,
        pnlPct: null,
        isLive: false,
      });
      qty = 0;
      avgPrice = 0;
      continue;
    }

    // Determine if this trade opens or adds (in which case the basis
    // changes) or closes/covers (basis preserved).
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
      // Closing or covering: basis preserved.
      newAvg = avgPrice;
    }

    qty = newQty;
    avgPrice = newAvg;

    series.push({
      date: t.trade_timestamp,
      qty,
      avgPrice,
      marketValue: qty * avgPrice,
      pnl: null,
      pnlPct: null,
      isLive: false,
    });
  }

  // Append a "now" point using the live price so the user can see
  // current unrealized P&L vs the running cost basis.
  if (livePrice != null && livePrice > 0 && qty !== 0) {
    const mv = qty * livePrice;
    const cost = qty * avgPrice;
    const pnl = mv - cost;
    const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
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
  snapshots: DailySnapshot[]
) {
  const totalExposure = positions.reduce(
    (sum, p) => sum + p.qty * (p.current_price || p.avg_price),
    0
  );
  const equity = portfolio.current_capital + totalExposure;
  const totalReturn = ((equity - portfolio.initial_capital) / portfolio.initial_capital) * 100;

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
  let peak = portfolio.initial_capital;
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
