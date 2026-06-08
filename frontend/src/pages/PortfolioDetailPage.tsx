// PortfolioDetailPage - Single portfolio with positions, trades, trade entry
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, TrendingUp, TrendingDown } from 'lucide-react';
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
} from '@/services/db';

export function PortfolioDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);

  // Trade form state
  const [showTradeForm, setShowTradeForm] = useState(false);
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [ticker, setTicker] = useState('');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const [pos, trds] = await Promise.all([getPositions(id), getTrades(id, 50)]);
      setPositions(pos);
      setTrades(trds);
    } catch (err) {
      console.error('Failed to load portfolio:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  const handleSubmitTrade = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !portfolio) return;
    setSubmitting(true);
    setError(null);
    try {
      await executeTrade({
        portfolio_id: id,
        ticker: ticker.trim().toUpperCase(),
        side,
        qty: parseFloat(qty),
        price: parseFloat(price),
        stop_price: stopPrice ? parseFloat(stopPrice) : undefined,
        notes: notes.trim() || undefined,
      });
      // Reset form
      setTicker('');
      setQty('');
      setPrice('');
      setStopPrice('');
      setNotes('');
      setShowTradeForm(false);
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

  // Compute metrics
  const totalExposure = positions.reduce(
    (sum, p) => sum + p.qty * (p.current_price || p.avg_price),
    0
  );
  const equity = portfolio.current_capital + totalExposure;
  const totalReturn = ((equity - portfolio.initial_capital) / portfolio.initial_capital) * 100;
  const isPositive = totalReturn >= 0;

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
        <button
          onClick={() => setShowTradeForm(true)}
          className="btn-primary"
        >
          + New Trade
        </button>
      </div>

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

      {showTradeForm && (
        <div className="card mb-6">
          <h2 className="mb-4 text-lg font-semibold">New Trade</h2>
          <form onSubmit={handleSubmitTrade} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
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
                <label className="label">Ticker</label>
                <input
                  type="text"
                  value={ticker}
                  onChange={(e) => setTicker(e.target.value.toUpperCase())}
                  placeholder="AAPL"
                  className="input mt-1"
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Quantity</label>
                <input
                  type="number"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  min="0.0001"
                  step="0.0001"
                  className="input mt-1"
                  required
                />
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
                  required
                />
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
                {submitting ? 'Executing...' : `Execute ${side}`}
              </button>
              <button
                type="button"
                onClick={() => setShowTradeForm(false)}
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
        <h2 className="mb-4 text-lg font-semibold">Positions ({positions.length})</h2>
        {positions.length === 0 ? (
          <p className="text-sm text-slate-500">No positions yet. Execute a BUY trade to start.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="py-2">Ticker</th>
                  <th className="py-2 text-right">Qty</th>
                  <th className="py-2 text-right">Avg Price</th>
                  <th className="py-2 text-right">Current</th>
                  <th className="py-2 text-right">Value</th>
                  <th className="py-2 text-right">P&L</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const currentPrice = p.current_price || p.avg_price;
                  const value = p.qty * currentPrice;
                  const cost = p.qty * p.avg_price;
                  const pnl = value - cost;
                  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
                  return (
                    <tr key={p.id} className="border-b border-slate-100">
                      <td className="py-3 font-semibold">{p.ticker}</td>
                      <td className="py-3 text-right">{p.qty}</td>
                      <td className="py-3 text-right">${p.avg_price.toFixed(2)}</td>
                      <td className="py-3 text-right">${currentPrice.toFixed(2)}</td>
                      <td className="py-3 text-right">${value.toFixed(2)}</td>
                      <td className={`py-3 text-right font-medium ${pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} ({pnlPct.toFixed(1)}%)
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
                  <th className="py-2">Side</th>
                  <th className="py-2 text-right">Qty</th>
                  <th className="py-2 text-right">Price</th>
                  <th className="py-2 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
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
                    <td className="py-3 text-right">{t.qty}</td>
                    <td className="py-3 text-right">${t.price.toFixed(2)}</td>
                    <td className="py-3 text-right">${t.total_value.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}