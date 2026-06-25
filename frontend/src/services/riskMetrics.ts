// Pure risk-analytics functions. No React, no Supabase.
// Lives next to db.ts so the db row types can be imported directly.
import { isTradingDay, type Portfolio, type Position, type Trade, type DailySnapshot } from '@/services/db';
import type { HistorySeries } from '@/services/marketHistory';

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

export interface SectorLS {
  sector: string;
  longUsd: number;
  shortUsd: number;       // positive number (display)
  netUsd: number;         // longUsd - shortUsd (signed)
  longPct: number;        // % of equity
  shortPct: number;
  netPct: number;
}

export interface ConcentrationMetrics {
  herfindahlLong: number;       // Σ (longWeight)^2, 0..1
  herfindahlShort: number;      // Σ (shortWeight)^2, 0..1
  top5GrossPct: number;         // sum of top 5 |value| / total gross
  largestSinglePct: number;     // biggest |value| / total gross
  longCount: number;
  shortCount: number;
}

export interface RiskMetrics {
  returnPct: number;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  winRate: number | null;
  maxDrawdownPct: number;
  currentDrawdownPct: number;   // signed, negative when underwater
  daysInDrawdown: number;
  var95Pct: number | null;
  cvar95Pct: number | null;
  leverageRatio: number | null;
  sectorExposure: SectorExposure[];
  sectorExposureLS: SectorLS[]; // sorted by |netPct| desc
  concentration: ConcentrationMetrics;
  totalTrades: number;
  closedTrades: number;
  dailyReturnCount: number;
  equity: number;
  grossExposure: number;
  netExposure: number;
  longExposure: number;
  shortExposure: number;        // negative number
  grossExposurePct: number;
  netExposurePct: number;
  longExposurePct: number;
  shortExposurePct: number;
  // T2.6 — populated when snapshots are non-empty
  peakEquity: number;
  peakEquityDate: string | null;
  recoveryDays: number | null;
  worstDayReturnPct: number | null;
  worstDayDate: string | null;
}

/**
 * Build a daily portfolio-return series from per-ticker market price
 * history and the portfolio's CURRENT position weights.
 *
 * This is the "market-derived" return series that drives the Risk
 * page's Sharpe / VaR / CVaR / Sortino when a non-empty `historySeries`
 * is supplied. The semantics are intentionally simple:
 *
 *   - Take today's position value per ticker (using live prices when
 *     available, falling back to `current_price` / `avg_price`).
 *   - For each historical trading day, revalue the same position at
 *     that day's close. The per-day portfolio value is
 *     `Σ (qty_i * close_i_day) + cash`, and the daily return is
 *     `(V_today - V_yesterday) / V_yesterday`.
 *
 * Important caveats (documented in the Risk page too):
 *   - We assume the user has held the current mix for the entire
 *     window. This is a standard industry simplification when the
 *     holding period is shorter than the analysis window — the
 *     resulting Sharpe/VaR describes the *risk of the current mix
 *     over this period*, not the realised path of the user's own
 *     positions.
 *   - Longs and shorts are both treated with `qty * close`; shorts
 *     contribute negative value, so a falling close improves the
 *     short's contribution. This is consistent with the rest of
 *     riskMetrics.ts.
 *   - Cash is held constant at `portfolio.current_capital`.
 *   - We skip any day where the denominator (yesterday's value) is
 *     0 or negative (would produce a meaningless return).
 *
 * @returns array of decimal returns (e.g. 0.0123 = +1.23%), one per
 *          day where the prior day's value was strictly positive.
 *          Empty if we don't have at least 2 days of usable data for
 *          at least one position.
 */
export function buildMarketPortfolioReturns(
  historySeries: HistorySeries[],
  positions: Position[],
  livePrices: LivePriceMap,
): number[] {
  if (!historySeries?.length || !positions?.length) return [];

  // Map each held ticker to its qty. Use today's live price only to
  // decide whether we have *any* usable price for the ticker (we
  // don't use it in the math — that's `close_i_day`).
  const qtyByTicker = new Map<string, number>();
  for (const p of positions) {
    if (!p.ticker) continue;
    qtyByTicker.set(p.ticker.toUpperCase(), p.qty);
  }
  if (qtyByTicker.size === 0) return [];

  // Build per-ticker date->close lookup (only for tickers we hold).
  const closesByTicker = new Map<string, Map<string, number>>();
  for (const s of historySeries) {
    const tk = s.ticker.toUpperCase();
    if (!qtyByTicker.has(tk)) continue;
    if (!s.points?.length) continue;
    const m = new Map<string, number>();
    for (const p of s.points) {
      if (!Number.isFinite(p.close) || p.close <= 0) continue;
      m.set(p.trade_date, p.close);
    }
    if (m.size > 0) closesByTicker.set(tk, m);
  }
  if (closesByTicker.size === 0) return [];

  // Union of all trading dates, sorted ascending. We can't just take
  // one ticker's dates because different assets have different
  // trading calendars (e.g. HK equities vs US).
  const allDates = new Set<string>();
  for (const m of closesByTicker.values()) {
    for (const d of m.keys()) allDates.add(d);
  }
  const sortedDates = Array.from(allDates).sort();
  if (sortedDates.length < 2) return [];

  // Cash anchor: keep cash constant at current_capital. The live
  // equity's net exposure is the value of positions (Σ qty_i * live_i),
  // but here we reconstruct value day-by-day from closes — adding cash
  // is the same as anchoring V_0 = positions_value(today) + cash.
  // We only need the *change* in portfolio value day over day, so
  // cash cancels out — we can ignore it. Portfolio value_t =
  //   Σ (qty_i * close_i_t).
  const values: number[] = [];
  for (const d of sortedDates) {
    let v = 0;
    for (const [tk, m] of closesByTicker.entries()) {
      const close = m.get(d);
      if (close == null) continue;
      const qty = qtyByTicker.get(tk) ?? 0;
      v += qty * close;
    }
    values.push(v);
  }

  // Daily returns from consecutive values. Skip the first date (no
  // prior value to compare to) and any day where the prior value is
  // <= 0 (avoids divide-by-zero / sign flips).
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const cur = values[i];
    if (prev == null || cur == null || !Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    if (prev <= 0 || !Number.isFinite(prev)) continue;
    returns.push((cur - prev) / prev);
  }
  return returns;
}

export function computeRiskMetrics(input: {
  portfolio: Portfolio;
  positions: Position[];
  trades: Trade[];
  snapshots: DailySnapshot[];
  livePrices: LivePriceMap;
  /**
   * Optional daily close history per held ticker, used to compute
   * Sharpe / VaR / CVaR / Sortino from market data rather than from
   * the portfolio's own snapshot series. When supplied, these metrics
   * are derived from the reconstructed portfolio return series below
   * (`buildMarketPortfolioReturns`).
   *
   * Snapshots are still used for max-drawdown / current-drawdown /
   * days-in-drawdown / peak-equity because those describe *this
   * portfolio's* path, not a hypothetical one. Mixing the two sources
   * is intentional: snapshot-derived for path-dependent stats,
   * market-derived for distribution stats.
   */
  historySeries?: HistorySeries[];
}): RiskMetrics {
  const { portfolio, positions, trades, snapshots: rawSnapshots, livePrices, historySeries } = input;
  // Drop weekend snapshot rows up front. The backfill writes a row
  // for every calendar day; weekends have no real price action and
  // would inflate the Sharpe window with zero-variance noise and
  // flatten the drawdown walk.
  const snapshots = rawSnapshots.filter((s) => isTradingDay(s.snapshot_date));

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
  const longExposure = positionValues.reduce(
    (sum, pv) => sum + Math.max(0, pv.value),
    0,
  );
  const shortExposure = positionValues.reduce(
    (sum, pv) => sum + Math.min(0, pv.value),
    0,
  );
  const equity = portfolio.current_capital + netExposure;
  const initialCapital = portfolio.initial_capital || 0;

  const returnPct =
    initialCapital > 0
      ? ((equity - initialCapital) / initialCapital) * 100
      : 0;

  const grossExposurePct = equity > 0 ? (grossExposure / equity) * 100 : 0;
  const netExposurePct = equity > 0 ? (netExposure / equity) * 100 : 0;
  const longExposurePct = equity > 0 ? (longExposure / equity) * 100 : 0;
  const shortExposurePct = equity > 0 ? (shortExposure / equity) * 100 : 0;

  // --- Sharpe / VaR / CVaR / Sortino inputs ---
  //
  // Prefer market-derived portfolio returns when `historySeries` is
  // available (this is the new behaviour: Sharpe/VaR/CVaR/Sortino come
  // from the portfolio's reconstructed market return series over a
  // multi-year price history, so they're available on day 1 of holding
  // rather than after months of accumulating snapshot rows).
  //
  // Fall back to snapshot-derived `daily_return` when historySeries is
  // empty / not supplied — preserves backwards compatibility for any
  // callers that don't yet fetch the market series.
  const marketReturns: number[] =
    historySeries && historySeries.length > 0
      ? buildMarketPortfolioReturns(historySeries, positions, livePrices)
      : [];

  const snapshotReturns = snapshots
    .map((s) => s.daily_return)
    .filter((r): r is number => r !== null && Number.isFinite(r));

  const useMarket = marketReturns.length >= 20; // need enough obs for VaR/CVaR guard anyway
  const dailyReturns = useMarket ? marketReturns : snapshotReturns;

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

  // --- Current drawdown + days in drawdown.
  // Walks snapshots forward; "now" uses the live equity. ---
  let runningPeak = initialCapital;
  let peakDate: string | null = null;
  for (const s of snapshots) {
    if (s.equity > runningPeak) {
      runningPeak = s.equity;
      peakDate = s.snapshot_date;
    }
  }
  // If live equity set a new high, "now" is the peak.
  if (equity > runningPeak) {
    runningPeak = equity;
    peakDate = null; // peak is "now", not a dated snapshot
  }
  const currentDrawdownPct = runningPeak > 0
    ? ((runningPeak - equity) / runningPeak) * -100 // negative when underwater
    : 0;
  // Days in drawdown: count of trading snapshots since peak (excluding the
  // peak itself) when we're currently underwater. 0 if at/above peak.
  let daysInDrawdown = 0;
  if (currentDrawdownPct < 0 && peakDate != null) {
    const peakIdx = snapshots.findIndex((s) => s.snapshot_date === peakDate);
    if (peakIdx >= 0) {
      daysInDrawdown = snapshots.length - peakIdx;
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

  // --- CVaR (95%): mean of the worst 5% of returns, returned as a
  //     POSITIVE loss magnitude. Same guard as VaR. ---
  let cvar95Pct: number | null = null;
  if (var95Pct != null && dailyReturnCount >= 20) {
    const sorted = [...dailyReturns].sort((a, b) => a - b);
    const cutoff = Math.max(1, Math.floor(sorted.length * 0.05));
    const tail = sorted.slice(0, cutoff);
    if (tail.length > 0) {
      const meanTail = tail.reduce((a, b) => a + b, 0) / tail.length;
      cvar95Pct = -meanTail * 100;
    }
  }

  // --- Sortino ratio (annualized). Like Sharpe, but the denominator is
  //     the downside deviation: sqrt(mean(min(0, r - rfr_daily)^2)). ---
  let sortinoRatio: number | null = null;
  if (dailyReturnCount >= 2) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturnCount;
    const rfrDaily = RISK_FREE_RATE / TRADING_DAYS_PER_YEAR;
    const downside = dailyReturns.reduce(
      (sum, r) => sum + Math.pow(Math.min(0, r - rfrDaily), 2),
      0,
    ) / dailyReturnCount;
    const downDev = Math.sqrt(downside);
    if (downDev > 0) {
      sortinoRatio =
        (mean * TRADING_DAYS_PER_YEAR - RISK_FREE_RATE) /
        (downDev * Math.sqrt(TRADING_DAYS_PER_YEAR));
    }
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

  // --- Sector L/S: bucket signed value per sector. ---
  const sectorLSMap = new Map<
    string,
    { longUsd: number; shortUsd: number; netUsd: number }
  >();
  for (const pv of positionValues) {
    const liveSector = livePrices[pv.position.ticker]?.sector ?? null;
    const sector = pv.position.sector ?? liveSector ?? 'Unknown';
    const entry = sectorLSMap.get(sector) ?? { longUsd: 0, shortUsd: 0, netUsd: 0 };
    if (pv.value >= 0) entry.longUsd += pv.value;
    else entry.shortUsd += Math.abs(pv.value);
    entry.netUsd = entry.longUsd - entry.shortUsd;
    sectorLSMap.set(sector, entry);
  }
  const sectorExposureLS: SectorLS[] = Array.from(sectorLSMap.entries())
    .map(([sector, v]) => {
      const longPct = equity > 0 ? (v.longUsd / equity) * 100 : 0;
      const shortPct = equity > 0 ? (v.shortUsd / equity) * 100 : 0;
      const netPct = equity > 0 ? (v.netUsd / equity) * 100 : 0;
      return { sector, longUsd: v.longUsd, shortUsd: v.shortUsd, netUsd: v.netUsd, longPct, shortPct, netPct };
    })
    .sort((a, b) => Math.abs(b.netPct) - Math.abs(a.netPct));

  // --- Concentration: Herfindahl on long + short sides, top-5, largest single. ---
  let herfindahlLong = 0;
  let herfindahlShort = 0;
  const grossAbsValues: number[] = [];
  let longCount = 0;
  let shortCount = 0;
  for (const pv of positionValues) {
    if (grossExposure > 0) {
      const w = pv.value / grossExposure;
      if (pv.value > 0) {
        herfindahlLong += w * w;
        longCount += 1;
      } else if (pv.value < 0) {
        const wShort = -w; // make positive
        herfindahlShort += wShort * wShort;
        shortCount += 1;
      }
    }
    grossAbsValues.push(Math.abs(pv.value));
  }
  grossAbsValues.sort((a, b) => b - a);
  const top5Sum = grossAbsValues.slice(0, 5).reduce((a, b) => a + b, 0);
  const top5GrossPct = grossExposure > 0 ? (top5Sum / grossExposure) * 100 : 0;
  const largestSinglePct = grossExposure > 0 ? ((grossAbsValues[0] ?? 0) / grossExposure) * 100 : 0;
  const concentration: ConcentrationMetrics = {
    herfindahlLong,
    herfindahlShort,
    top5GrossPct,
    largestSinglePct,
    longCount,
    shortCount,
  };

  // --- Leverage: gross / equity. ---
  const leverageRatio: number | null = equity > 0 ? grossExposure / equity : null;

  // --- T2.6: peak equity, recovery days, worst day. ---
  let peakEquity = initialCapital;
  let peakEquityDate: string | null = null;
  for (const s of snapshots) {
    if (s.equity > peakEquity) {
      peakEquity = s.equity;
      peakEquityDate = s.snapshot_date;
    }
  }
  // If live equity set a new high, the peak is "now" (no dated recovery).
  if (equity > peakEquity) {
    peakEquity = equity;
    peakEquityDate = null;
  }
  // Recovery days: from peak back to current equity. If already recovered
  // (equity >= peak), the peak must be from a snapshot — count snapshots
  // between peak date and "now". If still underwater, null.
  let recoveryDays: number | null = null;
  if (peakEquityDate != null && equity >= peakEquity) {
    const peakIdx = snapshots.findIndex((s) => s.snapshot_date === peakEquityDate);
    if (peakIdx >= 0) {
      recoveryDays = snapshots.length - peakIdx;
    }
  }
  // Worst single-day return
  let worstDayReturnPct: number | null = null;
  let worstDayDate: string | null = null;
  for (const s of snapshots) {
    if (s.daily_return == null || !Number.isFinite(s.daily_return)) continue;
    if (worstDayReturnPct == null || s.daily_return < worstDayReturnPct) {
      worstDayReturnPct = s.daily_return;
      worstDayDate = s.snapshot_date;
    }
  }

  return {
    returnPct,
    sharpeRatio,
    sortinoRatio,
    winRate,
    maxDrawdownPct,
    currentDrawdownPct,
    daysInDrawdown,
    var95Pct,
    cvar95Pct,
    leverageRatio,
    sectorExposure,
    sectorExposureLS,
    concentration,
    totalTrades: trades.length,
    closedTrades: closedTrades.length,
    dailyReturnCount,
    equity,
    grossExposure,
    netExposure,
    longExposure,
    shortExposure,
    grossExposurePct,
    netExposurePct,
    longExposurePct,
    shortExposurePct,
    peakEquity,
    peakEquityDate,
    recoveryDays,
    worstDayReturnPct,
    worstDayDate,
  };
}