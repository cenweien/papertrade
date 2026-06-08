// AIChatPage - Natural language trade commands
import { useState } from 'react';
import { Send, Sparkles, CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { callAI } from '@/lib/supabase';
import {
  getPortfolios,
  getPositions,
  executeTrade,
  type Portfolio,
  type Position,
} from '@/services/db';

interface ParsedCommand {
  portfolio_id: string | null;
  portfolio_name: string | null;
  action: 'BUY' | 'SELL' | 'CLOSE';
  ticker: string | null;
  qty: number | string | null;
  price_type: string;
  limit_price: number | null;
  stop_loss_pct: number | null;
  confidence: number;
  needs_confirmation: boolean;
  explanation: string;
  original_command: string;
}

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
      // Resolve quantity
      let qty: number;
      if (typeof parsed.qty === 'string') {
        if (parsed.qty === 'ALL' || parsed.qty === 'HALF') {
          const positions = await getPositions(selectedPortfolio);
          const pos = positions.find((p: Position) => p.ticker === parsed.ticker);
          if (!pos) {
            throw new Error(`No position in ${parsed.ticker}`);
          }
          qty = parsed.qty === 'ALL' ? pos.qty : Math.floor(pos.qty / 2);
        } else {
          qty = parseFloat(parsed.qty as string);
        }
      } else {
        qty = parsed.qty || 0;
      }

      if (!qty || qty <= 0) throw new Error('Invalid quantity');
      if (!parsed.ticker) throw new Error('No ticker specified');

      // For AI, we need a price. Use a placeholder - in production, fetch from price service
      // For paper trading demo, use $100 as default price
      const price = parsed.limit_price || 100;

      // Calculate stop price
      let stopPrice: number | undefined;
      if (parsed.stop_loss_pct) {
        stopPrice = price * (1 - parsed.stop_loss_pct / 100);
      }

      await executeTrade({
        portfolio_id: selectedPortfolio,
        ticker: parsed.ticker,
        side: parsed.action === 'CLOSE' ? 'SELL' : (parsed.action as 'BUY' | 'SELL'),
        qty,
        price,
        stop_price: stopPrice,
        notes: `AI: ${parsed.original_command}`,
      });

      setMessage({
        type: 'success',
        text: `Executed ${parsed.action} ${qty} ${parsed.ticker} at $${price}`,
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
    'Sell half my NVDA position',
    'Close my entire AAPL trade',
  ];

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
            placeholder="e.g. Buy 200 AAPL at market with 7% stop"
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
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-slate-500">Action:</span>{' '}
                <span className="font-medium">{parsed.action}</span>
              </div>
              <div>
                <span className="text-slate-500">Ticker:</span>{' '}
                <span className="font-medium">{parsed.ticker || 'Not detected'}</span>
              </div>
              <div>
                <span className="text-slate-500">Quantity:</span>{' '}
                <span className="font-medium">{parsed.qty?.toString() || 'Not specified'}</span>
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
              disabled={executing || !selectedPortfolio}
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
          <li>• The AI parses it into a structured trade (action, ticker, qty, stop)</li>
          <li>• Review the parsed command, choose the target portfolio</li>
          <li>• Click Execute to add it to your paper trading account</li>
          <li>• Note: AI uses $100 default price for paper trading. Use Manual Trade for real prices.</li>
        </ul>
      </div>
    </div>
  );
}