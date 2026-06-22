// PortfolioDetailPage - Single portfolio with live positions, trades, trade entry
import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, TrendingUp, TrendingDown, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import {
  getPortfolio,
  getPositions,
  getTrades,
  executeTrade,
  getSnapshots,
  computePerformanceMetrics,
  type Portfolio,
  type Position,
  type Trade,
  type DailySnapshot,
} from '@/services/db';
import { useLivePrices, refreshQuote, getQuote } from '@/services/marketData';
import { getHistorySeriesLastDays, type HistorySeries } from '@/services/marketHistory';
import { PortfolioEquityChart, PositionPnLChart } from '@/components/PnLCharts';
import { computeRiskMetrics, type LivePriceMap } from '@/services/riskMetrics';

// Lookback window for the market-derived return series; matches the
// Risk page and the bloomberg-service scheduler default.
const HISTORY_LOOKBACK_DAYS = 365;

// Compact $ formatter for the L/S summary strip ($1.2M, $450k, etc.).
function fmtMoneyShort(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function PortfolioDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [snapshots, setSnapshots] = useState<DailySnapshot[]>([]);
  const [historySeries, setHistorySeries] = useState<HistorySeries[]>([]);
  const [loading, setLoading] = useState(true);
  // Ticker of the position whose P&L chart is currently shown.
  // Defaults to the first position; if none, empty string.
  const [selectedTicker, setSelectedTicker] = useState<string>('');

  // Trade form state
  const [showTradeForm, setShowTradeForm] = useState(false);
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>('LONG');
  const [ticker, setTicker] = useState('');
  const [qty, setQty] = useState('');
  const [notional, setNotional] = useState('');
  const [price, setPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [priceHint, setPriceHint] = useState<string | null>(null);
  // True once the user has manually edited the qty field. We stop
  // auto-syncing qty from notional after this so user edits aren't
  // clobbered. Resets when the ticker or notional is cleared.
  const [qtyTouched, setQtyTouched] = useState(false);

  // Map (side, direction) -> human-readable action verb. SELL + SHORT
  // is "SHORT", BUY + SHORT is "COVER", everything else is the side.
  const actionVerb =
    side === 'SELL' && direction === 'SHORT' ? 'SHORT'
    : side === 'BUY' && direction === 'SHORT' ? 'COVER'
    : side;

  // Live price state (Finnhub) - auto-refresh every 60s
  const positionTickers = useMemo(
    () => positions.map((p) => p.ticker).filter(Boolean),
    [positions],
  );
  const { quotes, refreshing, lastUpdated, refresh: refreshAll } = useLivePrices(
    positionTickers,
    60_000,
  );

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const p = await getPortfolio(id);
      if (!p) {
        setLoading(false);
        return;
      }
      setPortfolio(p);
      const [pos, trds, snaps] = await Promise.all([
        getPositions(id),
        getTrades(id, 50),
        getSnapshots(id, 365),
      ]);
      setPositions(pos);
      setTrades(trds);
      setSnapshots(snaps);
      setSelectedTicker((cur) => cur || (pos[0]?.ticker ?? ''));
      // Market-derived history series for Sharpe / VaR / CVaR /
      // Sortino. Failure is non-fatal — computeRiskMetrics falls back
      // to the snapshot-derived series when historySeries is empty.
      const heldTickers = pos
        .map((p2) => p2.ticker?.toUpperCase())
        .filter(Boolean) as string[];
      if (heldTickers.length > 0) {
        try {
          const hist = await getHistorySeriesLastDays(heldTickers, HISTORY_LOOKBACK_DAYS);
          setHistorySeries(hist);
        } catch (err) {
          console.warn('history-series fetch failed; falling back to snapshots:', err);
          setHistorySeries([]);
        }
      } else {
        setHistorySeries([]);
      }
    } catch (err) {
      console.error('Failed to load portfolio:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // When the user types a ticker in the trade form, prefill price with live quote
  useEffect(() => {
    const t = ticker.trim().toUpperCase();
    if (t.length < 1) {
      setPriceHint(null);
      return;
    }
    let cancelled = false;
    const handler = setTimeout(async () => {
      try {
        const q = quotes[t] || (await getQuote(t));
        if (cancelled) return;
        if (q) {
          setPriceHint(`Live: $${q.current_price.toFixed(2)}${q.change_pct != null ? ` (${q.change_pct >= 0 ? '+' : ''}${q.change_pct.toFixed(2)}%)` : ''}`);
          // Only auto-fill price if user hasn't typed one yet
          if (!price) setPrice(q.current_price.toFixed(2));
        } else {
          setPriceHint(null);
        }
      } catch {
        if (!cancelled) setPriceHint(null);
      }
    }, 400); // debounce
    return () => {
      cancelled = true;
      clearTimeout(handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, quotes]);

  // Auto-fill qty from notional: when the user types a USD notional
  // ("buy $50k of AAPL") and we have a price, compute
  // floor(notional / price) and write it into the qty field. Stops
  // the moment the user types directly into the qty field (qtyTouched).
  useEffect(() => {
    if (qtyTouched) return;
    const n = parseFloat(notional);
    const p = parseFloat(price);
    if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(p) || p <= 0) {
      return;
    }
    const computed = Math.floor(n / p);
    if (computed > 0) {
      setQty(String(computed));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notional, price]);

  const handleRefreshOne = async (sym: string) => {
    try {
      await refreshQuote(sym);
      await refreshAll();
    } catch (err) {
      console.error('Refresh failed:', err);
    }
  };

  const handleSubmitTrade = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !portfolio) return;
    setSubmitting(true);
    setError(null);
    try {
      const qtyNum = qty ? parseFloat(qty) : null;
      const notionalNum = notional ? parseFloat(notional) : null;
      const priceNum = price ? parseFloat(price) : null;
      await executeTrade({
        portfolio_id: id,
        ticker: ticker.trim().toUpperCase(),
        side,
        direction,
        qty: qtyNum,
        notional: notionalNum,
        price: priceNum,
        stop_price: stopPrice ? parseFloat(stopPrice) : undefined,
        notes: notes.trim() || undefined,
      });
      // Reset form
      setTicker('');
      setQty('');
      setNotional('');
      setPrice('');
      setStopPrice('');
      setNotes('');
      setDirection('LONG');
      setShowTradeForm(false);
      setPriceHint(null);
      setQtyTouched(false);
      // Reload
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-slate-600">Loading...</div>;
  }

  if (!portfolio) {
    return (
      <div className="p-8">
        <p className="text-slate-600">Portfolio not found.</p>
        <Link to="/" className="text-primary-600 hover:underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  // Compute metrics using live prices where available, else fall back to stored current_price / avg_price
  const totalExposure = positions.reduce((sum, p) => {
    const live = quotes[p.ticker]?.current_price;
    const px = live ?? p.current_price ?? p.avg_price;
    return sum + p.qty * px;
  }, 0);
  const equity = portfolio.current_capital + totalExposure;
  const totalReturn = ((equity - portfolio.initial_capital) / portfolio.initial_capital) * 100;
  const isPositive = totalReturn >= 0;
  const hasLiveData = Object.keys(quotes).length > 0;

  return (
    <div className="p-8">
      <Link to="/" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" />
        Back to dashboard
      </Link>

      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">{portfolio.name}</h1>
          {portfolio.description && (
            <p className="mt-1 text-slate-600">{portfolio.description}</p>
          )}
        </div>
        <button onClick={() => setShowTradeForm(true)} className="btn-primary">
          + New Trade
        </button>
      </div>

      {/* Live data indicator */}
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

      {/* Summary cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-4">
        <div className="card">
          <div className="text-xs uppercase text-slate-500">Equity</div>
          <div className="mt-1 text-2xl font-bold text-slate-900">
            ${equity.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="card">
          <div className="text-xs uppercase text-slate-500">Total Return</div>
          <div className={`mt-1 flex items-center gap-1 text-2xl font-bold ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
            {isPositive ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
            {totalReturn.toFixed(2)}%
          </div>
        </div>
        <div className="card">
          <div className="text-xs uppercase text-slate-500">Cash</div>
          <div className="mt-1 text-2xl font-bold text-slate-900">
            ${portfolio.current_capital.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="card">
          <div className="text-xs uppercase text-slate-500">Exposure</div>
          <div className="mt-1 text-2xl font-bold text-slate-900">
            ${totalExposure.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        </div>
      </div>

      {/* Portfolio equity curve (from daily_snapshots) */}
      <div className="card mb-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Portfolio Equity Over Time</h2>
          <span className="text-xs text-slate-500">
            {snapshots.length} snapshot{snapshots.length === 1 ? '' : 's'}
          </span>
        </div>
        <PortfolioEquityChart
          snapshots={snapshots}
          initialCapital={portfolio.initial_capital}
        />
      </div>

      {showTradeForm && (
        <div className="card mb-6">
          <h2 className="mb-4 text-lg font-semibold">New Trade</h2>
          <form onSubmit={handleSubmitTrade} className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="label">Side</label>
                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSide('BUY')}
                    className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                      side === 'BUY' ? 'bg-green-600 text-white' : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    BUY
                  </button>
                  <button
                    type="button"
                    onClick={() => setSide('SELL')}
                    className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                      side === 'SELL' ? 'bg-red-600 text-white' : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    SELL
                  </button>
                </div>
              </div>
              <div>
                <label className="label">Direction</label>
                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setDirection('LONG')}
                    className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                      direction === 'LONG' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    LONG
                  </button>
                  <button
                    type="button"
                    onClick={() => setDirection('SHORT')}
                    className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                      direction === 'SHORT' ? 'bg-purple-600 text-white' : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    SHORT
                  </button>
                </div>
              </div>
              <div>
                <label className="label">Ticker</label>
                <input
                  type="text"
                  value={ticker}
                  onChange={(e) => {
                    setTicker(e.target.value.toUpperCase());
                    setQtyTouched(false);
                  }}
                  placeholder="AAPL / ES1 / EURUSD / 700"
                  className="input mt-1"
                  required
                />
                {priceHint && (
                  <div className="mt-1 text-xs text-slate-500">{priceHint}</div>
                )}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="label">Quantity (shares/contracts)</label>
                <input
                  type="number"
                  value={qty}
                  onChange={(e) => {
                    setQty(e.target.value);
                    if (e.target.value !== '') setQtyTouched(true);
                  }}
                  min="0.0001"
                  step="0.0001"
                  className="input mt-1"
                />
                <p className="mt-1 text-[10px] text-slate-400">Auto-filled from notional &amp; price; edit to override</p>
              </div>
              <div>
                <label className="label">Notional (USD)</label>
                <input
                  type="number"
                  value={notional}
                  onChange={(e) => {
                    setNotional(e.target.value);
                    setQtyTouched(false);
                  }}
                  min="1"
                  step="1"
                  placeholder="e.g. 50000"
                  className="input mt-1"
                />
                <p className="mt-1 text-[10px] text-slate-400">Type a $ amount to auto-fill quantity</p>
              </div>
              <div>
                <label className="label">Price ($)</label>
                <input
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  min="0.01"
                  step="0.01"
                  className="input mt-1"
                />
                <p className="mt-1 text-[10px] text-slate-400">Optional for notional</p>
              </div>
            </div>
            <div>
              <label className="label">Stop Price (optional)</label>
              <input
                type="number"
                value={stopPrice}
                onChange={(e) => setStopPrice(e.target.value)}
                min="0.01"
                step="0.01"
                className="input mt-1"
              />
            </div>
            <div>
              <label className="label">Notes (optional)</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="input mt-1"
              />
            </div>
            {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}
            <div className="flex gap-2">
              <button type="submit" disabled={submitting} className="btn-primary">
                {submitting ? 'Executing...' : `Execute ${actionVerb}`}
              </button>
              <button
                type="button"
                onClick={() => { setShowTradeForm(false); setPriceHint(null); setDirection('LONG'); setQtyTouched(false); }}
                disabled={submitting}
                className="btn-secondary"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Per-position P&L chart */}
      {positions.length > 0 && (
        <div className="card mb-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Position P&L Over Time</h2>
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-500" htmlFor="pnl-ticker">
                Ticker
              </label>
              <select
                id="pnl-ticker"
                value={selectedTicker}
                onChange={(e) => setSelectedTicker(e.target.value)}
                className="input py-1 text-sm"
              >
                {positions.map((p) => (
                  <option key={p.id} value={p.ticker}>
                    {p.ticker}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {(() => {
            const pos = positions.find((p) => p.ticker === selectedTicker) ?? positions[0];
            if (!pos) return null;
            const live = quotes[pos.ticker];
            return (
              <PositionPnLChart
                position={pos}
                trades={trades as any}
                livePrice={live?.current_price ?? pos.current_price ?? null}
              />
            );
          })()}
        </div>
      )}

      {/* Positions */}
      <div className="card mb-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Positions ({positions.length})</h2>
          {positions.length > 0 && (
            <button
              onClick={refreshAll}
              disabled={refreshing}
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900"
              title="Refresh all prices from Bloomberg"
            >
              <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          )}
        </div>

        {/* T1.4: Long/Short subtotals strip */}
        {positions.length > 0 && (() => {
          const livePrices: LivePriceMap = {};
          for (const [tk, q] of Object.entries(quotes)) {
            livePrices[tk] = { current_price: q.current_price, sector: q.sector };
          }
          const metrics = computeRiskMetrics({
            portfolio,
            positions,
            trades,
            snapshots,
            livePrices,
            historySeries,
          });
          const longs = positions.filter((p) => p.qty > 0).length;
          const shorts = positions.filter((p) => p.qty < 0).length;
          const grossAbs = metrics.grossExposure;
          const equityForPct = metrics.equity || 1;
          return (
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase text-slate-500">Longs</div>
                <div className="text-sm font-semibold text-blue-700">
                  {longs} pos · {fmtMoneyShort(metrics.longExposure)}{' '}
                  <span className="text-xs font-normal text-slate-500">
                    ({((metrics.longExposure / grossAbs) * 100).toFixed(0)}% gross)
                  </span>
                </div>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase text-slate-500">Shorts</div>
                <div className="text-sm font-semibold text-purple-700">
                  {shorts} pos · {fmtMoneyShort(Math.abs(metrics.shortExposure))}{' '}
                  <span className="text-xs font-normal text-slate-500">
                    ({((Math.abs(metrics.shortExposure) / grossAbs) * 100).toFixed(0)}% gross)
                  </span>
                </div>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase text-slate-500">Net</div>
                <div className={`text-sm font-semibold ${metrics.netExposure >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                  {fmtMoneyShort(metrics.netExposure)}{' '}
                  <span className="text-xs font-normal text-slate-500">
                    ({((metrics.netExposure / equityForPct) * 100).toFixed(0)}% eq)
                  </span>
                </div>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase text-slate-500">Gross</div>
                <div className="text-sm font-semibold text-slate-900">
                  {fmtMoneyShort(metrics.grossExposure)}{' '}
                  <span className="text-xs font-normal text-slate-500">
                    ({((metrics.grossExposure / equityForPct) * 100).toFixed(0)}% eq)
                  </span>
                </div>
              </div>
            </div>
          );
        })()}

        {positions.length === 0 ? (
          <p className="text-sm text-slate-500">No positions yet. Execute a BUY trade to start.</p>
        ) : (() => {
          // Build a map of ticker -> earliest trade date. The position
          // row's `updated_at` is the DB-write moment (NOW()), so for
          // historical trades it can't be used for "days held". The
          // trades are already loaded in state, so we can use the
          // earliest trade's `executed_at` (or `trade_timestamp` as
          // a fallback for very old rows) to anchor the holding period.
          const earliestTradeByTicker = new Map<string, number>();
          for (const t of trades) {
            if (!t.ticker) continue;
            const ts = new Date(t.executed_at ?? t.trade_timestamp).getTime();
            if (!Number.isFinite(ts)) continue;
            const cur = earliestTradeByTicker.get(t.ticker);
            if (cur == null || ts < cur) earliestTradeByTicker.set(t.ticker, ts);
          }
          // Compute per-row valuation + weight/days-held/% gross, then
          // sort by |weight| desc.
          const enriched = positions.map((p) => {
            const live = quotes[p.ticker];
            const currentPrice = live?.current_price ?? p.current_price ?? p.avg_price;
            // For shorts, qty is negative. `value` and `cost` are both
            // signed-dollar amounts; for shorts they're negative. The
            // P&L formula (value - cost) works for both because the
            // signs cancel: e.g. (-100 * $50) - (-100 * $100) = +$5000
            // (a short that dropped $50 in price made $5000).
            const value = p.qty * currentPrice;
            const cost = p.qty * p.avg_price;
            const pnl = value - cost;
            // P&L % uses |cost| as the denominator (entry notional).
            // For longs, cost is positive so |cost| === cost. For
            // shorts, cost is negative, so the old `cost > 0` guard
            // collapsed every short's P&L % to 0 — the root cause of
            // the "shorts show 0.0%" bug. Use |cost| so both long and
            // short return the same |pnl / entry_notional| * 100.
            const costAbs = Math.abs(cost);
            const pnlPct = costAbs > 0 ? (pnl / costAbs) * 100 : 0;
            const isLive = !!live;
            const changePct = live?.change_pct;
            const isShort = p.qty < 0;
            // Days held: prefer the earliest trade's executed_at for
            // this ticker (correct for historical trades anchored to a
            // past date). Fall back to p.updated_at when there are no
            // trades in state (race during initial load).
            const openedAt = earliestTradeByTicker.get(p.ticker);
            const daysHeld = Math.max(
              0,
              Math.floor(
                (Date.now() - (openedAt ?? new Date(p.updated_at).getTime()))
                  / (24 * 60 * 60 * 1000),
              ),
            );
            const openedAtDate = openedAt != null ? new Date(openedAt) : null;
            return {
              p, live, currentPrice, value, pnl, pnlPct, isLive, changePct, isShort,
              daysHeld, openedAtDate,
            };
          });
          const equity = portfolio.current_capital + enriched.reduce((s, r) => s + r.value, 0);
          const grossAbs = enriched.reduce((s, r) => s + Math.abs(r.value), 0) || 1;
          const sorted = [...enriched].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

          return (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                      <th className="py-2">Ticker</th>
                      <th className="py-2">Direction</th>
                      <th className="py-2 text-right">Qty</th>
                      <th className="py-2 text-right">Avg Price</th>
                      <th className="py-2 text-right">Current</th>
                      <th className="py-2 text-right">Value</th>
                      <th className="py-2 text-right">P&L</th>
                      <th className="py-2 text-right">Weight</th>
                      <th className="py-2 text-right">Days Held</th>
                      <th className="py-2 text-right">% Gross</th>
                      <th className="py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(({ p, live, currentPrice, value, pnl, pnlPct, isLive, changePct, isShort, daysHeld, openedAtDate }) => {
                      const qtyDisplay = p.qty > 0 ? `+${p.qty.toLocaleString()}` : p.qty.toLocaleString();
                      const weightPct = equity > 0 ? (value / equity) * 100 : 0;
                      const grossPct = (Math.abs(value) / grossAbs) * 100;
                      return (
                        <tr key={p.id} className="border-b border-slate-100">
                          <td className="py-3 font-semibold">
                            {p.ticker}
                            {live?.company_name && (
                              <div className="text-xs font-normal text-slate-500">{live.company_name}</div>
                            )}
                          </td>
                          <td className="py-3">
                            <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
                              isShort
                                ? 'bg-purple-100 text-purple-800'
                                : 'bg-blue-100 text-blue-800'
                            }`}>
                              {isShort ? 'Short' : 'Long'}
                            </span>
                          </td>
                          <td className={`py-3 text-right font-mono ${isShort ? 'text-purple-700' : 'text-slate-900'}`}>
                            {qtyDisplay}
                          </td>
                          <td className="py-3 text-right">${p.avg_price.toFixed(2)}</td>
                          <td className="py-3 text-right">
                            <div>${currentPrice.toFixed(2)}</div>
                            {changePct != null && (
                              <div className={`text-xs ${changePct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}% today
                              </div>
                            )}
                            {!isLive && p.current_price && (
                              <div className="text-xs text-slate-400">stored</div>
                            )}
                          </td>
                          <td className={`py-3 text-right ${isShort ? 'text-purple-700' : 'text-slate-900'}`}>
                            ${Math.abs(value).toFixed(2)}
                            {isShort && (
                              <div className="text-[10px] font-normal text-slate-500">
                                short notional
                              </div>
                            )}
                          </td>
                          <td className={`py-3 text-right font-medium ${pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            <div>
                              {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} ({pnlPct.toFixed(1)}%)
                            </div>
                            {openedAtDate && (
                              <div className="text-[10px] font-normal text-slate-500" title={`Opened on ${openedAtDate.toLocaleDateString()}`}>
                                since {openedAtDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                {' '}· {daysHeld}d
                              </div>
                            )}
                          </td>
                          <td className={`py-3 text-right font-mono text-xs ${isShort ? 'text-purple-700' : 'text-slate-900'}`}>
                            {isShort ? '-' : '+'}{Math.abs(weightPct).toFixed(1)}%
                          </td>
                          <td className="py-3 text-right font-mono text-xs text-slate-600">
                            {daysHeld}d
                          </td>
                          <td className="py-3 text-right font-mono text-xs text-slate-600">
                            {grossPct.toFixed(1)}%
                          </td>
                          <td className="py-3 text-right">
                            <button
                              onClick={() => handleRefreshOne(p.ticker)}
                              className="text-slate-400 hover:text-slate-700"
                              title={`Refresh ${p.ticker}`}
                            >
                              <RefreshCw className="h-3 w-3" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* T1.4: Concentration footer */}
              {(() => {
                const livePrices: LivePriceMap = {};
                for (const [tk, q] of Object.entries(quotes)) {
                  livePrices[tk] = { current_price: q.current_price, sector: q.sector };
                }
                const concMetrics = computeRiskMetrics({
                  portfolio,
                  positions,
                  trades,
                  snapshots,
                  livePrices,
                  historySeries,
                }).concentration;
                return (
                  <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-200 pt-3 sm:grid-cols-4">
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">HHI Long</div>
                      <div className="text-sm font-semibold text-slate-900">
                        {concMetrics.herfindahlLong.toFixed(3)}
                      </div>
                      <div className="text-[10px] text-slate-400">0 = diversified · 1 = one name</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">HHI Short</div>
                      <div className="text-sm font-semibold text-slate-900">
                        {concMetrics.herfindahlShort.toFixed(3)}
                      </div>
                      <div className="text-[10px] text-slate-400">0 = diversified · 1 = one name</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">Top 5 % Gross</div>
                      <div className="text-sm font-semibold text-slate-900">
                        {concMetrics.top5GrossPct.toFixed(1)}%
                      </div>
                      <div className="text-[10px] text-slate-400">Concentration in top 5 names</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">Largest Single</div>
                      <div className="text-sm font-semibold text-slate-900">
                        {concMetrics.largestSinglePct.toFixed(1)}%
                      </div>
                      <div className="text-[10px] text-slate-400">Biggest name / total gross</div>
                    </div>
                  </div>
                );
              })()}
            </>
          );
        })()}
      </div>

      {/* Recent trades */}
      <div className="card">
        <h2 className="mb-4 text-lg font-semibold">Recent Trades ({trades.length})</h2>
        {trades.length === 0 ? (
          <p className="text-sm text-slate-500">No trades yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="py-2">Date</th>
                  <th className="py-2">Ticker</th>
                  <th className="py-2">Action</th>
                  <th className="py-2">Direction</th>
                  <th className="py-2 text-right">Qty</th>
                  <th className="py-2 text-right">Price</th>
                  <th className="py-2 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => {
                  const direction = t.direction ?? 'LONG';
                  // Prefer executed_at (the user-named trade moment,
                  // e.g. "3 days ago" or "on 2025-06-18") for display.
                  // Fall back to trade_timestamp for very old rows that
                  // pre-date the executed_at column being added.
                  const displayTs = t.executed_at ?? t.trade_timestamp;
                  const displayDate = new Date(displayTs);
                  // Flag as "historical" if the executed_at is more
                  // than 1 day in the past. The trade_timestamp (when
                  // the row was written) is always NOW, so a 1-day
                  // buffer is enough to distinguish a back-dated
                  // trade from a same-day one.
                  const isHistorical =
                    Date.now() - displayDate.getTime() > 24 * 60 * 60 * 1000;
                  return (
                    <tr key={t.id} className="border-b border-slate-100">
                      <td className="py-3 text-slate-600">
                        <div>{displayDate.toLocaleString()}</div>
                        {isHistorical && (
                          <span className="mt-0.5 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">
                            historical
                          </span>
                        )}
                      </td>
                      <td className="py-3 font-semibold">{t.ticker}</td>
                      <td className="py-3">
                        <span className={`badge ${t.side === 'BUY' ? 'badge-success' : 'badge-danger'}`}>
                          {t.side}
                        </span>
                      </td>
                      <td className="py-3">
                        <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          direction === 'SHORT'
                            ? 'bg-purple-100 text-purple-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}>
                          {direction}
                        </span>
                      </td>
                      <td className="py-3 text-right">{t.qty}</td>
                      <td className="py-3 text-right">${t.price.toFixed(2)}</td>
                      <td className="py-3 text-right">${t.total_value.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
