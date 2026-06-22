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
import { PerformanceCharts, RangeTabs, type TimeRange } from '@/components/PerformanceCharts';

export function PortfolioDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [snapshots, setSnapshots] = useState<DailySnapshot[]>([]);
  const [chartRange, setChartRange] = useState<TimeRange>('DAILY');
  const [loading, setLoading] = useState(true);

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

      {/* Performance charts */}
      <div className="mb-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Performance</h2>
          <RangeTabs value={chartRange} onChange={setChartRange} />
        </div>
        <PerformanceCharts
          snapshots={snapshots}
          initialCapital={portfolio.initial_capital}
          range={chartRange}
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
                  onChange={(e) => setTicker(e.target.value.toUpperCase())}
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
                  onChange={(e) => setQty(e.target.value)}
                  min="0.0001"
                  step="0.0001"
                  className="input mt-1"
                />
                <p className="mt-1 text-[10px] text-slate-400">Leave empty if using notional</p>
              </div>
              <div>
                <label className="label">Notional (USD)</label>
                <input
                  type="number"
                  value={notional}
                  onChange={(e) => setNotional(e.target.value)}
                  min="1"
                  step="1"
                  placeholder="e.g. 50000"
                  className="input mt-1"
                />
                <p className="mt-1 text-[10px] text-slate-400">Resolved at execute time</p>
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
                onClick={() => { setShowTradeForm(false); setPriceHint(null); setDirection('LONG'); }}
                disabled={submitting}
                className="btn-secondary"
              >
                Cancel
              </button>
            </div>
          </form>
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
        {positions.length === 0 ? (
          <p className="text-sm text-slate-500">No positions yet. Execute a BUY trade to start.</p>
        ) : (
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
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const live = quotes[p.ticker];
                  const currentPrice = live?.current_price ?? p.current_price ?? p.avg_price;
                  const value = p.qty * currentPrice;
                  const cost = p.qty * p.avg_price;
                  const pnl = value - cost;
                  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
                  const isLive = !!live;
                  const changePct = live?.change_pct;
                  const isShort = p.qty < 0;
                  const qtyDisplay = p.qty > 0 ? `+${p.qty.toLocaleString()}` : p.qty.toLocaleString();
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
                      <td className="py-3 text-right">${value.toFixed(2)}</td>
                      <td className={`py-3 text-right font-medium ${pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} ({pnlPct.toFixed(1)}%)
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
        )}
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
                  return (
                    <tr key={t.id} className="border-b border-slate-100">
                      <td className="py-3 text-slate-600">
                        {new Date(t.trade_timestamp).toLocaleString()}
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
