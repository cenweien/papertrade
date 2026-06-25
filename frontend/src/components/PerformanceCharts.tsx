import { useMemo } from 'react';
import {
  AreaChart,
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { type DailySnapshot, isTradingDay } from '@/services/db';

export type TimeRange = '5D' | 'WEEK' | 'DAILY' | 'YTD' | 'ALL';

interface PerformanceChartsProps {
  snapshots: DailySnapshot[];
  initialCapital: number;
  range: TimeRange;
}

const RANGE_DAYS: Record<TimeRange, number | null> = {
  '5D': 5,
  WEEK: 7,
  DAILY: 30,
  YTD: null,
  ALL: null,
};

function filterByRange(
  snapshots: DailySnapshot[],
  range: TimeRange,
): DailySnapshot[] {
  if (snapshots.length === 0) return snapshots;
  // Drop weekend rows first — the backfill writes a snapshot for every
  // calendar day, but weekends have no real price action. Including
  // them flattens the equity curve, biases daily-return bars toward 0,
  // and inflates the Sharpe window with zero-variance noise.
  const tradingOnly = snapshots.filter((s) => isTradingDay(s.snapshot_date));
  const last = parseISO(tradingOnly[tradingOnly.length - 1].snapshot_date);
  let cutoff: Date;
  if (range === 'YTD') {
    cutoff = new Date(last.getFullYear(), 0, 1);
  } else if (range === 'ALL') {
    return tradingOnly;
  } else {
    const days = RANGE_DAYS[range] ?? 30;
    cutoff = new Date(last);
    cutoff.setDate(cutoff.getDate() - (days - 1));
  }
  return tradingOnly.filter((s) => parseISO(s.snapshot_date) >= cutoff);
}

interface DerivedPoint {
  date: string;
  label: string;
  equity: number;
  cumulativeReturnPct: number;
  dailyReturnPct: number | null;
  drawdownPct: number;
  rollingSharpe: number | null;
}

function deriveSeries(
  snapshots: DailySnapshot[],
  initialCapital: number,
): DerivedPoint[] {
  if (snapshots.length === 0) return [];

  const base = snapshots[0].equity || initialCapital;
  let peak = base;
  const returns: number[] = [];

  return snapshots.map((s) => {
    const r = s.daily_return ?? 0;
    returns.push(r);
    if (s.equity > peak) peak = s.equity;
    const drawdown = peak > 0 ? ((peak - s.equity) / peak) * 100 : 0;

    // 20-day rolling Sharpe, annualised (rf = 0). Window shrinks until we
    // have at least 5 returns, then we report null to avoid misleading
    // early numbers.
    let rollingSharpe: number | null = null;
    if (returns.length >= 20) {
      const window = returns.slice(-20);
      const mean = window.reduce((a, b) => a + b, 0) / window.length;
      const variance =
        window.reduce((sum, x) => sum + (x - mean) ** 2, 0) /
        (window.length - 1);
      const sd = Math.sqrt(variance);
      rollingSharpe =
        sd > 0 ? (mean * 252) / (sd * Math.sqrt(252)) : 0;
    }

    const cumReturn = base > 0 ? ((s.equity - base) / base) * 100 : 0;

    return {
      date: s.snapshot_date,
      label: format(parseISO(s.snapshot_date), 'MMM d'),
      equity: s.equity,
      cumulativeReturnPct: cumReturn,
      dailyReturnPct: s.daily_return != null ? s.daily_return * 100 : null,
      drawdownPct: drawdown,
      rollingSharpe,
    };
  });
}

const tooltipLabelStyle = { color: '#0f172a', fontWeight: 600 } as const;
const tooltipContentStyle = {
  borderRadius: 8,
  border: '1px solid #e2e8f0',
  fontSize: 12,
} as const;

function fmtDate(v: string) {
  return v;
}

function EquityTooltip({ active, payload }: any) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload as DerivedPoint;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <div className="font-semibold text-slate-900">{p.label}</div>
      <div className="mt-1 text-slate-600">
        Equity:{' '}
        <span className="font-mono text-slate-900">
          ${p.equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </span>
      </div>
      <div
        className={p.cumulativeReturnPct >= 0 ? 'text-green-600' : 'text-red-600'}
      >
        Cumulative: {p.cumulativeReturnPct >= 0 ? '+' : ''}
        {p.cumulativeReturnPct.toFixed(2)}%
      </div>
    </div>
  );
}

function ReturnsTooltip({ active, payload }: any) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload as DerivedPoint;
  if (p.dailyReturnPct == null) return null;
  const positive = p.dailyReturnPct >= 0;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <div className="font-semibold text-slate-900">{p.label}</div>
      <div className={positive ? 'mt-1 text-green-600' : 'mt-1 text-red-600'}>
        Daily: {positive ? '+' : ''}
        {p.dailyReturnPct.toFixed(2)}%
      </div>
    </div>
  );
}

function DrawdownTooltip({ active, payload }: any) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload as DerivedPoint;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <div className="font-semibold text-slate-900">{p.label}</div>
      <div className="mt-1 text-red-600">
        Drawdown: -{p.drawdownPct.toFixed(2)}%
      </div>
    </div>
  );
}

function SharpeTooltip({ active, payload }: any) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload as DerivedPoint;
  if (p.rollingSharpe == null) return null;
  const positive = p.rollingSharpe >= 0;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <div className="font-semibold text-slate-900">{p.label}</div>
      <div className={positive ? 'mt-1 text-green-600' : 'mt-1 text-red-600'}>
        Sharpe (20d): {positive ? '+' : ''}
        {p.rollingSharpe.toFixed(2)}
      </div>
    </div>
  );
}

export function PerformanceCharts({
  snapshots,
  initialCapital,
  range,
}: PerformanceChartsProps) {
  const filtered = useMemo(
    () => filterByRange(snapshots, range),
    [snapshots, range],
  );
  const series = useMemo(
    () => deriveSeries(filtered, initialCapital),
    [filtered, initialCapital],
  );

  if (series.length === 0) {
    return (
      <div className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Performance</h2>
        </div>
        <p className="text-sm text-slate-500">
          No snapshots yet for this range. Daily snapshots are generated
          automatically; charts will appear once data is available.
        </p>
      </div>
    );
  }

  const last = series[series.length - 1];
  const dailyReturnValues = series
    .map((s) => s.dailyReturnPct)
    .filter((v): v is number => v != null);
  const positiveDays = dailyReturnValues.filter((v) => v > 0).length;
  const negativeDays = dailyReturnValues.filter((v) => v < 0).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="card !p-4">
          <div className="text-[10px] uppercase text-slate-500">Cumulative</div>
          <div
            className={`mt-1 text-xl font-bold ${
              last.cumulativeReturnPct >= 0 ? 'text-green-600' : 'text-red-600'
            }`}
          >
            {last.cumulativeReturnPct >= 0 ? '+' : ''}
            {last.cumulativeReturnPct.toFixed(2)}%
          </div>
        </div>
        <div className="card !p-4">
          <div className="text-[10px] uppercase text-slate-500">Max Drawdown</div>
          <div className="mt-1 text-xl font-bold text-red-600">
            -
            {Math.max(...series.map((s) => s.drawdownPct)).toFixed(2)}%
          </div>
        </div>
        <div className="card !p-4">
          <div className="text-[10px] uppercase text-slate-500">Sharpe (20d)</div>
          <div
            className={`mt-1 text-xl font-bold ${
              (last.rollingSharpe ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'
            }`}
          >
            {last.rollingSharpe != null
              ? `${last.rollingSharpe >= 0 ? '+' : ''}${last.rollingSharpe.toFixed(2)}`
              : '—'}
          </div>
        </div>
        <div className="card !p-4">
          <div className="text-[10px] uppercase text-slate-500">Win / Loss</div>
          <div className="mt-1 text-xl font-bold text-slate-900">
            <span className="text-green-600">{positiveDays}</span>
            <span className="text-slate-400"> / </span>
            <span className="text-red-600">{negativeDays}</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Equity Curve</h2>
          <span className="text-xs text-slate-500">{series.length} data points</span>
        </div>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={series}
              margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2563eb" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#2563eb" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: '#64748b' }}
                stroke="#cbd5e1"
                minTickGap={24}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#64748b' }}
                stroke="#cbd5e1"
                domain={['auto', 'auto']}
                tickFormatter={(v: number) =>
                  `$${(v / 1000).toFixed(0)}k`
                }
                width={56}
              />
              <Tooltip
                content={<EquityTooltip />}
                labelFormatter={fmtDate}
                labelStyle={tooltipLabelStyle}
                contentStyle={tooltipContentStyle}
              />
              <ReferenceLine
                y={initialCapital}
                stroke="#94a3b8"
                strokeDasharray="4 4"
                label={{
                  value: 'Initial',
                  position: 'right',
                  fill: '#94a3b8',
                  fontSize: 10,
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
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Daily Returns</h2>
          </div>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={series}
                margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  stroke="#cbd5e1"
                  minTickGap={24}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  stroke="#cbd5e1"
                  tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                  width={48}
                />
                <Tooltip
                  content={<ReturnsTooltip />}
                  labelFormatter={fmtDate}
                  labelStyle={tooltipLabelStyle}
                  contentStyle={tooltipContentStyle}
                />
                <ReferenceLine y={0} stroke="#94a3b8" />
                <Bar
                  dataKey="dailyReturnPct"
                  isAnimationActive={false}
                  shape={(props: any) => {
                    const { x, y, width, height, payload } = props;
                    const value = payload?.dailyReturnPct as number | null | undefined;
                    if (value == null) {
                      return <g />;
                    }
                    const positive = value >= 0;
                    // Recharts passes `height` as the rect's pixel extent.
                    // For negative values some recharts versions emit a
                    // negative `height` (rect grows upward from `y`);
                    // clamping with `Math.max(.., 1)` then produced a
                    // 1px line instead of a bar. Use the magnitude and
                    // anchor to the smaller `y` (the bar's "outer"
                    // edge) so both positive and negative bars render
                    // correctly.
                    const absHeight = Math.abs(height);
                    const barY = height >= 0 ? y : y - absHeight;
                    return (
                      <rect
                        x={x}
                        y={barY}
                        width={width}
                        height={Math.max(absHeight, 1)}
                        fill={positive ? '#16a34a' : '#dc2626'}
                        rx={2}
                      />
                    );
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Drawdown</h2>
          </div>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={series}
                margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="ddFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#dc2626" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#dc2626" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  stroke="#cbd5e1"
                  minTickGap={24}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  stroke="#cbd5e1"
                  tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                  width={48}
                />
                <Tooltip
                  content={<DrawdownTooltip />}
                  labelFormatter={fmtDate}
                  labelStyle={tooltipLabelStyle}
                  contentStyle={tooltipContentStyle}
                />
                <Area
                  type="monotone"
                  dataKey="drawdownPct"
                  stroke="#dc2626"
                  strokeWidth={2}
                  fill="url(#ddFill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Rolling Sharpe Ratio (20d)</h2>
          <span className="text-xs text-slate-500">Annualised</span>
        </div>
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={series}
              margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: '#64748b' }}
                stroke="#cbd5e1"
                minTickGap={24}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#64748b' }}
                stroke="#cbd5e1"
                width={48}
              />
              <Tooltip
                content={<SharpeTooltip />}
                labelFormatter={fmtDate}
                labelStyle={tooltipLabelStyle}
                contentStyle={tooltipContentStyle}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
                iconType="line"
              />
              <ReferenceLine y={0} stroke="#94a3b8" />
              <ReferenceLine
                y={1}
                stroke="#16a34a"
                strokeDasharray="4 4"
                label={{
                  value: 'Sharpe = 1',
                  position: 'right',
                  fill: '#16a34a',
                  fontSize: 10,
                }}
              />
              <Line
                type="monotone"
                dataKey="rollingSharpe"
                stroke="#7c3aed"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                name="Sharpe (20d)"
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        {series.every((s) => s.rollingSharpe == null) && (
          <p className="mt-2 text-xs text-slate-500">
            Rolling Sharpe appears once at least 20 daily snapshots are
            available in this range.
          </p>
        )}
      </div>
    </div>
  );
}

interface RangeTabsProps {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  options?: TimeRange[];
}

const DEFAULT_OPTIONS: TimeRange[] = ['5D', 'WEEK', 'DAILY', 'YTD', 'ALL'];

export function RangeTabs({ value, onChange, options = DEFAULT_OPTIONS }: RangeTabsProps) {
  return (
    <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5 text-xs shadow-sm">
      {options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={`rounded px-3 py-1.5 font-medium transition-colors ${
              active
                ? 'bg-primary-600 text-white'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {opt === '5D' ? '5D' : opt === 'WEEK' ? '1W' : opt === 'DAILY' ? '30D' : opt === 'YTD' ? 'YTD' : 'ALL'}
          </button>
        );
      })}
    </div>
  );
}
