// RiskPage - risk analytics for a single portfolio
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  ReferenceLine,
  Line,
  ComposedChart,
} from 'recharts';
import {
  TrendingUp,
  TrendingDown,
  ArrowLeft,
  ShieldAlert,
  RefreshCw,
  Wifi,
  WifiOff,
  CheckCircle2,
  AlertTriangle,
  XCircle,
} from 'lucide-react';
import {
  getPortfolios,
  getPortfolio,
  getPositions,
  getTrades,
  getSnapshots,
  fillSnapshotGap,
  recomputeSnapshots,
  isTradingDay,
  type Portfolio,
  type Position,
  type Trade,
  type DailySnapshot,
} from '@/services/db';
import { useLivePrices } from '@/services/marketData';
import {
  getHistorySeriesLastDays,
  type HistorySeries,
} from '@/services/marketHistory';
import { PortfolioEquityChart } from '@/components/PnLCharts';
import {
  computeRiskMetrics,
  type RiskMetrics,
  type LivePriceMap,
  type SectorLS,
} from '@/services/riskMetrics';

interface DataState {
  portfolio: Portfolio | null;
  positions: Position[];
  trades: Trade[];
  snapshots: DailySnapshot[];
  /**
   * Daily close history per held ticker over the lookback window
   * (default 1y). Powers the market-derived Sharpe / VaR / CVaR /
   * Sortino. Empty array if the fetch failed or there are no
   * positions; riskMetrics then falls back to the snapshot-derived
   * series so the Risk page still renders.
   */
  historySeries: HistorySeries[];
}

// Lookback window for the market-derived return series. 1y gives a
// stable Sharpe/CVaR estimate and matches the cache horizon the
// bloomberg-service scheduler keeps warm.
const HISTORY_LOOKBACK_DAYS = 365;

const fmtPct = (n: number, digits = 2) =>
  `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
const fmtMoney = (n: number) =>
  `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

// --- Risk limit thresholds for the T2.7 traffic lights. ---
// TODO: move to per-portfolio settings (Tier 3).
const LIMITS = {
  netAbsPct: 30,      // |netExposure%| below = green; >50% = red
  grossPct: 180,      // gross% below = green; >220% = red
  largestSinglePct: 10, // below = green; >15% = red
  effN: 20,           // 1/(HHI_long+HHI_short) above = green; below 10 = red
  ddAbsPct: 5,        // |currentDrawdown%| below = green; >10% = red
  var95Pct: 2,        // VaR below = green; >3% = red
};

type LightColor = 'green' | 'yellow' | 'red';

export function RiskPage() {
  const { portfolioId } = useParams<{ portfolioId: string }>();
  const navigate = useNavigate();

  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [activeId, setActiveId] = useState<string | null>(portfolioId ?? null);
  const [data, setData] = useState<DataState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null);

  // ---- Portfolio selector bootstrap ----
  useEffect(() => {
    (async () => {
      try {
        const list = await getPortfolios();
        setPortfolios(list);
        if (!activeId && list.length > 0) {
          setActiveId(list[0].id);
        }
      } catch (err) {
        console.error('Failed to load portfolios:', err);
        setError('Failed to load portfolios.');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Load the selected portfolio's data ----
  const reloadData = async (id: string) => {
    const [portfolio, positions, trades, allSnapshots] = await Promise.all([
      getPortfolio(id),
      getPositions(id),
      getTrades(id, 500),
      getSnapshots(id, 365),
    ]);
    if (!portfolio) {
      setError('Portfolio not found.');
      setData(null);
      return;
    }
// Silently heal any gap in `daily_snapshots` between the latest
    // existing row and the most recent trading day (merged from
    // HEAD's pre-merge commit). Runs BEFORE the weekend filter so
    // any freshly-written backfill rows are also filtered.
    try {
      await fillSnapshotGap(id);
    } catch (err) {
      console.warn('fillSnapshotGap failed (non-fatal):', err);
    }
    // Re-read snapshots so any rows written by fillSnapshotGap are
    // included. Then filter out weekend / holiday rows — the
    // backfill writes a row for every calendar day; weekends have
    // no real price action and inflate the Sharpe window with
    // zero-variance noise (merged from fix/weekend-filter-and-backfill-mark).
    let latestSnapshots: DailySnapshot[] = allSnapshots;
    try {
      latestSnapshots = await getSnapshots(id, 365);
    } catch (err) {
      console.warn('snapshot re-read after gap-fill failed (non-fatal):', err);
    }
    const snapshots = latestSnapshots.filter((s) => isTradingDay(s.snapshot_date));
    // Market-derived history series. Fetched AFTER the core data so
    // the page can render positions/trades immediately even if the
    // Bloomberg backfill is slow. A failure here is non-fatal —
    // riskMetrics falls back to the snapshot series.
    let historySeries: HistorySeries[] = [];
    const heldTickers = positions
      .map((p) => p.ticker?.toUpperCase())
      .filter(Boolean) as string[];
    if (heldTickers.length > 0) {
      try {
        historySeries = await getHistorySeriesLastDays(heldTickers, HISTORY_LOOKBACK_DAYS);
      } catch (err) {
        console.warn('history-series fetch failed; falling back to snapshots:', err);
      }
    }
    setData({ portfolio, positions, trades, snapshots: latestSnapshots, historySeries });
  };

  useEffect(() => {
    if (!activeId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    (async () => {
      try {
        await reloadData(activeId);
      } catch (err) {
        console.error('Failed to load risk data:', err);
        setError('Failed to load risk data.');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ---- Live prices for the positions of the selected portfolio ----
  const positionTickers = useMemo(
    () => (data?.positions ?? []).map((p) => p.ticker).filter(Boolean),
    [data?.positions],
  );
  const { quotes, refreshing, lastUpdated } = useLivePrices(
    positionTickers,
    60_000,
  );

  const metrics: RiskMetrics | null = useMemo(() => {
    if (!data || !data.portfolio) return null;
    const livePrices: LivePriceMap = {};
    for (const [tk, q] of Object.entries(quotes)) {
      livePrices[tk] = { current_price: q.current_price, sector: q.sector };
    }
    return computeRiskMetrics({
      portfolio: data.portfolio,
      positions: data.positions,
      trades: data.trades,
      snapshots: data.snapshots,
      livePrices,
      historySeries: data.historySeries,
    });
  }, [data, quotes]);

  // ---- Underwater (drawdown) chart data ----
  const drawdownSeries = useMemo(() => {
    if (!data || !data.snapshots.length) return [];
    const peak = data.portfolio?.initial_capital ?? 0;
    let runningPeak = peak;
    return data.snapshots.map((s) => {
      if (s.equity > runningPeak) runningPeak = s.equity;
      const dd = runningPeak > 0 ? ((runningPeak - s.equity) / runningPeak) * 100 : 0;
      return {
        date: s.snapshot_date,
        drawdown: -dd, // negative for "underwater" chart
      };
    });
  }, [data]);

  // ---- Returns distribution histogram ----
  const histogram = useMemo(() => {
    if (!data) return [];
    const rets = data.snapshots
      .map((s) => s.daily_return)
      .filter((r): r is number => r !== null && Number.isFinite(r));
    if (rets.length === 0) return [];
    const min = Math.min(...rets);
    const max = Math.max(...rets);
    const bucketCount = Math.min(20, Math.max(5, Math.floor(Math.sqrt(rets.length))));
    const span = max - min || 1;
    const step = span / bucketCount;
    const bins = Array.from({ length: bucketCount }, (_, i) => ({
      binStart: min + i * step,
      binMid: min + i * step + step / 2,
      count: 0,
    }));
    for (const r of rets) {
      let idx = Math.floor((r - min) / step);
      if (idx >= bucketCount) idx = bucketCount - 1;
      if (idx < 0) idx = 0;
      bins[idx].count += 1;
    }
    return bins;
  }, [data]);

  // ---- T2.4: L/S/Net/Gross stacked area chart series ----
  const lsAreaSeries = useMemo(() => {
    if (!data || !data.snapshots.length) return [];
    return data.snapshots.map((s) => {
      const longVal = (s as any).long_value ?? 0;
      const shortVal = (s as any).short_value ?? 0; // negative
      const netVal = (s as any).net_value ?? (longVal + shortVal);
      // For the stacked area we need the short bucket plotted as
      // a positive magnitude below the zero axis.
      return {
        date: s.snapshot_date,
        longVal,
        shortAbsVal: Math.abs(shortVal),
        netVal,
        grossVal: longVal + Math.abs(shortVal),
      };
    });
  }, [data]);

  // ---- T1.3: Sector L/S chart data (filter 'Unknown' from the bar) ----
  const sectorBarData = useMemo(() => {
    if (!metrics) return [];
    return metrics.sectorExposureLS
      .filter((s) => s.sector !== 'Unknown')
      .map((s) => ({
        sector: s.sector,
        longPct: s.longPct,
        shortPct: -s.shortPct, // negative so bars sit below zero
        netPct: s.netPct,
      }));
  }, [metrics]);

  const handleSelect = (id: string) => {
    setActiveId(id);
    navigate(`/risk/${id}`);
  };

  const handleRecompute = async () => {
    if (!activeId || recomputing) return;
    setRecomputing(true);
    setRecomputeMsg(null);
    const result = await recomputeSnapshots(activeId);
    setRecomputing(false);
    if (result.ok) {
      setRecomputeMsg('Snapshots refreshed.');
      // Reload data to pick up the new rows.
      try {
        await reloadData(activeId);
      } catch (err) {
        console.error('Reload after recompute failed:', err);
      }
    } else {
      setRecomputeMsg(`Recompute failed: ${result.error ?? 'unknown'}`);
    }
  };

  if (loading && !data) {
    return <div className="p-8 text-slate-600">Loading...</div>;
  }

  if (!data || !data.portfolio || !metrics) {
    return (
      <div className="p-8">
        <Link to="/" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </Link>
        <div className="card">
          <ShieldAlert className="mb-2 h-8 w-8 text-slate-400" />
          <h2 className="text-lg font-semibold">No data yet</h2>
          <p className="mt-1 text-sm text-slate-600">
            {error ?? 'Select a portfolio and let daily snapshots populate.'}
          </p>
        </div>
      </div>
    );
  }

  const hasLiveData = Object.keys(quotes).length > 0;
  const totalSnapshots = data.snapshots.length;

  // --- T2.7 traffic-light evaluations ---
  const netAbs = Math.abs(metrics.netExposurePct);
  const grossPctVal = metrics.grossExposurePct;
  const largestSingle = metrics.concentration.largestSinglePct;
  const hhiSum = metrics.concentration.herfindahlLong + metrics.concentration.herfindahlShort;
  const effN = hhiSum > 0 ? 1 / hhiSum : Infinity;
  const ddAbs = Math.abs(metrics.currentDrawdownPct);
  const var95Val = metrics.var95Pct ?? 0;

  const lights: { label: string; value: string; color: LightColor; hint: string }[] = [
    {
      label: 'Net Exposure',
      value: fmtPct(metrics.netExposurePct),
      color:
        netAbs < LIMITS.netAbsPct ? 'green'
        : netAbs < LIMITS.netAbsPct * (50 / 30) ? 'yellow'
        : 'red',
      hint: `±${LIMITS.netAbsPct}% green · ±${Math.round(LIMITS.netAbsPct * (50 / 30))}% red`,
    },
    {
      label: 'Gross Exposure',
      value: fmtPct(grossPctVal),
      color:
        grossPctVal < LIMITS.grossPct ? 'green'
        : grossPctVal < LIMITS.grossPct * (220 / 180) ? 'yellow'
        : 'red',
      hint: `<${LIMITS.grossPct}% green · >${Math.round(LIMITS.grossPct * (220 / 180))}% red`,
    },
    {
      label: 'Single Name',
      value: `${largestSingle.toFixed(1)}%`,
      color:
        largestSingle < LIMITS.largestSinglePct ? 'green'
        : largestSingle < LIMITS.largestSinglePct * (15 / 10) ? 'yellow'
        : 'red',
      hint: `<${LIMITS.largestSinglePct}% green · >${LIMITS.largestSinglePct * (15 / 10)}% red`,
    },
    {
      label: 'Concentration',
      value: hhiSum > 0 ? `${effN.toFixed(1)}×` : '∞',
      color:
        effN > LIMITS.effN ? 'green'
        : effN > LIMITS.effN / 2 ? 'yellow'
        : 'red',
      hint: `eff. N > ${LIMITS.effN} green · <${LIMITS.effN / 2} red`,
    },
    {
      label: 'Drawdown',
      value: fmtPct(metrics.currentDrawdownPct),
      color:
        ddAbs < LIMITS.ddAbsPct ? 'green'
        : ddAbs < LIMITS.ddAbsPct * (10 / 5) ? 'yellow'
        : 'red',
      hint: `|DD| < ${LIMITS.ddAbsPct}% green · >${LIMITS.ddAbsPct * (10 / 5)}% red`,
    },
    {
      label: 'VaR (95%)',
      value: metrics.var95Pct == null ? 'N/A' : `${metrics.var95Pct.toFixed(2)}%`,
      color:
        metrics.var95Pct == null ? 'green'
        : var95Val < LIMITS.var95Pct ? 'green'
        : var95Val < LIMITS.var95Pct * (3 / 2) ? 'yellow'
        : 'red',
      hint: `<${LIMITS.var95Pct}% green · >${LIMITS.var95Pct * (3 / 2)}% red`,
    },
  ];

  return (
    <div className="mx-auto max-w-7xl p-8">
      <Link to="/" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" />
        Back to dashboard
      </Link>

      {/* Header + portfolio selector */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold text-slate-900">
            <ShieldAlert className="h-7 w-7 text-primary-600" />
            Risk Analytics
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {data.portfolio.name} · Equity {fmtMoney(metrics.equity)}
          </p>
        </div>
        <div className="min-w-[260px]">
          <label className="label" htmlFor="portfolio-select">Portfolio</label>
          <select
            id="portfolio-select"
            value={activeId ?? ''}
            onChange={(e) => handleSelect(e.target.value)}
            className="input mt-1"
          >
            {portfolios.length === 0 ? (
              <option value="">No portfolios</option>
            ) : (
              portfolios.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))
            )}
          </select>
        </div>
      </div>

      {hasLiveData && (
        <div className="mb-4 flex items-center gap-2 text-xs text-slate-500">
          {refreshing ? (
            <>
              <RefreshCw className="h-3 w-3 animate-spin" />
              <span>Refreshing prices…</span>
            </>
          ) : lastUpdated ? (
            <>
              <Wifi className="h-3 w-3 text-green-500" />
              <span>
                Live prices from Finnhub · last updated {lastUpdated.toLocaleTimeString()}
              </span>
            </>
          ) : (
            <>
              <WifiOff className="h-3 w-3 text-slate-400" />
              <span>Using cached or stored prices</span>
            </>
          )}
        </div>
      )}

      {/* T2.7: Limit-breach traffic lights */}
      <div className="card mb-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Limit Breaches
          </h2>
          <button
            onClick={handleRecompute}
            disabled={recomputing}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 disabled:opacity-50"
            title="Force recompute of daily_snapshots for this portfolio"
          >
            <RefreshCw className={`h-3 w-3 ${recomputing ? 'animate-spin' : ''}`} />
            {recomputing ? 'Refreshing…' : 'Recompute snapshots'}
          </button>
        </div>
        {recomputeMsg && (
          <p className="mb-2 text-xs text-slate-500">{recomputeMsg}</p>
        )}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {lights.map((l) => (
            <TrafficLight key={l.label} {...l} />
          ))}
        </div>
      </div>

      {/* T1.2: 8-tile metric row (2x4 on lg) */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Return"
          value={fmtPct(metrics.returnPct)}
          tone={metrics.returnPct >= 0 ? 'positive' : 'negative'}
          icon={metrics.returnPct >= 0 ? TrendingUp : TrendingDown}
          subtitle={`Since inception · initial ${fmtMoney(data.portfolio.initial_capital)}`}
        />

        <MetricCard
          label="Net Exposure"
          value={fmtPct(metrics.netExposurePct)}
          tone={
            Math.abs(metrics.netExposurePct) < 10
              ? 'neutral'
              : metrics.netExposurePct > 0
                ? 'positive'
                : 'negative'
          }
          subtitle={`Net ${fmtMoney(metrics.netExposure)}`}
        />

        <MetricCard
          label="Gross Exposure"
          value={fmtPct(metrics.grossExposurePct)}
          tone={
            metrics.grossExposurePct > 220
              ? 'negative'
              : metrics.grossExposurePct > 180
                ? 'warning'
                : 'neutral'
          }
          subtitle={`Gross ${fmtMoney(metrics.grossExposure)}`}
        />

        <MetricCard
          label="Long $"
          value={fmtPct(metrics.longExposurePct)}
          tone="positive"
          subtitle={fmtMoney(metrics.longExposure)}
        />

        <MetricCard
          label="Short $"
          value={fmtPct(metrics.shortExposurePct)}
          tone="negative"
          subtitle={fmtMoney(metrics.shortExposure)}
        />

        <MetricCard
          label="Sharpe Ratio"
          value={metrics.sharpeRatio == null ? 'N/A' : metrics.sharpeRatio.toFixed(2)}
          tone="neutral"
          subtitle={
            metrics.sharpeRatio == null
              ? 'N/A (need ≥2 daily returns)'
              : 'Annualized · rfr = 5%'
          }
        />

        <MetricCard
          label="Sortino"
          value={metrics.sortinoRatio == null ? 'N/A' : metrics.sortinoRatio.toFixed(2)}
          tone={
            metrics.sortinoRatio == null
              ? 'neutral'
              : metrics.sortinoRatio >= 1.5
                ? 'positive'
                : metrics.sortinoRatio >= 0.5
                  ? 'neutral'
                  : metrics.sortinoRatio < 0
                    ? 'negative'
                    : 'neutral'
          }
          subtitle={
            metrics.sortinoRatio == null
              ? 'N/A (need ≥2 daily returns)'
              : 'Downside-vol Sharpe'
          }
        />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">

        <MetricCard
          label="Max DD / Current"
          value={`${fmtPct(-metrics.maxDrawdownPct)} / ${fmtPct(metrics.currentDrawdownPct)}`}
          tone="negative"
          subtitle={`${metrics.daysInDrawdown}d in DD · ${totalSnapshots} snapshot${totalSnapshots === 1 ? '' : 's'}`}
        />
      </div>

      {/* T1.5: Tail risk card (VaR + CVaR + Leverage) */}
      <div className="card mb-6">
        <h2 className="mb-4 text-lg font-semibold">Tail Risk</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <div className="text-xs uppercase text-slate-500">VaR 95% (daily loss)</div>
            <div className="mt-1 text-2xl font-bold text-red-600">
              {metrics.var95Pct == null ? 'N/A' : `${metrics.var95Pct.toFixed(2)}%`}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {metrics.var95Pct == null
                ? 'N/A — need ≥20 daily returns'
                : 'Historical · 5th percentile'}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-slate-500">CVaR 95% (expected shortfall)</div>
            <div className={`mt-1 text-2xl font-bold ${
              metrics.cvar95Pct == null
                ? 'text-slate-900'
                : metrics.cvar95Pct > 3
                  ? 'text-red-600'
                  : metrics.cvar95Pct > 2
                    ? 'text-yellow-600'
                    : 'text-slate-900'
            }`}>
              {metrics.cvar95Pct == null ? 'N/A' : `${metrics.cvar95Pct.toFixed(2)}%`}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {metrics.cvar95Pct == null
                ? 'N/A — need ≥20 daily returns'
                : 'Mean of worst 5% of days'}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-slate-500">Leverage</div>
            <div className={`mt-1 text-2xl font-bold ${
              metrics.leverageRatio == null
                ? 'text-slate-900'
                : metrics.leverageRatio > 2
                  ? 'text-red-600'
                  : metrics.leverageRatio > 1.5
                    ? 'text-yellow-600'
                    : 'text-slate-900'
            }`}>
              {metrics.leverageRatio == null ? 'N/A' : `${metrics.leverageRatio.toFixed(2)}×`}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {metrics.leverageRatio == null
                ? 'N/A (non-positive equity)'
                : `Gross ${fmtMoney(metrics.grossExposure)}`}
            </div>
          </div>
        </div>
      </div>

      {/* Portfolio equity curve */}
      <div className="card mb-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Portfolio Equity</h2>
          <span className="text-xs text-slate-500">
            {totalSnapshots} snapshot{totalSnapshots === 1 ? '' : 's'}
          </span>
        </div>
        <PortfolioEquityChart
          snapshots={data.snapshots}
          initialCapital={data.portfolio.initial_capital}
          sharpeRatio={metrics?.sharpeRatio ?? null}
        />
      </div>

      {/* T2.4: L/S/Net/Gross stacked area chart */}
      <div className="card mb-6">
        <h2 className="mb-4 text-lg font-semibold">Long / Short Exposure Over Time</h2>
        {lsAreaSeries.length < 2 ? (
          <div className="text-sm text-slate-500">
            {totalSnapshots === 0 && data.trades.length === 0
              ? 'No trade history yet.'
              : 'Need at least 2 daily snapshots with L/S data.'}
            {totalSnapshots === 0 && data.trades.length > 0 && (
              <div className="mt-2">
                <button
                  onClick={handleRecompute}
                  disabled={recomputing}
                  className="btn-secondary"
                >
                  {recomputing ? 'Refreshing…' : 'Recompute snapshots'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={lsAreaSeries}>
                <defs>
                  <linearGradient id="longFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.7} />
                    <stop offset="100%" stopColor="#10b981" stopOpacity={0.15} />
                  </linearGradient>
                  <linearGradient id="shortFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ef4444" stopOpacity={0.15} />
                    <stop offset="100%" stopColor="#ef4444" stopOpacity={0.7} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <YAxis
                  tick={{ fontSize: 11 }}
                  stroke="#94a3b8"
                  tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
                />
                <Tooltip
                  formatter={(v: number, name: string) => {
                    const labels: Record<string, string> = {
                      longVal: 'Long $',
                      shortAbsVal: '|Short| $',
                      netVal: 'Net $',
                      grossVal: 'Gross $',
                    };
                    return [fmtMoney(v), labels[name] ?? name];
                  }}
                  labelFormatter={(l: string) => `Date: ${l}`}
                />
                <ReferenceLine y={0} stroke="#94a3b8" />
                <Area
                  type="monotone"
                  dataKey="longVal"
                  stackId="ls"
                  stroke="#059669"
                  fill="url(#longFill)"
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="shortAbsVal"
                  stackId="ls"
                  stroke="#b91c1c"
                  fill="url(#shortFill)"
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="netVal"
                  stroke="#2563eb"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="grossVal"
                  stroke="#8b5cf6"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  dot={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
            <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-slate-500">
              <LegendDot color="#10b981" label="Long $" />
              <LegendDot color="#ef4444" label="|Short| $" />
              <LegendDot color="#2563eb" label="Net $" />
              <LegendDot color="#8b5cf6" label="Gross $" dashed />
            </div>
          </div>
        )}
      </div>

      {/* Underwater chart */}
      <div className="card mb-6">
        <h2 className="mb-4 text-lg font-semibold">Underwater (Drawdown)</h2>
        {drawdownSeries.length < 2 ? (
          <p className="text-sm text-slate-500">
            Need at least 2 daily snapshots to plot drawdown.
          </p>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={drawdownSeries}>
                <defs>
                  <linearGradient id="ddFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ef4444" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#ef4444" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <YAxis
                  tick={{ fontSize: 11 }}
                  stroke="#94a3b8"
                  tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                />
                <Tooltip
                  formatter={(v: number) => [`${v.toFixed(2)}%`, 'Drawdown']}
                  labelFormatter={(l: string) => `Date: ${l}`}
                />
                <Area
                  type="monotone"
                  dataKey="drawdown"
                  stroke="#dc2626"
                  fill="url(#ddFill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* T1.3: Sector L/S grouped bar + table */}
      <div className="card mb-6">
        <h2 className="mb-4 text-lg font-semibold">Sector Exposure (Long / Short)</h2>
        {metrics.sectorExposureLS.length === 0 ? (
          <p className="text-sm text-slate-500">No open positions.</p>
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={sectorBarData}
                  layout="vertical"
                  margin={{ left: 16, right: 16, top: 8, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11 }}
                    stroke="#94a3b8"
                    tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                  />
                  <YAxis
                    dataKey="sector"
                    type="category"
                    tick={{ fontSize: 11 }}
                    stroke="#94a3b8"
                    width={90}
                  />
                  <Tooltip
                    formatter={(v: number, name: string) => {
                      const labels: Record<string, string> = {
                        longPct: 'Long %',
                        shortPct: 'Short %',
                      };
                      return [`${v.toFixed(2)}%`, labels[name] ?? name];
                    }}
                  />
                  <ReferenceLine x={0} stroke="#94a3b8" />
                  <Bar dataKey="longPct" fill="#10b981" stackId="ls" isAnimationActive={false} />
                  <Bar dataKey="shortPct" fill="#ef4444" stackId="ls" isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                    <th className="py-2">Sector</th>
                    <th className="py-2 text-right">Long $</th>
                    <th className="py-2 text-right">Long %</th>
                    <th className="py-2 text-right">Short $</th>
                    <th className="py-2 text-right">Short %</th>
                    <th className="py-2 text-right">Net $</th>
                    <th className="py-2 text-right">Net %</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.sectorExposureLS.map((s: SectorLS) => (
                    <tr key={s.sector} className="border-b border-slate-100">
                      <td className="py-2 font-medium">{s.sector}</td>
                      <td className="py-2 text-right text-green-700">{fmtMoney(s.longUsd)}</td>
                      <td className="py-2 text-right text-green-700">{s.longPct.toFixed(1)}%</td>
                      <td className="py-2 text-right text-red-700">{fmtMoney(-s.shortUsd)}</td>
                      <td className="py-2 text-right text-red-700">{s.shortPct.toFixed(1)}%</td>
                      <td className={`py-2 text-right ${s.netUsd >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                        {fmtMoney(s.netUsd)}
                      </td>
                      <td className={`py-2 text-right ${s.netPct >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                        {s.netPct >= 0 ? '+' : ''}{s.netPct.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {metrics.sectorExposureLS.some((s) => s.sector === 'Unknown') && (
                <p className="mt-2 text-xs text-slate-500">
                  "Unknown" = no sector tag on the position and no live quote
                  yet. Will shrink as the price cache warms.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Returns distribution */}
      <div className="card">
        <h2 className="mb-4 text-lg font-semibold">Daily Returns Distribution</h2>
        {histogram.length === 0 ? (
          <p className="text-sm text-slate-500">
            Need at least one daily snapshot with a return value.
          </p>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={histogram}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="binMid"
                  tick={{ fontSize: 11 }}
                  stroke="#94a3b8"
                  tickFormatter={(v: number) => `${(v * 100).toFixed(1)}%`}
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  stroke="#94a3b8"
                  allowDecimals={false}
                />
                <Tooltip
                  formatter={(v: number) => [v, 'Days']}
                  labelFormatter={(l: number) => `Return ≈ ${(l * 100).toFixed(2)}%`}
                />
                <Bar dataKey="count" fill="#2563eb" isAnimationActive={false} />
                {metrics.var95Pct != null && (
                  <ReferenceLine
                    x={-metrics.var95Pct / 100}
                    stroke="#dc2626"
                    strokeDasharray="4 4"
                    label={{ value: 'VaR 95%', position: 'top', fontSize: 11, fill: '#dc2626' }}
                  />
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}

function TrafficLight({
  label,
  value,
  color,
  hint,
}: {
  label: string;
  value: string;
  color: LightColor;
  hint: string;
}) {
  const colorClass =
    color === 'green'
      ? 'bg-green-500'
      : color === 'yellow'
        ? 'bg-yellow-500'
        : 'bg-red-500';
  const Icon =
    color === 'green' ? CheckCircle2 : color === 'yellow' ? AlertTriangle : XCircle;
  return (
    <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${colorClass}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[10px] uppercase text-slate-500">{label}</div>
        <div className="truncate text-sm font-semibold text-slate-900">{value}</div>
        <div className="truncate text-[10px] text-slate-400" title={hint}>{hint}</div>
      </div>
      <Icon
        className={`h-3.5 w-3.5 shrink-0 ${
          color === 'green' ? 'text-green-500' : color === 'yellow' ? 'text-yellow-500' : 'text-red-500'
        }`}
      />
    </div>
  );
}

function LegendDot({ color, label, dashed = false }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block h-2 w-4 rounded"
        style={{
          backgroundColor: dashed ? 'transparent' : color,
          borderTop: dashed ? `2px dashed ${color}` : 'none',
        }}
      />
      {label}
    </span>
  );
}

function MetricCard({
  label,
  value,
  subtitle,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  subtitle?: string;
  tone: 'positive' | 'negative' | 'warning' | 'neutral';
  icon?: typeof TrendingUp;
}) {
  const toneClass =
    tone === 'positive'
      ? 'text-green-600'
      : tone === 'negative'
        ? 'text-red-600'
        : tone === 'warning'
          ? 'text-yellow-600'
          : 'text-slate-900';
  return (
    <div className="card">
      <div className="text-xs uppercase text-slate-500">{label}</div>
      <div className={`mt-1 flex items-center gap-1 text-2xl font-bold ${toneClass}`}>
        {Icon ? <Icon className="h-5 w-5" /> : null}
        <span>{value}</span>
      </div>
      {subtitle && <div className="mt-1 text-xs text-slate-500">{subtitle}</div>}
    </div>
  );
}