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
  PieChart,
  Pie,
  Cell,
  Legend,
  BarChart,
  Bar,
  ReferenceLine,
} from 'recharts';
import {
  TrendingUp,
  TrendingDown,
  ArrowLeft,
  ShieldAlert,
  RefreshCw,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  getPortfolios,
  getPortfolio,
  getPositions,
  getTrades,
  getSnapshots,
  type Portfolio,
  type Position,
  type Trade,
  type DailySnapshot,
} from '@/services/db';
import { useLivePrices } from '@/services/marketData';
import {
  computeRiskMetrics,
  type RiskMetrics,
  type LivePriceMap,
} from '@/services/riskMetrics';

interface DataState {
  portfolio: Portfolio | null;
  positions: Position[];
  trades: Trade[];
  snapshots: DailySnapshot[];
}

const PIE_COLORS = [
  '#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
  '#06b6d4', '#a855f7',
];

const fmtPct = (n: number, digits = 2) =>
  `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
const fmtMoney = (n: number) =>
  `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export function RiskPage() {
  const { portfolioId } = useParams<{ portfolioId: string }>();
  const navigate = useNavigate();

  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [activeId, setActiveId] = useState<string | null>(portfolioId ?? null);
  const [data, setData] = useState<DataState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        const [portfolio, positions, trades, snapshots] = await Promise.all([
          getPortfolio(activeId),
          getPositions(activeId),
          getTrades(activeId, 500),
          getSnapshots(activeId, 365),
        ]);
        if (!portfolio) {
          setError('Portfolio not found.');
          setData(null);
          return;
        }
        setData({ portfolio, positions, trades, snapshots });
      } catch (err) {
        console.error('Failed to load risk data:', err);
        setError('Failed to load risk data.');
      } finally {
        setLoading(false);
      }
    })();
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

  const handleSelect = (id: string) => {
    setActiveId(id);
    navigate(`/risk/${id}`);
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

      {/* Six metric cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {/* Return % */}
        <MetricCard
          label="Return"
          value={fmtPct(metrics.returnPct)}
          tone={metrics.returnPct >= 0 ? 'positive' : 'negative'}
          icon={metrics.returnPct >= 0 ? TrendingUp : TrendingDown}
          subtitle={`Since inception · initial ${fmtMoney(data.portfolio.initial_capital)}`}
        />

        {/* Sharpe */}
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

        {/* Win rate */}
        <MetricCard
          label="Win Rate"
          value={
            metrics.winRate == null
              ? 'N/A'
              : `${metrics.winRate.toFixed(1)}%`
          }
          tone={metrics.winRate == null ? 'neutral' : metrics.winRate >= 50 ? 'positive' : 'neutral'}
          subtitle={
            metrics.winRate == null
              ? 'N/A (no closed trades)'
              : `${Math.round((metrics.winRate / 100) * metrics.closedTrades)} / ${metrics.closedTrades} closed trades`
          }
        />

        {/* Max Drawdown */}
        <MetricCard
          label="Max Drawdown"
          value={fmtPct(-metrics.maxDrawdownPct)}
          tone="negative"
          subtitle={`Since inception · ${totalSnapshots} snapshot${totalSnapshots === 1 ? '' : 's'}`}
        />

        {/* VaR 95% */}
        <MetricCard
          label="VaR (95%, daily loss)"
          value={
            metrics.var95Pct == null
              ? 'N/A'
              : `${metrics.var95Pct.toFixed(2)}%`
          }
          tone="negative"
          subtitle={
            metrics.var95Pct == null
              ? 'N/A (need ≥20 daily returns)'
              : 'Historical · 5th percentile'
          }
        />

        {/* Leverage */}
        <MetricCard
          label="Leverage Ratio"
          value={
            metrics.leverageRatio == null
              ? 'N/A'
              : `${metrics.leverageRatio.toFixed(2)}×`
          }
          tone={
            metrics.leverageRatio == null
              ? 'neutral'
              : metrics.leverageRatio > 2
                ? 'negative'
                : metrics.leverageRatio > 1.5
                  ? 'warning'
                  : 'neutral'
          }
          subtitle={
            metrics.leverageRatio == null
              ? 'N/A (non-positive equity)'
              : `Gross ${fmtMoney(metrics.grossExposure)}`
          }
        />
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

      {/* Sector exposure */}
      <div className="card mb-6">
        <h2 className="mb-4 text-lg font-semibold">Sector Exposure</h2>
        {metrics.sectorExposure.length === 0 ? (
          <p className="text-sm text-slate-500">No open positions.</p>
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={metrics.sectorExposure}
                    dataKey="valueUsd"
                    nameKey="sector"
                    innerRadius={50}
                    outerRadius={90}
                    isAnimationActive={false}
                  >
                    {metrics.sectorExposure.map((_, i) => (
                      <Cell
                        key={i}
                        fill={PIE_COLORS[i % PIE_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v: number, _name: string, item) => {
                      const pct = item?.payload?.pct ?? 0;
                      return [`${fmtMoney(v)} (${pct.toFixed(1)}%)`, item?.payload?.sector ?? ''];
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                    <th className="py-2">Sector</th>
                    <th className="py-2 text-right">Value</th>
                    <th className="py-2 text-right">% Equity</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.sectorExposure.map((s) => (
                    <tr key={s.sector} className="border-b border-slate-100">
                      <td className="py-2 font-medium">{s.sector}</td>
                      <td className="py-2 text-right">{fmtMoney(s.valueUsd)}</td>
                      <td className="py-2 text-right">{s.pct.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {metrics.sectorExposure.some((s) => s.sector === 'Unknown') && (
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