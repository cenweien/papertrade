// Pure risk-analytics functions. No React, no Supabase.
// Lives next to db.ts so the db row types can be imported directly.
import type { Portfolio, Position, Trade, DailySnapshot } from '@/services/db';

export const RISK_FREE_RATE = 0.05; // annualized, ~5y US Treasury; configurable later
export const TRADING_DAYS_PER_YEAR = 252;

export interface LivePriceMap {
  [ticker: string]: { current_price: number; sector?: string | null };
}

export interface SectorExposure {
  sector: string;
  pct: number;
  valueUsd: number;
}

export interface RiskMetrics {
  returnPct: number;
  sharpeRatio: number | null;
  winRate: number | null;
  maxDrawdownPct: number;
  var95Pct: number | null;
  leverageRatio: number | null;
  sectorExposure: SectorExposure[];
  totalTrades: number;
  closedTrades: number;
  dailyReturnCount: number;
  equity: number;
  grossExposure: number;
}

export function computeRiskMetrics(input: {
  portfolio: Portfolio;
  positions: Position[];
  trades: Trade[];
  snapshots: DailySnapshot[];
  livePrices: LivePriceMap;
}): RiskMetrics {
  const { portfolio, positions, trades, snapshots, livePrices } = input;

  // --- Position valuation: live -> stored current_price -> avg_price ---
  const positionValues = positions.map((p) => {
    const live = livePrices[p.ticker]?.current_price;
    const px = live ?? p.current_price ?? p.avg_price;
    return { position: p, price: px, value: p.qty * px };
  });

  const grossExposure = positionValues.reduce(
    (sum, pv) => sum + Math.abs(pv.value),
    0,
  );
  const netExposure = positionValues.reduce((sum, pv) => sum + pv.value, 0);
  const equity = portfolio.current_capital + netExposure;
  const initialCapital = portfolio.initial_capital || 0;

  const returnPct =
    initialCapital > 0
      ? ((equity - initialCapital) / initialCapital) * 100
      : 0;

  // --- Sharpe ratio (annualized) ---
  const dailyReturns = snapshots
    .map((s) => s.daily_return)
    .filter((r): r is number => r !== null && Number.isFinite(r));

  const dailyReturnCount = dailyReturns.length;
  let sharpeRatio: number | null = null;
  if (dailyReturnCount >= 2) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturnCount;
    const variance =
      dailyReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) /
      (dailyReturnCount - 1);
    const stdDev = Math.sqrt(variance);
    if (stdDev > 0) {
      sharpeRatio =
        (mean * TRADING_DAYS_PER_YEAR - RISK_FREE_RATE) /
        (stdDev * Math.sqrt(TRADING_DAYS_PER_YEAR));
    }
  }

  // --- Win rate (CLOSED trades only, pnl > 0 = win) ---
  const closedTrades = trades.filter(
    (t) => t.status === 'CLOSED' && t.pnl !== null,
  );
  const winningTrades = closedTrades.filter((t) => (t.pnl ?? 0) > 0);
  const winRate: number | null =
    closedTrades.length > 0
      ? (winningTrades.length / closedTrades.length) * 100
      : null;

  // --- Max drawdown: positive % of the largest peak-to-trough decline.
  // Seed the peak with initial_capital so day-1 snapshots count. ---
  let maxDrawdownPct = 0;
  let peak = initialCapital;
  for (const s of snapshots) {
    if (s.equity > peak) peak = s.equity;
    if (peak > 0) {
      const dd = ((peak - s.equity) / peak) * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  // --- Historical VaR (95%): 5th percentile of daily returns, returned
  //     as a POSITIVE percentage (the loss magnitude). Need >= 20 obs. ---
  let var95Pct: number | null = null;
  if (dailyReturnCount >= 20) {
    const sorted = [...dailyReturns].sort((a, b) => a - b);
    const idx = Math.max(0, Math.floor(sorted.length * 0.05) - 1);
    const loss = sorted[idx] ?? 0;
    var95Pct = -loss * 100; // turn a negative return into a positive loss magnitude
  }

  // --- Sector exposure: group position |value| by sector; fall back
  //     to livePrices sector, then "Unknown". ---
  const sectorMap = new Map<string, number>();
  for (const pv of positionValues) {
    const liveSector = livePrices[pv.position.ticker]?.sector ?? null;
    const sector = pv.position.sector ?? liveSector ?? 'Unknown';
    sectorMap.set(sector, (sectorMap.get(sector) ?? 0) + Math.abs(pv.value));
  }
  const sectorExposure: SectorExposure[] = Array.from(sectorMap.entries())
    .map(([sector, valueUsd]) => ({
      sector,
      valueUsd,
      pct: equity > 0 ? (valueUsd / equity) * 100 : 0,
    }))
    .sort((a, b) => b.valueUsd - a.valueUsd);

  // --- Leverage: gross / equity. ---
  const leverageRatio: number | null = equity > 0 ? grossExposure / equity : null;

  return {
    returnPct,
    sharpeRatio,
    winRate,
    maxDrawdownPct,
    var95Pct,
    leverageRatio,
    sectorExposure,
    totalTrades: trades.length,
    closedTrades: closedTrades.length,
    dailyReturnCount,
    equity,
    grossExposure,
  };
}