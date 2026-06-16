// AIChatPage - Natural language trade commands with live market data
import { useState } from 'react';
import { Send, Sparkles, CheckCircle, XCircle, AlertCircle, TrendingUp, TrendingDown } from 'lucide-react';
import { callAI } from '@/lib/supabase';
import {
  getPortfolios,
  getPositions,
  executeTrade,
  type Portfolio,
  type Position,
} from '@/services/db';

type Action = 'BUY' | 'SELL' | 'CLOSE' | 'SHORT' | 'COVER';
type Direction = 'LONG' | 'SHORT';

interface ParsedCommand {
  portfolio_id: string | null;
  portfolio_name: string | null;
  action: Action;
  direction: Direction;
  ticker: string | null;
  qty: number | string | null;
  price_type: string;
  limit_price: number | null;
  stop_loss_pct: number | null;
  confidence: number;
  needs_confirmation: boolean;
  explanation: string;
  original_command: string;
  // Added by ai-service after market lookup (see supabase/functions/ai-service/index.ts)
  market_price?: number | null;
  market_change_pct?: number | null;
  market_context?: string;
  resolved_price?: number | null;
  from_cache?: boolean | null;
  // Historical-date support: when the user references a past date ("3 days ago",
  // "yesterday", "on 2026-06-01"), ai-service returns the close price from that
  // date and flags is_historical=true.
  trade_date?: string | null;
  is_historical?: boolean;
  // Intraday time-of-day: "at the open" / "this morning" / "at close" etc.
  time_of_day?: 'pre' | 'open' | 'regular' | 'close' | 'post' | 'eod' | null;
  // Notional (USD) when the user spoke in dollars ($50k, $25,000 worth).
  // Resolved to qty at execute time by executeTrade(), NOT by the LLM.
  notional?: number | null;
  // Informational only — the system computes the real qty at click time.
  preview_qty?: number | null;
}

const ACTION_BADGE: Record<Action, { label: string; cls: string }> = {
  BUY:   { label: 'BUY',   cls: 'bg-green-100 text-green-800' },
  SELL:  { label: 'SELL',  cls: 'bg-red-100 text-red-800' },
  CLOSE: { label: 'CLOSE', cls: 'bg-slate-200 text-slate-800' },
  SHORT: { label: 'SHORT', cls: 'bg-purple-100 text-purple-800' },
  COVER: { label: 'COVER', cls: 'bg-indigo-100 text-indigo-800' },
};

export function AIChatPage() {
  const [input, setInput] = useState('');
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [selectedPortfolio, setSelectedPortfolio] = useState<string>('');
  const [parsed, setParsed] = useState<ParsedCommand | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  // Load portfolios on mount
  useState(() => {
    getPortfolios().then((data) => {
      setPortfolios(data);
      if (data.length > 0) setSelectedPortfolio(data[0].id);
    });
  });

  const handleParse = async () => {
    if (!input.trim()) return;
    setLoading(true);
    setMessage(null);
    setParsed(null);
    try {
      const result = await callAI('parse', { command: input });
      setParsed(result);

      // Auto-select portfolio if mentioned
      if (result.portfolio_id) {
        setSelectedPortfolio(result.portfolio_id);
      } else if (result.portfolio_name) {
        const match = portfolios.find(
          (p) => p.name.toLowerCase() === result.portfolio_name?.toLowerCase()
        );
        if (match) setSelectedPortfolio(match.id);
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleExecute = async () => {
    if (!parsed || !selectedPortfolio) return;
    setExecuting(true);
    setMessage(null);
    try {
      // Resolve quantity from the parsed result. ALL / HALF require
      // a position lookup. The system — not the LLM — turns notional
      // into qty at execute time (via executeTrade).
      let qty: number | null = null;
      if (typeof parsed.qty === 'string') {
        if (parsed.qty === 'ALL' || parsed.qty === 'HALF') {
          const positions = await getPositions(selectedPortfolio);
          const pos = positions.find((p: Position) => p.ticker === parsed.ticker);
          if (!pos) {
            throw new Error(`No position in ${parsed.ticker}`);
          }
          qty = parsed.qty === 'ALL' ? Math.abs(pos.qty) : Math.floor(Math.abs(pos.qty) / 2);
        } else {
          qty = parseFloat(parsed.qty as string);
        }
      } else if (typeof parsed.qty === 'number' && parsed.qty > 0) {
        qty = parsed.qty;
      }

      if (!parsed.ticker) throw new Error('No ticker specified');

      // Side & direction. The action verb is the source of truth —
      // BUY -> (BUY, LONG), SELL/CLOSE -> (SELL, LONG),
      // SHORT -> (SELL, SHORT), COVER -> (BUY, SHORT).
      const side: 'BUY' | 'SELL' =
        parsed.action === 'BUY' || parsed.action === 'COVER' ? 'BUY' : 'SELL';
      const direction: 'LONG' | 'SHORT' =
        parsed.action === 'SHORT' || parsed.action === 'COVER' ? 'SHORT' : 'LONG';

      // Price priority: user's limit_price -> backend's resolved_price -> backend's market_price.
      let price: number | null = null;
      if (parsed.limit_price != null && parsed.limit_price > 0) {
        price = parsed.limit_price;
      } else if (parsed.resolved_price != null && parsed.resolved_price > 0) {
        price = parsed.resolved_price;
      } else if (parsed.market_price != null && parsed.market_price > 0) {
        price = parsed.market_price;
      }

      if (price == null && parsed.notional == null) {
        throw new Error(
          'No market price available for ' + (parsed.ticker || 'this ticker') +
          '. The AI could not fetch a live or historical price. ' +
          'Please specify a limit price or try again when market data is available.'
        );
      }

      // Calculate stop price
      let stopPrice: number | undefined;
      if (parsed.stop_loss_pct && price != null) {
        stopPrice = price * (1 - parsed.stop_loss_pct / 100);
      }

      const executedAt = buildExecutedAt(parsed.trade_date, parsed.time_of_day);

      await executeTrade({
        portfolio_id: selectedPortfolio,
        ticker: parsed.ticker,
        side,
        direction,
        qty: qty, // may be null when notional is provided; executeTrade resolves
        notional: parsed.notional ?? null,
        price: price,
        stop_price: stopPrice,
        notes: `AI: ${parsed.original_command}`,
        executed_at: executedAt,
      });

      const finalQty = qty ?? (parsed.preview_qty ?? 0);
      const priceLabel = parsed.is_historical && parsed.trade_date
        ? `(close on ${parsed.trade_date}${parsed.time_of_day ? ` ${parsed.time_of_day}` : ''})`
        : '(market)';

      setMessage({
        type: 'success',
        text: `Executed ${parsed.action} ${finalQty} ${parsed.ticker} at $${(price ?? 0).toFixed(2)} ${priceLabel}`,
      });
      setInput('');
      setParsed(null);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setExecuting(false);
    }
  };

  const exampleCommands = [
    'Buy 100 AAPL at market',
    'In Aggressive Growth, buy 200 TSLA with 7% stop',
    'Short 50 NVDA at market',
    'Cover half my NVDA short',
    'Buy 10 NVDA 3 days ago',
    'Buy 1 million of NVDA',
    'Buy $50,000 of AAPL at the open',
  ];

  const changePct = parsed?.market_change_pct;
  const isUp = changePct != null && changePct >= 0;

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
          <Sparkles className="h-7 w-7 text-primary-600" />
          AI Trading Assistant
        </h1>
        <p className="mt-1 text-slate-600">
          Type natural language trade commands and the AI will parse and execute them
        </p>
      </div>

      <div className="card mb-6">
        <label className="label">Your command</label>
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleParse()}
            placeholder="e.g. Buy 200 AAPL at market with 7% stop, or Short 50 NVDA"
            className="input flex-1"
            disabled={loading}
          />
          <button onClick={handleParse} disabled={loading || !input.trim()} className="btn-primary">
            <Send className="h-4 w-4" />
            {loading ? 'Parsing...' : 'Parse'}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <span className="text-xs text-slate-500">Try:</span>
          {exampleCommands.map((cmd, i) => (
            <button
              key={i}
              onClick={() => setInput(cmd)}
              className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 hover:bg-slate-200"
            >
              {cmd}
            </button>
          ))}
        </div>
      </div>

      {parsed && (
        <div className="card mb-6">
          <h2 className="mb-3 text-lg font-semibold">Parsed Command</h2>
          <div className="rounded-md bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-700">{parsed.explanation}</p>

            {/* Action + direction badges */}
            <div className="mt-2 flex items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-xs font-semibold ${ACTION_BADGE[parsed.action].cls}`}>
                {ACTION_BADGE[parsed.action].label}
              </span>
              <span className={`rounded px-2 py-0.5 text-[10px] font-medium uppercase ${
                parsed.direction === 'SHORT'
                  ? 'bg-purple-50 text-purple-700 ring-1 ring-purple-200'
                  : 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
              }`}>
                {parsed.direction}
              </span>
            </div>

            {/* Market data panel: blue for live, amber for historical */}
            {parsed.market_price != null && (
              <div
                className={`mt-3 flex items-center gap-3 rounded-md border px-3 py-2 ${
                  parsed.is_historical
                    ? 'border-amber-200 bg-amber-50'
                    : 'border-blue-200 bg-blue-50'
                }`}
              >
                <span
                  className={`text-xs font-semibold uppercase ${
                    parsed.is_historical ? 'text-amber-700' : 'text-blue-700'
                  }`}
                >
                  {parsed.is_historical && parsed.trade_date
                    ? `Historical · ${parsed.trade_date}`
                    : 'Live Market'}
                </span>
                <span className="text-lg font-bold text-slate-900">
                  ${parsed.market_price.toFixed(2)}
                </span>
                {!parsed.is_historical && changePct != null && (
                  <span
                    className={`flex items-center gap-1 text-sm font-medium ${
                      isUp ? 'text-green-600' : 'text-red-600'
                    }`}
                  >
                    {isUp ? (
                      <TrendingUp className="h-3.5 w-3.5" />
                    ) : (
                      <TrendingDown className="h-3.5 w-3.5" />
                    )}
                    {isUp ? '+' : ''}
                    {changePct.toFixed(2)}%
                  </span>
                )}
                {parsed.resolved_price != null && parsed.resolved_price !== parsed.market_price && (
                  <span className="ml-auto text-xs text-slate-600">
                    Will execute at <strong>${parsed.resolved_price.toFixed(2)}</strong>
                    {parsed.limit_price
                      ? ' (your limit)'
                      : parsed.is_historical
                      ? ' (historical close)'
                      : ' (market)'}
                  </span>
                )}
                {parsed.from_cache && (
                  <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] uppercase text-slate-600">
                    cached
                  </span>
                )}
              </div>
            )}

            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-slate-500">Ticker:</span>{' '}
                <span className="font-medium">{parsed.ticker || 'Not detected'}</span>
              </div>
              <div>
                <span className="text-slate-500">Quantity:</span>{' '}
                <span className="font-medium">
                  {parsed.qty?.toString() || (parsed.notional != null ? `Notional $${parsed.notional.toLocaleString()}` : 'Not specified')}
                </span>
                {parsed.preview_qty != null && parsed.notional != null && (
                  <span className="ml-2 text-xs text-slate-500">
                    (preview ≈{parsed.preview_qty.toLocaleString()} sh)
                  </span>
                )}
              </div>
              <div>
                <span className="text-slate-500">Stop Loss:</span>{' '}
                <span className="font-medium">
                  {parsed.stop_loss_pct ? `${parsed.stop_loss_pct}%` : 'None'}
                </span>
              </div>
              <div>
                <span className="text-slate-500">Confidence:</span>{' '}
                <span className="font-medium">{Math.round(parsed.confidence * 100)}%</span>
              </div>
              <div>
                <span className="text-slate-500">Type:</span>{' '}
                <span className="font-medium">{parsed.price_type}</span>
              </div>
              <div>
                <span className="text-slate-500">Trade Date:</span>{' '}
                <span className="font-medium">
                  {parsed.trade_date
                    ? `${parsed.trade_date}${parsed.time_of_day ? ` (${parsed.time_of_day})` : ''}`
                    : 'Now'}
                </span>
              </div>
              {parsed.notional != null && (
                <div>
                  <span className="text-slate-500">Notional:</span>{' '}
                  <span className="font-medium">${parsed.notional.toLocaleString()}</span>
                </div>
              )}
            </div>
          </div>

          <div className="mt-4">
            <label className="label">Target portfolio</label>
            <select
              value={selectedPortfolio}
              onChange={(e) => setSelectedPortfolio(e.target.value)}
              className="input mt-1"
            >
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              onClick={handleExecute}
              disabled={
                executing ||
                !selectedPortfolio ||
                !(
                  (parsed.resolved_price != null && parsed.resolved_price > 0) ||
                  (parsed.limit_price != null && parsed.limit_price > 0) ||
                  (parsed.market_price != null && parsed.market_price > 0) ||
                  parsed.notional != null
                )
              }
              className="btn-primary flex items-center gap-2"
            >
              <CheckCircle className="h-4 w-4" />
              {executing ? 'Executing...' : 'Execute Trade'}
            </button>
            <button onClick={() => setParsed(null)} className="btn-secondary">
              <XCircle className="h-4 w-4" />
              Cancel
            </button>
          </div>
        </div>
      )}

      {message && (
        <div
          className={`rounded-md p-3 text-sm ${
            message.type === 'success'
              ? 'bg-green-50 text-green-700'
              : message.type === 'error'
              ? 'bg-red-50 text-red-700'
              : 'bg-blue-50 text-blue-700'
          }`}
        >
          <div className="flex items-center gap-2">
            {message.type === 'success' ? <CheckCircle className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
            {message.text}
          </div>
        </div>
      )}

      <div className="card mt-6 bg-blue-50 border-blue-200">
        <h3 className="font-semibold text-blue-900">How it works</h3>
        <ul className="mt-2 space-y-1 text-sm text-blue-800">
          <li>• Type any trading command in plain English</li>
          <li>• The AI parses it into a structured trade (action, ticker, qty/notional, stop)</li>
          <li>• Real-time market price (or historical close for past dates) is fetched from Bloomberg and shown in the parsed panel</li>
          <li>• <strong>Notional trades</strong> ("$50k of AAPL") are resolved to share count at execute time using the freshest price — the system, not the AI, owns the math</li>
          <li>• <strong>Shorting</strong> is supported: try "short 50 NVDA" or "cover my TSLA short"</li>
          <li>• Review the parsed command, choose the target portfolio</li>
          <li>• Click Execute to add it to your paper trading account at the real market price</li>
        </ul>
      </div>
    </div>
  );
}

// Convert (trade_date, time_of_day) into an ISO timestamp.
// Returns undefined when no date was specified (DB defaults to NOW()).
function buildExecutedAt(
  tradeDate: string | null | undefined,
  timeOfDay: 'pre' | 'open' | 'regular' | 'close' | 'post' | 'eod' | null | undefined,
): string | undefined {
  if (!tradeDate) return undefined;
  const sessionHourUtc: Record<string, string> = {
    pre:     '13:00:00',
    open:    '13:30:00',
    regular: '18:00:00',
    close:   '20:00:00',
    eod:     '20:00:00',
    post:    '00:00:00',
  };
  const time = (timeOfDay && sessionHourUtc[timeOfDay]) || '20:00:00';
  let date = tradeDate;
  if (timeOfDay === 'post') {
    const d = new Date(`${tradeDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    date = d.toISOString().slice(0, 10);
  }
  return `${date}T${time}Z`;
}
