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

export async function executeTrade(input: {
  portfolio_id: string;
  ticker: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  stop_price?: number;
  notes?: string;
}): Promise<Trade> {
  const ticker = input.ticker.toUpperCase();
  const totalCost = input.qty * input.price;

  // 1. Get portfolio
  const { data: portfolio, error: pErr } = await supabase
    .from('portfolios')
    .select('*')
    .eq('id', input.portfolio_id)
    .single();
  if (pErr || !portfolio) throw new Error('Portfolio not found');

  // 2. Validate cash for BUY
  if (input.side === 'BUY' && portfolio.current_capital < totalCost) {
    throw new Error(
      `Insufficient cash. Need $${totalCost.toFixed(2)}, have $${portfolio.current_capital.toFixed(2)}`
    );
  }

  // 3. Validate position for SELL
  if (input.side === 'SELL') {
    const { data: pos } = await supabase
      .from('positions')
      .select('*')
      .eq('portfolio_id', input.portfolio_id)
      .eq('ticker', ticker)
      .single();

    if (!pos || pos.qty < input.qty) {
      throw new Error(
        `Insufficient shares. Need ${input.qty}, have ${pos?.qty || 0}`
      );
    }
  }

  // 4. Insert trade
  const { data: trade, error: tErr } = await supabase
    .from('trades')
    .insert({
      portfolio_id: input.portfolio_id,
      ticker,
      side: input.side,
      qty: input.qty,
      price: input.price,
      stop_price: input.stop_price || null,
      notes: input.notes || null,
    })
    .select()
    .single();
  if (tErr) throw tErr;

  // 5. Update portfolio cash
  const cashDelta = input.side === 'BUY' ? -totalCost : totalCost;
  await supabase
    .from('portfolios')
    .update({ current_capital: portfolio.current_capital + cashDelta })
    .eq('id', input.portfolio_id);

  // 6. Update position
  await updatePositionAfterTrade(input.portfolio_id, ticker, input.side, input.qty, input.price);

  return trade;
}

async function updatePositionAfterTrade(
  portfolioId: string,
  ticker: string,
  side: 'BUY' | 'SELL',
  qty: number,
  price: number
): Promise<void> {
  const { data: existing } = await supabase
    .from('positions')
    .select('*')
    .eq('portfolio_id', portfolioId)
    .eq('ticker', ticker)
    .single();

  if (side === 'BUY') {
    if (existing) {
      const newQty = existing.qty + qty;
      const newAvgPrice = (existing.qty * existing.avg_price + qty * price) / newQty;
      await supabase
        .from('positions')
        .update({ qty: newQty, avg_price: newAvgPrice })
        .eq('id', existing.id);
    } else {
      await supabase
        .from('positions')
        .insert({ portfolio_id: portfolioId, ticker, qty, avg_price: price });
    }
  } else {
    if (existing) {
      const newQty = existing.qty - qty;
      if (newQty <= 0) {
        await supabase.from('positions').delete().eq('id', existing.id);
      } else {
        await supabase.from('positions').update({ qty: newQty }).eq('id', existing.id);
      }
    }
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