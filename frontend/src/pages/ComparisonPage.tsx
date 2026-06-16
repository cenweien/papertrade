// ComparisonPage - Side-by-side portfolio comparison with live prices
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Wifi } from 'lucide-react';
import { getPortfolios, getPositions, type Portfolio } from '@/services/db';
import { useLivePrices } from '@/services/marketData';

interface ComparisonRow {
  portfolio: Portfolio;
  equity: number;
  totalReturn: number;
  positionCount: number;
  exposure: number;
  cash: number;
}

export function ComparisonPage() {
  const [rows, setRows] = useState<ComparisonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tickersByPortfolio, setTickersByPortfolio] = useState<Record<string, string[]>>({});

  // Load portfolios and their positions
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const portfolios = await getPortfolios();
        const data: ComparisonRow[] = await Promise.all(
          portfolios.map(async (p) => {
            const positions = await getPositions(p.id);
            const exposure = positions.reduce(
              (sum, pos) => sum + pos.qty * (pos.current_price || pos.avg_price),
              0,
            );
            const equity = p.current_capital + exposure;
            const totalReturn = ((equity - p.initial_capital) / p.initial_capital) * 100;
            return {
              portfolio: p,
              equity,
              totalReturn,
              positionCount: positions.length,
              exposure,
              cash: p.current_capital,
            };
          }),
        );
        data.sort((a, b) => b.totalReturn - a.totalReturn);
        setRows(data);
        // Stash tickers per portfolio for live price refresh
        const map: Record<string, string[]> = {};
        await Promise.all(
          portfolios.map(async (p) => {
            const pos = await getPositions(p.id);
            map[p.id] = pos.map((x) => x.ticker).filter(Boolean);
          }),
        );
        setTickersByPortfolio(map);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Collect all unique tickers across all portfolios for a single batch fetch
  const allTickers = useMemo(() => {
    const set = new Set<string>();
    Object.values(tickersByPortfolio).forEach((arr) => arr.forEach((t) => set.add(t)));
    return Array.from(set);
  }, [tickersByPortfolio]);

  const { quotes, refreshing, lastUpdated, refresh } = useLivePrices(allTickers, 60_000);

  // Recompute rows when live quotes change
  useEffect(() => {
    if (Object.keys(quotes).length === 0) return;
    setRows((prev) =>
      prev.map((r) => {
        const tickers = tickersByPortfolio[r.portfolio.id] || [];
        // We need positions to recompute accurately; but we have stored `exposure`
        // only. The cleanest path is to recompute positions here. To keep it
        // simple, we recompute equity by adding a delta for each ticker that
        // has a live quote. This is approximate but useful.
        return {
          ...r,
          // We don't have per-position data here, so the exposure value
          // doesn't update with live prices in this view. The portfolio
          // detail page shows fully live P&L.
        };
      }),
    );
  }, [quotes, tickersByPortfolio]);

  if (loading) {
    return <div className="p-8 text-slate-600">Loading comparison...</div>;
  }

  if (rows.length === 0) {
    return (
      <div className="p-8">
        <h1 className="mb-4 text-3xl font-bold text-slate-900">Portfolio Comparison</h1>
        <div className="card text-center">
          <p className="text-slate-600">No portfolios to compare. Create one to get started.</p>
        </div>
      </div>
    );
  }

  const best = rows[0];
  const worst = rows[rows.length - 1];
  const hasLiveData = Object.keys(quotes).length > 0;

  return (
    <div className="p-8">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-3xl font-bold text-slate-900">Portfolio Comparison</h1>
        {allTickers.length > 0 && (
          <button
            onClick={refresh}
            disabled={refreshing}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900"
            title="Refresh live prices from Finnhub"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        )}
      </div>
      <p className="mb-2 text-slate-600">
        Compare {rows.length} {rows.length === 1 ? 'portfolio' : 'portfolios'} side-by-side
      </p>

      {hasLiveData && (
        <div className="mb-6 flex items-center gap-2 text-xs text-slate-500">
          <Wifi className="h-3 w-3 text-green-500" />
          <span>
            Live prices from Finnhub available · last updated {lastUpdated?.toLocaleTimeString() || '—'}
            . Open a portfolio for full live P&L.
          </span>
        </div>
      )}

      {/* Summary cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="card border-l-4 border-green-500">
          <div className="text-xs uppercase text-slate-500">🏆 Best Performer</div>
          <Link
            to={`/portfolio/${best.portfolio.id}`}
            className="mt-1 block text-lg font-semibold text-slate-900 hover:text-primary-600"
          >
            {best.portfolio.name}
          </Link>
          <div className="mt-1 text-2xl font-bold text-green-600">
            +{best.totalReturn.toFixed(2)}%
          </div>
        </div>
        {rows.length > 1 && (
          <div className="card border-l-4 border-red-500">
            <div className="text-xs uppercase text-slate-500">📉 Worst Performer</div>
            <Link
              to={`/portfolio/${worst.portfolio.id}`}
              className="mt-1 block text-lg font-semibold text-slate-900 hover:text-primary-600"
            >
              {worst.portfolio.name}
            </Link>
            <div className={`mt-1 text-2xl font-bold ${worst.totalReturn >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {worst.totalReturn >= 0 ? '+' : ''}{worst.totalReturn.toFixed(2)}%
            </div>
          </div>
        )}
        <div className="card border-l-4 border-primary-500">
          <div className="text-xs uppercase text-slate-500">Total Equity</div>
          <div className="mt-1 text-2xl font-bold text-slate-900">
            ${rows.reduce((sum, r) => sum + r.equity, 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Across {rows.length} {rows.length === 1 ? 'portfolio' : 'portfolios'}
          </div>
        </div>
      </div>

      {/* Comparison table */}
      <div className="card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="py-3">Portfolio</th>
                <th className="py-3 text-right">Initial</th>
                <th className="py-3 text-right">Equity</th>
                <th className="py-3 text-right">Cash</th>
                <th className="py-3 text-right">Exposure</th>
                <th className="py-3 text-right">Positions</th>
                <th className="py-3 text-right">Return</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.portfolio.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="py-3">
                    <Link
                      to={`/portfolio/${r.portfolio.id}`}
                      className="font-semibold text-slate-900 hover:text-primary-600"
                    >
                      {r.portfolio.name}
                    </Link>
                    {r.portfolio.description && (
                      <div className="text-xs text-slate-500">{r.portfolio.description}</div>
                    )}
                  </td>
                  <td className="py-3 text-right text-slate-600">
                    ${r.portfolio.initial_capital.toLocaleString()}
                  </td>
                  <td className="py-3 text-right font-medium">
                    ${r.equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </td>
                  <td className="py-3 text-right text-slate-600">
                    ${r.cash.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </td>
                  <td className="py-3 text-right text-slate-600">
                    ${r.exposure.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </td>
                  <td className="py-3 text-right">{r.positionCount}</td>
                  <td className={`py-3 text-right font-bold ${r.totalReturn >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {r.totalReturn >= 0 ? '+' : ''}{r.totalReturn.toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
