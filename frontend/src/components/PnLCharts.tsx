// Reusable P&L charts backed by daily_snapshots and per-position history.
import { useMemo } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  Legend,
} from 'recharts';
import type { DailySnapshot, Position } from '@/services/db';
import { buildPositionHistory } from '@/services/db';

const fmtMoney = (n: number) =>
  `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

function shortDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ============================================================
// Portfolio equity curve (uses daily_snapshots)
// ============================================================

export function PortfolioEquityChart({
  snapshots,
  initialCapital,
  sharpeRatio,
}: {
  snapshots: DailySnapshot[];
  initialCapital: number;
  /**
   * Annualized Sharpe ratio computed in `services/riskMetrics.ts` and
   * displayed as a header badge so the metric sits next to the curve
   * it describes. Null when the underlying return series has fewer
   * than 2 points or zero variance. Added when RiskPage started
   * passing the metric down so Sharpe appears on the chart itself,
   * not only in the MetricCard strip.
   */
  sharpeRatio?: number | null;
}) {
  const data = useMemo(
    () =>
      snapshots.map((s) => ({
        date: s.snapshot_date,
        equity: Number(s.equity),
        cash: Number(s.cash),
        exposure: Number(s.exposure),
      })),
    [snapshots],
  );

  if (data.length < 2) {
    return (
      <p className="text-sm text-slate-500">
        Need at least 2 daily snapshots to plot portfolio equity. The daily
        snapshot job will populate this over time.
      </p>
    );
  }

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2563eb" stopOpacity={0.4} />
              <stop offset="100%" stopColor="#2563eb" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis
            dataKey="date"
            tickFormatter={shortDate}
            tick={{ fontSize: 11 }}
            stroke="#94a3b8"
          />
          <YAxis
            tick={{ fontSize: 11 }}
            stroke="#94a3b8"
            tickFormatter={(v: number) =>
              v >= 1_000_000
                ? `$${(v / 1_000_000).toFixed(1)}M`
                : v >= 1_000
                  ? `$${(v / 1_000).toFixed(0)}k`
                  : `$${v.toFixed(0)}`
            }
          />
          <Tooltip
            formatter={(v: number, name: string) => [
              fmtMoney(v),
              name === 'equity' ? 'Equity' : name === 'cash' ? 'Cash' : 'Exposure',
            ]}
            labelFormatter={(l: string) => `Date: ${l}`}
          />
          <ReferenceLine
            y={initialCapital}
            stroke="#94a3b8"
            strokeDasharray="4 4"
            label={{
              value: 'Initial',
              position: 'right',
              fontSize: 10,
              fill: '#94a3b8',
            }}
          />
          <Area
            type="monotone"
            dataKey="equity"
            stroke="#2563eb"
            strokeWidth={2}
            fill="url(#equityFill)"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="cash"
            stroke="#10b981"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Legend
            wrapperStyle={{ fontSize: 11 }}
            formatter={(v) => (v === 'equity' ? 'Equity' : v === 'cash' ? 'Cash' : v)}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ============================================================
// Per-position P&L curve (replayed from trades)
// ============================================================

export function PositionPnLChart({
  position,
  trades,
  livePrice,
  closePriceMap,
}: {
  position: Position;
  trades: { id: string; ticker: string; qty: number; price: number; side: 'BUY' | 'SELL'; direction: 'LONG' | 'SHORT' | null; trade_timestamp: string }[];
  livePrice: number | null;
  closePriceMap?: Map<string, number>;
}) {
  const history = useMemo(
    () => buildPositionHistory(trades as any, position.ticker, livePrice, closePriceMap ?? new Map()),
    [trades, position.ticker, livePrice, closePriceMap],
  );

  // Data for chart: cost basis (steps on trade days), market value
  // (marked to daily close so the line drifts with the market), and
  // P&L (null between trades / before first close is available).
  const data = useMemo(
    () =>
      history.map((p) => ({
        date: p.date,
        cost: Math.abs(p.qty * p.avgPrice),
        value: Math.abs(p.marketValue),
        pnl: p.pnl ?? null,
        pnlPct: p.pnlPct ?? null,
        isLive: p.isLive,
      })),
    [history],
  );

  if (data.length === 0) {
    return (
      <p className="text-sm text-slate-500">No trade history for {position.ticker}.</p>
    );
  }

  const lastLive = data[data.length - 1];
  const livePnl = lastLive?.isLive && lastLive.pnl != null ? lastLive.pnl : 0;
  const livePnlPct = lastLive?.isLive && lastLive.pnlPct != null ? lastLive.pnlPct : 0;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline gap-4 text-xs text-slate-500">
        <span>
          Trade points: <span className="font-mono text-slate-700">{data.filter((d) => !d.isLive).length}</span>
        </span>
        {lastLive?.isLive && lastLive.pnl != null && (
          <span>
            Live mark:{' '}
            <span className={`font-mono ${livePnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {fmtMoney(livePnl)} ({fmtPct(livePnlPct)})
            </span>
          </span>
        )}
        {!lastLive?.isLive && (
          <span className="text-slate-400">
            (P&L shown only at the live mark — no historical price data)
          </span>
        )}
      </div>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="date"
              tickFormatter={shortDate}
              tick={{ fontSize: 11 }}
              stroke="#94a3b8"
            />
            <YAxis
              tick={{ fontSize: 11 }}
              stroke="#94a3b8"
              tickFormatter={(v: number) =>
                v >= 1_000_000
                  ? `$${(v / 1_000_000).toFixed(1)}M`
                  : v >= 1_000
                    ? `$${(v / 1_000).toFixed(0)}k`
                    : `$${v.toFixed(0)}`
              }
            />
            <Tooltip
              formatter={(v: number, name: string) => {
                if (name === 'pnl') return [fmtMoney(v), 'Unrealized P&L'];
                if (name === 'cost') return [fmtMoney(v), 'Cost basis'];
                if (name === 'value') return [fmtMoney(v), 'Position value'];
                return [v, name];
              }}
              labelFormatter={(l: string) => `Date: ${l}`}
            />
            <Line
              type="stepAfter"
              dataKey="cost"
              stroke="#94a3b8"
              strokeWidth={1.5}
              dot={{ r: 3, fill: '#94a3b8' }}
              isAnimationActive={false}
              name="Cost basis"
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke="#2563eb"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              name="Value"
            />
            <Line
              type="monotone"
              dataKey="pnl"
              stroke={livePnl >= 0 ? '#10b981' : '#ef4444'}
              strokeWidth={2}
              dot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={false}
              name="Unrealized P&L"
            />
            <ReferenceLine y={0} stroke="#cbd5e1" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
