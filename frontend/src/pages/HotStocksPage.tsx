// HotStocksPage - Real-time Bloomberg-powered price dashboard
//
// Big, visual, immediately useful landing screen. Shows a curated set
// of tickers across asset classes (US equity, ETF, futures, FX, HK
// equity) with their live prices, % change, day range, and volume,
// refreshing every 60 seconds via the existing useLivePrices hook
// (which goes through the full Vercel -> Supabase -> Cloudflare ->
// bloomberg-service -> Bloomberg SAPI chain).
import { useState } from 'react';
import { Activity, TrendingUp, TrendingDown, Flame, RefreshCw } from 'lucide-react';
import {
  useLivePrices,
  type StockQuote,
} from '@/services/marketData';

type AssetClass = 'EQUITY' | 'ETF' | 'FUTURE' | 'FX' | 'BOND' | 'OPTION' | 'INDEX' | 'CRYPTO' | 'MUTUAL_FUND';

interface HotStock {
  ticker: string;
  name: string;
  sector: string;
  asset_class: AssetClass;
}

const HOT_STOCKS: HotStock[] = [
  { ticker: 'AAPL',  name: 'Apple Inc.',           sector: 'Technology',       asset_class: 'EQUITY' },
  { ticker: 'TSLA',  name: 'Tesla, Inc.',          sector: 'Automotive',       asset_class: 'EQUITY' },
  { ticker: 'NVDA',  name: 'NVIDIA Corporation',   sector: 'Semiconductors',   asset_class: 'EQUITY' },
  { ticker: 'SPY',   name: 'SPDR S&P 500 ETF',     sector: 'ETF',              asset_class: 'ETF' },
  { ticker: 'ES1',   name: 'S&P 500 e-mini Future',sector: 'Index',            asset_class: 'FUTURE' },
  { ticker: 'EURUSD',name: 'EUR / USD',            sector: 'FX',               asset_class: 'FX' },
  { ticker: '700',   name: 'Tencent Holdings',     sector: 'HK Equity',        asset_class: 'EQUITY' },
];

const ASSET_CLASS_BADGE: Record<AssetClass, { label: string; cls: string }> = {
  EQUITY:      { label: 'EQ',     cls: 'bg-blue-100 text-blue-800' },
  ETF:         { label: 'ETF',    cls: 'bg-emerald-100 text-emerald-800' },
  FUTURE:      { label: 'FUT',    cls: 'bg-purple-100 text-purple-800' },
  FX:          { label: 'FX',     cls: 'bg-amber-100 text-amber-800' },
  BOND:        { label: 'BND',    cls: 'bg-slate-100 text-slate-800' },
  OPTION:      { label: 'OPT',    cls: 'bg-pink-100 text-pink-800' },
  INDEX:       { label: 'IDX',    cls: 'bg-indigo-100 text-indigo-800' },
  CRYPTO:      { label: 'CRP',    cls: 'bg-yellow-100 text-yellow-800' },
  MUTUAL_FUND: { label: 'MF',     cls: 'bg-cyan-100 text-cyan-800' },
};

const ALL_CLASSES: Array<{ value: AssetClass | 'ALL'; label: string }> = [
  { value: 'ALL',     label: 'All' },
  { value: 'EQUITY',  label: 'Equity' },
  { value: 'ETF',     label: 'ETF' },
  { value: 'FUTURE',  label: 'Futures' },
  { value: 'FX',      label: 'FX' },
];

// Pulse animation for the live indicator dot
const pulseDot = 'inline-block h-2 w-2 rounded-full bg-green-500 animate-pulse mr-2';

function formatVolume(v: number | null | undefined): string {
  if (v == null) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toString();
}

function formatTime(d: Date | null): string {
  if (!d) return '';
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function StockCard({
  stock,
  quote,
  loading,
}: {
  stock: HotStock;
  quote?: StockQuote;
  loading: boolean;
}) {
  // No data yet — render a skeleton
  if (!quote) {
    return (
      <div className="card animate-pulse p-6">
        <div className="h-6 w-20 rounded bg-slate-200 mb-2" />
        <div className="h-4 w-32 rounded bg-slate-100 mb-6" />
        <div className="h-10 w-40 rounded bg-slate-200 mb-4" />
        <div className="h-6 w-28 rounded bg-slate-100" />
      </div>
    );
  }

  const changeAbs = (quote.current_price ?? 0) - (quote.previous_close ?? quote.current_price ?? 0);
  const changePct = quote.change_pct ?? 0;
  const isUp = changePct >= 0;
  const assetBadge = ASSET_CLASS_BADGE[stock.asset_class];

  return (
    <div
      className={`card relative overflow-hidden p-6 transition-all ${
        loading ? 'opacity-60' : 'opacity-100'
      }`}
    >
      {/* Background pulse for big moves (|change| > 2%) */}
      {Math.abs(changePct) > 2 && (
        <div
          className={`absolute inset-0 opacity-10 ${
            isUp ? 'bg-green-500' : 'bg-red-500'
          }`}
        />
      )}

      <div className="relative">
        <div className="flex items-start justify-between mb-2">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-3xl font-bold tracking-tight text-slate-900">
                {stock.ticker}
              </h2>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${assetBadge.cls}`}>
                {assetBadge.label}
              </span>
            </div>
            <p className="text-sm text-slate-500">{stock.name}</p>
            <p className="text-xs text-slate-400">{stock.sector}</p>
          </div>
          {isUp ? (
            <TrendingUp className="h-6 w-6 text-green-500" />
          ) : (
            <TrendingDown className="h-6 w-6 text-red-500" />
          )}
        </div>

        <div className="my-4">
          <div className="text-5xl font-bold tabular-nums text-slate-900">
            ${(quote.current_price ?? 0).toFixed(2)}
          </div>
        </div>

        <div className={`text-lg font-semibold ${isUp ? 'text-green-600' : 'text-red-600'}`}>
          {isUp ? '▲' : '▼'} {isUp ? '+' : ''}
          {changeAbs.toFixed(2)} ({isUp ? '+' : ''}
          {changePct.toFixed(2)}%)
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3 text-xs text-slate-600">
          <div>
            <div className="text-slate-400">Day range</div>
            <div className="font-mono">
              {quote.day_low != null ? `$${quote.day_low.toFixed(2)}` : '—'}
              {' – '}
              {quote.day_high != null ? `$${quote.day_high.toFixed(2)}` : '—'}
            </div>
          </div>
          <div className="text-right">
            <div className="text-slate-400">Volume</div>
            <div className="font-mono">{formatVolume(quote.volume)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function HotStocksPage() {
  const [filter, setFilter] = useState<AssetClass | 'ALL'>('ALL');
  const visible = filter === 'ALL' ? HOT_STOCKS : HOT_STOCKS.filter((s) => s.asset_class === filter);
  const tickers = visible.map((s) => s.ticker);
  const { quotes, loading, refreshing, lastUpdated, refresh } = useLivePrices(tickers, 60_000);

  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-2 flex items-center gap-3">
        <Flame className="h-7 w-7 text-orange-500" />
        <h1 className="text-3xl font-bold text-slate-900">Hot Stocks</h1>
        <span className={pulseDot} />
        <span className="text-xs uppercase tracking-wider text-slate-500">Live</span>
      </div>
      <div className="mb-4 flex items-center justify-between text-sm text-slate-600">
        <p>
          Real-time prices from <span className="font-semibold">Bloomberg</span> via the
          market-data Edge Function.
        </p>
        <div className="flex items-center gap-3">
          {refreshing && (
            <span className="flex items-center gap-1 text-xs text-slate-400">
              <RefreshCw className="h-3 w-3 animate-spin" />
              Refreshing...
            </span>
          )}
          {lastUpdated && (
            <span className="text-xs text-slate-400">
              Updated {formatTime(lastUpdated)}
            </span>
          )}
          <button
            onClick={refresh}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            title="Refresh now"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Asset-class filter */}
      <div className="mb-6 flex flex-wrap gap-2">
        {ALL_CLASSES.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setFilter(opt.value)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              filter === opt.value
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* The cards */}
      {visible.length === 0 ? (
        <div className="card text-center text-sm text-slate-500">
          No hot stocks in this asset class.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {visible.map((stock) => (
            <StockCard
              key={stock.ticker}
              stock={stock}
              quote={quotes[stock.ticker]}
              loading={loading}
            />
          ))}
        </div>
      )}

      {/* Footer with activity hint */}
      <div className="mt-6 flex items-center gap-2 text-xs text-slate-400">
        <Activity className="h-3 w-3" />
        <span>
          Auto-refreshes every 60s. Background tint pulses on moves greater than ±2%.
        </span>
      </div>
    </div>
  );
}
