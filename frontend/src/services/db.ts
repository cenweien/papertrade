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

  const { data, error } = await supabase
    .from('portfolios')
    .insert({
      user_id: user.id,
      name: input.name,
      description: input.description || null,
      initial_capital: input.initial_capital || 100000,
      current_capital: input.initial_capital || 100000,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
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
  const upper = ticker.toUpperCase();
  const { data, error } = await supabase
    .from('instrument_prices')
    .select('current_price, last_updated')
    .eq('ticker', upper)
    .maybeSingle();
  if (error || !data) return null;
  const ageMs = Date.now() - new Date(data.last_updated).getTime();
  // 10-minute window: a bit more permissive than the 5-min display
  // TTL because the user might be about to execute and we want a
  // sensible fallback even if the price is mildly stale.
  if (ageMs > 10 * 60 * 1000) return null;
  return data.current_price ?? null;
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
