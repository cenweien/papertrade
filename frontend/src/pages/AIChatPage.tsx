// AIChatPage - Natural language trade commands with live market data
import { useState } from 'react';
import { Send, Sparkles, CheckCircle, XCircle, AlertCircle, TrendingUp, TrendingDown } from 'lucide-react';
import { callAI, supabase, supabaseUrl, supabaseAnonKey } from '@/lib/supabase';
import {
  ensureDefaultPortfolio,
  getPositions,
  getCachedQuote,
  executeTrade,
  computePortfolioEquity,
  type Portfolio,
  type Position,
} from '@/services/db';

type Action = 'BUY' | 'SELL' | 'CLOSE' | 'SHORT' | 'COVER';
type Direction = 'LONG' | 'SHORT';

// One leg of a multi-ticker trade (e.g. "buy 100 AAPL and 50 MSFT"
// has 2 legs). The system fills `market_price` / `resolved_price`
// per leg; the frontend shows them as separate trade cards.
interface ParsedLeg {
  // Per-leg action verb (BUY / SELL / SHORT / etc.). Populated by
  // the server directly from the LLM's per-leg output, with a
  // server-side inferLegAction fallback. This is the source of
  // truth for mixed-verb commands ("buy A and short B" -> leg A=BUY,
  // leg B=SHORT).
  action: Action;
  direction: Direction;
  ticker: string;
  qty: number | string | null;
  notional: number | null;
  // How the user sized this leg. Default 'USD' means the explicit
  // dollar amount in `notional` is authoritative. PCT_* and
  // FRACTION_* mean the system will compute the dollar amount at
  // execute time using the live portfolio state (cash + positions).
  notional_basis?: 'USD' | 'PCT_PORTFOLIO' | 'PCT_CASH' | 'FRACTION_PORTFOLIO' | 'FRACTION_CASH';
  // 0-100 when basis is PCT_*. Null otherwise.
  notional_pct?: number | null;
  // 0-1 when basis is FRACTION_*. Null otherwise.
  notional_fraction?: number | null;
  price_type: string;
  limit_price: number | null;
  stop_loss_pct: number | null;
  // Per-leg temporal data. The server infers these from the chunk
  // of the original command closest to this ticker. A single command
  // can have different dates per leg.
  trade_date: string | null;
  time_of_day: 'pre' | 'open' | 'regular' | 'close' | 'post' | 'eod' | null;
  // Market data filled in by the server after fetching from
  // bloomberg-service.
  market_price: number | null;
  market_change_pct?: number | null;
  resolved_price: number | null;
  // floor(notional / resolved_price) for notional-based legs. Lets
  // the UI seed the qty input immediately instead of leaving it blank
  // when the user spoke in USD. Null when qty was given explicitly or
  // the system doesn't yet have a price.
  preview_qty?: number | null;
  price_unavailable_reason: string | null;
  ticker_suggestion: string | null;
  company_name: string | null;
  sector: string | null;
  from_cache: boolean | null;
}

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
  // Mirror of legs[0].notional_basis — how the primary leg was sized.
  // See ParsedLeg docs above.
  notional_basis?: 'USD' | 'PCT_PORTFOLIO' | 'PCT_CASH' | 'FRACTION_PORTFOLIO' | 'FRACTION_CASH';
  notional_pct?: number | null;
  notional_fraction?: number | null;
  // Informational only — the system computes the real qty at click time.
  preview_qty?: number | null;
  // Multi-leg support. ALWAYS present, with >= 1 element. Single-
  // ticker commands produce a 1-element array. The flat fields above
  // mirror `legs[0]` for back-compat with code that hasn't migrated
  // to the per-leg API yet.
  legs: ParsedLeg[];
  // Server-side Levenshtein correction. If the user typed a typo
  // (e.g. "APPL") and a known-ticker close match was found ("AAPL"),
  // this field is set so the UI can show "Did you mean AAPL?".
  ticker_suggestion?: string | null;
  // Why no market price is available for the primary ticker. Set
  // by the server when bloomberg has no data. Surfaced in the UI
  // as an amber chip so the user knows why the price is missing.
  price_unavailable_reason?: string | null;
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
  // Per-leg inline edits. Keyed by leg index (stable across refetches).
  // Lets the user click the ticker or quantity box in the parsed card
  // and retype it before executing. After blur we re-parse the command
  // (substituting the edits back in) so the market price refreshes.
  const [legEdits, setLegEdits] = useState<Record<number, { ticker: string; qty: string }>>({});
  // True when a refetch is in flight after an inline edit. The leg
  // cards show a subtle spinner so the user knows the price is being
  // re-quoted (and so the box doesn't appear "stuck" on a stale price).
  const [refetchingLegs, setRefetchingLegs] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  // Load portfolios on mount (auto-creates a $100M default if none)
  useState(() => {
    ensureDefaultPortfolio().then((data) => {
      setPortfolios(data);
      if (data.length > 0) setSelectedPortfolio(data[0].id);
    });
  });

  const handleParse = async () => {
    if (!input.trim()) return;
    setLoading(true);
    setMessage(null);
    setParsed(null);
    setLegEdits({});
    try {
      const result = await callAI('parse', { command: input });
      setParsed(result);

      // Auto-select portfolio if mentioned — must run BEFORE the
      // basis-preview equity fetch below, so a parse like "in
      // Aggressive Growth, spend 10% of my portfolio on AAPL"
      // computes the preview against the newly-selected portfolio
      // rather than the previously-active one.
      if (result.portfolio_id) {
        setSelectedPortfolio(result.portfolio_id);
      } else if (result.portfolio_name) {
        const match = portfolios.find(
          (p) => p.name.toLowerCase() === result.portfolio_name?.toLowerCase(),
        );
        if (match) setSelectedPortfolio(match.id);
      }

      // For percentage / fraction sized legs ("spend 10% of my
      // portfolio on AAPL", "half on NVDA"), the server returns
      // `notional_basis` + `notional_pct`/`notional_fraction` but
      // can't seed a share count — the basis resolves against the
      // target portfolio's live equity, which the server doesn't
      // know. Fetch the portfolio state here so we can show a
      // preview qty in the qty box before the user clicks Execute.
      let basisPreview: { cash: number; equity: number } | null = null;
      const needsBasis = (result.legs ?? []).some(
        (l: ParsedLeg) =>
          (l.notional_basis ?? 'USD') !== 'USD' && (l.qty == null || l.qty === ''),
      );
      const targetPortfolioId =
        result.portfolio_id || selectedPortfolio || portfolios[0]?.id || '';
      if (needsBasis && targetPortfolioId) {
        try {
          const eq = await computePortfolioEquity(targetPortfolioId);
          basisPreview = { cash: eq.cash, equity: eq.equity };
        } catch (err) {
          // Non-fatal — the qty box will just stay empty. The system
          // still resolves the basis at execute time.
          console.warn('basis-preview equity fetch failed:', err);
        }
      }

      // Seed inline-editable values for each leg. Keyed by leg INDEX
      // (not ticker) so the edits survive a re-parse even if the
      // ticker text changes.
      const seeds: Record<number, { ticker: string; qty: string }> = {};
      const legList: ParsedLeg[] =
        result.legs && result.legs.length > 0
          ? result.legs
          : result.ticker
          ? [{ ...(result as unknown as ParsedLeg), ticker: result.ticker }]
          : [];
      legList.forEach((l, i) => {
        // Priority for the qty box:
        //   1. LLM-supplied explicit qty (e.g. "buy 100 AAPL").
        //   2. Server-computed preview_qty for USD notional legs
        //      (e.g. "$1M of NVDA" → floor(1_000_000 / $204.65) ≈ 4886).
        //   3. Client-computed basis preview for PCT / FRACTION legs
        //      using the live portfolio equity + the leg's resolved
        //      price. ("spend 10% of my portfolio on AAPL" → qty ≈
        //      floor(equity * 0.10 / AAPL_price).)
        //   4. Empty — the user will fill it in, or the system will
        //      fail at execute time with a clear "Quantity required"
        //      error.
        let qtySeed = '';
        if (l.qty != null && l.qty !== '') {
          qtySeed = String(l.qty);
        } else if (l.preview_qty != null && l.preview_qty > 0) {
          qtySeed = String(l.preview_qty);
        } else if (
          basisPreview != null &&
          (l.notional_basis ?? 'USD') !== 'USD' &&
          l.resolved_price != null &&
          l.resolved_price > 0
        ) {
          const previewNotional = notionalFromBasis(
            l,
            basisPreview.cash,
            basisPreview.equity,
          );
          if (previewNotional != null && previewNotional > 0) {
            qtySeed = String(Math.floor(previewNotional / l.resolved_price));
          }
        }
        seeds[i] = {
          ticker: (l.ticker ?? '').toString().toUpperCase(),
          qty: qtySeed,
        };
      });
      setLegEdits(seeds);
      setRefetchingLegs(new Set());
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  // Re-quote a leg after the user edits its ticker or quantity.
  // Two-step fetch:
  //   1. Cache hit (instrument_prices, <10 min old) — returns
  //      immediately, ~50-100ms.
  //   2. Cache miss — POSTs to `market-data/refresh?ticker=...`,
  //      which calls bloomberg-service and writes the result back
  //      to the cache. Typically 300-800ms; capped at 8s.
  // Either way the user sees a fresh price after one click-out.
  // No LLM involved, no Parse round-trip.
  const refetchLeg = async (legIndex: number) => {
    if (!parsed) return;
    const edit = legEdits[legIndex];
    if (!edit) return;
    const newTicker = (edit.ticker ?? '').trim();
    if (!newTicker) return;
    setRefetchingLegs((prev) => new Set(prev).add(legIndex));
    try {
      // 1. Try the cache first. Avoids hitting bloomberg for tickers
      //    we already have a fresh quote for.
      const cached = await getCachedQuote(newTicker);
      const fetched = await (async (): Promise<
        | {
            current_price: number;
            change_pct: number | null;
            company_name: string | null;
            from_cache: boolean;
          }
        | { error: string }
      > => {
        if (cached) {
          return {
            current_price: cached.current_price,
            change_pct: cached.change_pct,
            company_name: cached.company_name,
            from_cache: cached.from_cache,
          };
        }
        // 2. Force a fresh refresh. market-data/refresh proxies to
        //    the bloomberg-service relay and returns the merged row
        //    that was just written to instrument_prices.
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return { error: 'Not authenticated' };
        const res = await fetch(
          `${supabaseUrl}/functions/v1/market-data/refresh?ticker=${encodeURIComponent(newTicker)}`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${session.access_token}`,
              'apikey': supabaseAnonKey,
            },
            signal: AbortSignal.timeout(8_000),
          },
        );
        const raw = await res.text();
        let body: any = null;
        if (raw) {
          try { body = JSON.parse(raw); } catch { /* fall through */ }
        }
        if (!res.ok || body?.success === false) {
          // 404 means bloomberg has no data (unknown symbol).
          // Distinguishes that from a network error so the UI can
          // show a useful "unknown symbol" message.
          const reason =
            res.status === 404
              ? `No data for ${newTicker} (unknown symbol?)`
              : body?.error || body?.msg || `Quote failed (${res.status})`;
          return { error: reason };
        }
        const d = body?.data;
        if (d && typeof d.current_price === 'number') {
          return {
            current_price: d.current_price,
            change_pct: d.change_pct ?? null,
            company_name: d.company_name ?? null,
            from_cache: body?.from_cache ?? false,
          };
        }
        return { error: `Refresh returned no price for ${newTicker}` };
      })();
      setParsed((prev) => {
        if (!prev) return prev;
        const legPatch: Partial<ParsedLeg> = 'error' in fetched
          ? {
              // The user just typed a new ticker — commit it to the
              // leg so the badge text, the unrecognised check, and
              // the execute path all use the new symbol. Otherwise
              // a 3-leg command like "buy TSLA, short NVDA, short
              // MU" → change MU to SNDK would leave the badge
              // stuck on "MU" even though the price refreshed.
              ticker: newTicker,
              market_price: null,
              market_change_pct: null,
              resolved_price: null,
              price_unavailable_reason: fetched.error,
              ticker_suggestion: null,
              company_name: null,
              from_cache: null,
            }
          : {
              ticker: newTicker,
              market_price: fetched.current_price,
              market_change_pct: fetched.change_pct,
              resolved_price: fetched.current_price,
              price_unavailable_reason: null,
              company_name: fetched.company_name,
              from_cache: fetched.from_cache,
              ticker_suggestion: null,
            };
        const hasLegs = Array.isArray(prev.legs) && prev.legs.length > 0;
        if (hasLegs) {
          const nextLegs = prev.legs.map((l, i) =>
            i === legIndex ? { ...l, ...legPatch } : l,
          );
          return { ...prev, legs: nextLegs };
        }
        return { ...prev, ...legPatch } as ParsedCommand;
      });
    } catch (err: any) {
      setMessage({ type: 'error', text: `Refresh failed: ${err.message}` });
    } finally {
      setRefetchingLegs((prev) => {
        const next = new Set(prev);
        next.delete(legIndex);
        return next;
      });
    }
  };

  const handleExecute = async () => {
    if (!parsed || !selectedPortfolio) return;
    setExecuting(true);
    setMessage(null);
    try {
      // The server now always populates `legs` (>= 1 element), even
      // for single-ticker commands. So the multi-leg path is the
      // default. The single-ticker shortcut at the end of this
      // function is kept as a back-compat path for any old cached
      // response that still lacks legs.
      const legsToExecute: ParsedLeg[] =
        parsed.legs && parsed.legs.length > 0
          ? parsed.legs
          : parsed.ticker
          ? [{
              action: parsed.action,
              direction: parsed.direction,
              ticker: parsed.ticker,
              qty: parsed.qty,
              notional: parsed.notional ?? null,
              price_type: parsed.price_type,
              limit_price: parsed.limit_price,
              stop_loss_pct: parsed.stop_loss_pct,
              trade_date: parsed.trade_date ?? null,
              time_of_day: parsed.time_of_day ?? null,
              market_price: parsed.market_price ?? null,
              market_change_pct: parsed.market_change_pct ?? null,
              resolved_price: parsed.resolved_price ?? null,
              price_unavailable_reason: parsed.price_unavailable_reason ?? null,
              ticker_suggestion: parsed.ticker_suggestion ?? null,
              company_name: null,
              sector: null,
              from_cache: parsed.from_cache ?? null,
            }]
          : [];

      if (legsToExecute.length === 0) {
        throw new Error('No ticker specified');
      }

      // Execute each leg sequentially. We fail-fast on the first
      // error so a partially-successful batch doesn't leave the user
      // confused about which trades actually landed.
      for (let i = 0; i < legsToExecute.length; i++) {
        const leg = legsToExecute[i];
        // Apply inline edits to ticker + qty before sending to the
        // server. The user may have corrected an OCR'd ticker or
        // retype'd the share count after the AI parsed it.
        const edit = legEdits[i];
        const editedLeg: ParsedLeg = {
          ...leg,
          ticker: edit?.ticker?.trim() || leg.ticker,
          qty: edit?.qty && edit.qty !== '' ? edit.qty : leg.qty,
        };
        await executeLeg(parsed, editedLeg, selectedPortfolio);
      }

      // Build a per-leg summary. Mixed-verb commands ("buy A and
      // short B") get one label per leg; uniform-verb commands get
      // a compact "Executed N BUY legs: A, B" message.
      const mixed = legsToExecute.some(
        (l) => (l.action ?? parsed.action) !== parsed.action,
      );
      const summary = mixed || legsToExecute.length > 1
        ? legsToExecute
            .map((l, i) => {
              const verb = l.action ?? parsed.action;
              const edit = legEdits[i];
              const ticker = edit?.ticker?.trim() || l.ticker;
              const qty = edit?.qty && edit.qty !== '' ? edit.qty : l.qty;
              const dateSuffix = l.trade_date ? ` (${l.trade_date})` : '';
              return `${verb} ${qty ?? ''} ${ticker}${dateSuffix}`.trim();
            })
            .join(' + ')
        : (() => {
            const i = 0;
            const edit = legEdits[i];
            const ticker = edit?.ticker?.trim() || legsToExecute[0].ticker;
            return `Executed ${parsed.action} ${ticker} at $${(legsToExecute[0].resolved_price ?? legsToExecute[0].market_price ?? 0).toFixed(2)}`;
          })();

      setMessage({
        type: 'success',
        text: summary,
      });
      setInput('');
      setParsed(null);
      setLegEdits({});
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
    'Spend 10% of my portfolio on AAPL',
    'Half on NVDA, half on TSLA',
    'Buy a quarter of MSFT',
    'Put 25% of my cash into AMD',
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

            {/* Multi-leg ticker suggestions: if ANY leg has a typo
                suggestion, show a "Did you mean X?" link per leg. */}
            {parsed.legs && parsed.legs.length > 0 && parsed.legs.some((l) => l.ticker_suggestion) && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertCircle className="h-4 w-4" />
                  Ticker typo detected
                </div>
                <ul className="mt-1 ml-6 list-disc space-y-0.5">
                  {parsed.legs
                    .filter((l) => l.ticker_suggestion)
                    .map((l) => (
                      <li key={l.ticker}>
                        You typed <code className="rounded bg-amber-100 px-1">{l.ticker}</code>,
                        did you mean <strong>{l.ticker_suggestion}</strong>?
                      </li>
                    ))}
                </ul>
              </div>
            )}

            {/* Single-ticker typo suggestion */}
            {(!parsed.legs || parsed.legs.length <= 1) &&
              parsed.ticker_suggestion && (
                <div className="mt-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <AlertCircle className="h-4 w-4" />
                  You typed <code className="rounded bg-amber-100 px-1 font-mono">{parsed.ticker}</code>,
                  did you mean <strong>{parsed.ticker_suggestion}</strong>?
                  <button
                    onClick={() => setInput(`Replace ${parsed.ticker} with ${parsed.ticker_suggestion}`)}
                    className="ml-auto rounded bg-amber-200 px-2 py-0.5 text-xs font-medium hover:bg-amber-300"
                  >
                    Use {parsed.ticker_suggestion}
                  </button>
                </div>
              )}

            {/* Per-leg cards: prominent BUY/SELL + editable ticker +
                editable share count + price. The historical-price
                blue/amber strip that used to live below was redundant
                with this card. Stop loss (when set) and trade date
                (when not "now") are shown as small chips. */}
            {parsed.legs && parsed.legs.length > 0 && (
              <div className="mt-3 space-y-2">
                {parsed.legs.map((leg, idx) => {
                  const legChange = leg.market_change_pct;
                  const legUp = legChange != null && legChange >= 0;
                  const legAction = leg.action ?? parsed.action;
                  const legDate = leg.trade_date ?? parsed.trade_date;
                  const legTod = leg.time_of_day ?? parsed.time_of_day;
                  const legIsHistorical =
                    legDate != null && legDate < new Date().toISOString().slice(0, 10);
                  const edit = legEdits[idx] ?? {
                    ticker: leg.ticker ?? '',
                    // Mirror the seed priority in handleParse: explicit
                    // qty > server preview_qty > blank.
                    qty:
                      leg.qty != null && leg.qty !== ''
                        ? String(leg.qty)
                        : leg.preview_qty != null && leg.preview_qty > 0
                        ? String(leg.preview_qty)
                        : '',
                  };
                  const updateEdit = (patch: Partial<{ ticker: string; qty: string }>) =>
                    setLegEdits((prev) => ({ ...prev, [idx]: { ...edit, ...patch } }));
                  const effectivePrice = leg.resolved_price ?? leg.market_price;
                  // "Unrecognised" = the server returned no price AND
                  // no fuzzy correction we could auto-apply. Either
                  // the user just typed a typo we can't fix, or the
                  // symbol isn't in Bloomberg. Either way, red border
                  // tells them Execute will fail for this leg.
                  const isUnrecognised =
                    effectivePrice == null &&
                    !leg.ticker_suggestion &&
                    (leg.price_unavailable_reason != null ||
                      (edit.ticker.trim() !== '' &&
                        edit.ticker.trim() !== (leg.ticker ?? '').trim()));
                  const isRefetching = refetchingLegs.has(idx);
                  return (
                    <div
                      key={idx}
                      className={`rounded-md border px-3 py-2 ${
                        legIsHistorical
                          ? 'border-amber-200 bg-amber-50'
                          : 'border-slate-200 bg-white'
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-3">
                        <span className={`rounded px-2 py-0.5 text-xs font-bold ${ACTION_BADGE[legAction].cls}`}>
                          {ACTION_BADGE[legAction].label}
                        </span>
                        <input
                          type="text"
                          value={edit.ticker}
                          onChange={(e) =>
                            updateEdit({ ticker: e.target.value.toUpperCase().replace(/[^A-Z0-9.\-^]/g, '') })
                          }
                          onBlur={() => {
                            const trimmed = edit.ticker.trim();
                            if (trimmed && trimmed !== (leg.ticker ?? '').trim()) {
                              refetchLeg(idx);
                            }
                          }}
                          className={`w-24 rounded border bg-white px-2 py-1 font-mono text-sm font-semibold uppercase text-slate-900 focus:outline-none ${
                            isUnrecognised
                              ? 'border-red-500 ring-1 ring-red-200 focus:border-red-500'
                              : 'border-slate-300 focus:border-primary-500'
                          }`}
                          aria-label="Ticker"
                          aria-invalid={isUnrecognised}
                        />
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-slate-500">×</span>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={edit.qty}
                            placeholder="qty"
                            onChange={(e) =>
                              updateEdit({ qty: e.target.value.replace(/[^0-9.]/g, '') })
                            }
                            onBlur={() => {
                              const trimmed = edit.qty.trim();
                              if (
                                trimmed !== '' &&
                                trimmed !== String(leg.qty ?? '')
                              ) {
                                refetchLeg(idx);
                              }
                            }}
                            className="w-20 rounded border border-slate-300 bg-white px-2 py-1 text-sm font-semibold text-slate-900 focus:border-primary-500 focus:outline-none"
                            aria-label="Shares"
                          />
                          <span className="text-xs text-slate-500">sh</span>
                        </div>
                        {effectivePrice != null ? (
                          <div className="flex items-baseline gap-1">
                            <span className="text-xs text-slate-500">@</span>
                            <span className="text-lg font-bold text-slate-900">
                              ${effectivePrice.toFixed(2)}
                            </span>
                            {!legIsHistorical && legChange != null && (
                              <span
                                className={`flex items-center gap-0.5 text-xs font-medium ${
                                  legUp ? 'text-green-600' : 'text-red-600'
                                }`}
                              >
                                {legUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                                {legUp ? '+' : ''}
                                {legChange.toFixed(2)}%
                              </span>
                            )}
                          </div>
                        ) : isRefetching ? (
                          <span className="text-xs text-slate-500">Quoting…</span>
                        ) : (
                          <span className="text-xs text-red-600">No price</span>
                        )}
                        {edit.qty && effectivePrice != null && (
                          <span className="ml-auto text-xs font-medium text-slate-600">
                            ≈ ${(Number(edit.qty) * effectivePrice).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </span>
                        )}
                      </div>
                      {/* Secondary chips: stop loss, limit type, trade
                          date — only shown when present. */}
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-600">
                        {leg.price_type && leg.price_type !== 'MARKET' && (
                          <span className="rounded bg-slate-200 px-1.5 py-0.5 font-mono uppercase">
                            {leg.price_type}
                            {leg.limit_price != null ? ` $${leg.limit_price.toFixed(2)}` : ''}
                          </span>
                        )}
                        {leg.stop_loss_pct != null && (
                          <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700">
                            -{leg.stop_loss_pct}% stop
                          </span>
                        )}
                        {legDate && (
                          <span className={legIsHistorical ? 'font-semibold text-amber-700' : ''}>
                            {legDate}
                            {legTod ? ` (${legTod})` : ''}
                          </span>
                        )}
                        {leg.notional != null && (
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-700">
                            ${leg.notional.toLocaleString()} notional
                          </span>
                        )}
                        {/* Percentage / fraction sizing chip. When the
                            user spoke in % of portfolio / % of cash /
                            half of portfolio / etc, the LLM leaves
                            notional=null and fills notional_basis +
                            notional_pct/notional_fraction. We render
                            a blue chip so the user can confirm the
                            base the system will measure against at
                            execute time. */}
                        {(leg.notional_basis === 'PCT_PORTFOLIO' ||
                          leg.notional_basis === 'PCT_CASH' ||
                          leg.notional_basis === 'FRACTION_PORTFOLIO' ||
                          leg.notional_basis === 'FRACTION_CASH') && (
                          <span className="rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-800">
                            {leg.notional_basis === 'PCT_PORTFOLIO' || leg.notional_basis === 'PCT_CASH'
                              ? `${leg.notional_pct ?? 0}% of ${leg.notional_basis === 'PCT_CASH' ? 'cash' : 'portfolio'}`
                              : `${formatFractionLabel(leg.notional_fraction ?? 0)} of ${leg.notional_basis === 'FRACTION_CASH' ? 'cash' : 'portfolio'}`}
                          </span>
                        )}
                      </div>
                      {leg.price_unavailable_reason && (
                        <div className="mt-1 text-xs text-amber-700">
                          {leg.price_unavailable_reason}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* No-market-price warning for the (rare) case where the
                primary ticker has no price AND no fuzzy correction. */}
            {parsed.market_price == null &&
              parsed.price_unavailable_reason &&
              !parsed.ticker_suggestion && (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <div>
                    <div className="font-semibold">No market price available</div>
                    <div className="text-xs">{parsed.price_unavailable_reason}</div>
                  </div>
                </div>
              )}
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
                // Block execution if we have a typo suggestion — user
                // should confirm or correct first.
                Boolean(parsed.ticker_suggestion) ||
                // Multi-leg: every leg must have either a qty, a
                // notional, or a price (limit or market).
                (parsed.legs != null && parsed.legs.length > 0
                  ? !parsed.legs.every((l) =>
                      l.qty != null ||
                      l.notional != null ||
                      // Percentage / fraction legs have notional=null
                      // but are still executable (the system resolves
                      // the USD amount at click time).
                      (l.notional_basis != null && l.notional_basis !== 'USD') ||
                      (l.resolved_price != null && l.resolved_price > 0) ||
                      (l.market_price != null && l.market_price > 0))
                  : !(
                      (parsed.resolved_price != null && parsed.resolved_price > 0) ||
                      (parsed.limit_price != null && parsed.limit_price > 0) ||
                      (parsed.market_price != null && parsed.market_price > 0) ||
                      parsed.notional != null ||
                      (parsed.notional_basis != null && parsed.notional_basis !== 'USD')
                    ))
              }
              className="btn-primary flex items-center gap-2"
            >
              <CheckCircle className="h-4 w-4" />
              {executing
                ? 'Executing...'
                : parsed.legs && parsed.legs.length > 1
                ? `Execute ${parsed.legs.length} Trades`
                : 'Execute Trade'}
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
          <li>• The AI parses it into one or more trade legs (action, ticker, shares, stop)</li>
          <li>• <strong>Click the ticker or shares</strong> in a leg to fix OCR typos or adjust size — no need to re-type the command</li>
          <li>• Real-time market price is fetched from Bloomberg and shown next to each leg</li>
          <li>• <strong>Notional trades</strong> ("$50k of AAPL") are resolved to share count at execute time using the freshest price — the system, not the AI, owns the math</li>
          <li>• <strong>Percentage / fraction sizing</strong> ("10% of my portfolio on AAPL", "half on NVDA, half on TSLA", "buy a quarter of MSFT") — the system measures against your live portfolio equity (cash + positions) at execute time and converts to a USD notional just like above</li>
          <li>• <strong>Shorting</strong> is supported: try "short 50 NVDA" or "cover my TSLA short"</li>
          <li>• Review the parsed leg, pick the target portfolio, hit Execute</li>
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

// Pick the best available price: explicit limit > backend-resolved > current market.
function pickPrice(
  limitPrice: number | null | undefined,
  resolvedPrice: number | null | undefined,
  marketPrice: number | null | undefined,
): number | null {
  if (limitPrice != null && limitPrice > 0) return limitPrice;
  if (resolvedPrice != null && resolvedPrice > 0) return resolvedPrice;
  if (marketPrice != null && marketPrice > 0) return marketPrice;
  return null;
}

// (resolveQty used to live here. The per-leg executeLeg() above now
// handles ALL/HALF position lookups directly. Kept as a comment so
// future readers know the responsibility moved. Remove this block in
// a future cleanup pass if desired.)

/**
 * Pure-math mirror of `resolveLegBasisToNotional` for callers that
 * already have the live cash + equity in hand (e.g. the qty-seed
 * step in `handleParse`). Returns the resolved USD notional for a
 * non-USD basis, or null for USD / unknown basis / missing values.
 * Must stay in sync with the async version above.
 */
function notionalFromBasis(
  leg: ParsedLeg,
  cash: number,
  equity: number,
): number | null {
  const basis = leg.notional_basis ?? 'USD';
  if (basis === 'USD') return null;
  const base = basis === 'PCT_CASH' || basis === 'FRACTION_CASH' ? cash : equity;
  if (basis === 'PCT_PORTFOLIO' || basis === 'PCT_CASH') {
    const pct = leg.notional_pct ?? 0;
    if (pct <= 0) return null;
    return Math.floor((base * pct) / 100);
  }
  const frac = leg.notional_fraction ?? 0;
  if (frac <= 0) return null;
  return Math.floor(base * frac);
}

/**
 * Resolve a leg's notional_basis into a USD notional using the live
 * portfolio state. Returns null when the basis is USD (caller should
 * use the leg's explicit `notional` field instead) or when the leg
 * has an explicit share count (in which case dollars are irrelevant).
 *
 * Multi-leg percentage / fraction commands ("half on X, half on Y",
 * "10% on AAPL, 5% on MSFT") all measure against the SAME base —
 * the portfolio state at execute time — so this function makes one
 * portfolio read and reuses it across legs.
 */
async function resolveLegBasisToNotional(
  leg: ParsedLeg,
  portfolioId: string,
): Promise<{ notional: number; basisLabel: string } | null> {
  const basis = leg.notional_basis ?? 'USD';
  if (basis === 'USD') return null;
  const { cash, equity } = await computePortfolioEquity(portfolioId);
  const notional = notionalFromBasis(leg, cash, equity);
  if (notional == null) return null;
  let basisLabel: string;
  if (basis === 'PCT_PORTFOLIO' || basis === 'PCT_CASH') {
    const pct = leg.notional_pct ?? 0;
    basisLabel = `${pct}% of ${basis === 'PCT_CASH' ? 'cash' : 'portfolio equity'}`;
  } else {
    const frac = leg.notional_fraction ?? 0;
    basisLabel = `${formatFractionLabel(frac)} of ${basis === 'FRACTION_CASH' ? 'cash' : 'portfolio equity'}`;
  }
  return { notional, basisLabel };
}

function formatFractionLabel(f: number): string {
  if (Math.abs(f - 0.5) < 0.01) return 'half';
  if (Math.abs(f - 0.25) < 0.01) return 'a quarter';
  if (Math.abs(f - 1 / 3) < 0.01) return 'a third';
  if (Math.abs(f - 0.125) < 0.01) return 'an eighth';
  if (Math.abs(f - 0.1) < 0.01) return 'a tenth';
  return `${Math.round(f * 1000) / 10}%`;
}

// Execute one leg of a parsed multi-ticker command. Mirrors the
// single-ticker path but reads from the leg object. Each leg carries
// its own action/date/time_of_day/limit_price/stop_loss_pct so
// mixed-verb + per-leg-dates commands are first-class.
async function executeLeg(
  parsed: ParsedCommand,
  leg: ParsedLeg,
  portfolioId: string,
): Promise<void> {
  // Per-leg action is the source of truth. The server populates it
  // directly from the LLM's per-leg output (with a server-side
  // inferLegAction fallback). The flat parsed.action is only used
  // as a back-compat fallback for very old cached responses.
  const legAction: Action = leg.action ?? parsed.action;
  const legDirection: Direction = leg.direction
    ?? (legAction === 'SHORT' || legAction === 'COVER' ? 'SHORT' : 'LONG');
  const side: 'BUY' | 'SELL' =
    legAction === 'BUY' || legAction === 'COVER' ? 'BUY' : 'SELL';
  const direction: 'LONG' | 'SHORT' = legDirection;
  // Per-leg price priority: leg.limit_price > leg.resolved_price
  // > leg.market_price. The server's resolved_price is the
  // historical close for past dates, or live price for current
  // trades, so it's the right default.
  const price = pickPrice(leg.limit_price, leg.resolved_price, leg.market_price);
  // Resolve percentage / fraction bases to a USD notional BEFORE we
  // check the price gate, because the price gate below throws when
  // there's no price AND no notional — for a pct/fraction leg the
  // notional is computed below and the price is needed only at the
  // very end to convert notional -> qty (which executeTrade does).
  let resolvedNotional: number | null = leg.notional ?? null;
  const basisResolved = await resolveLegBasisToNotional(leg, portfolioId);
  if (basisResolved) {
    resolvedNotional = basisResolved.notional;
  }
  if (price == null && resolvedNotional == null) {
    throw new Error(
      `No market price for ${leg.ticker}. ` +
      `The AI could not fetch a live or historical price. ` +
      `Please specify a limit price or try again when market data is available.`
    );
  }
  // Per-leg stop_loss_pct (server fills leg.stop_loss_pct with the
  // LLM-supplied value, or the global parsed.stop_loss_pct as
  // back-compat). For ALL / HALF qty, the system looks up the
  // existing position.
  const stopPct = leg.stop_loss_pct ?? parsed.stop_loss_pct;
  const stopPrice =
    stopPct && price != null
      ? price * (1 - stopPct / 100)
      : undefined;
  // Per-leg date/time_of_day. The server's per-leg values are
  // authoritative; fall back to the global parsed fields for old
  // cached responses.
  const legDate = leg.trade_date ?? parsed.trade_date;
  const legTod = leg.time_of_day ?? parsed.time_of_day;
  const executedAt = buildExecutedAt(legDate, legTod);
  // Per-leg qty resolution. ALL / HALF require a position lookup.
  // The system — not the LLM — turns notional into qty at execute
  // time (via executeTrade).
  let qty: number | null = null;
  if (typeof leg.qty === 'string') {
    if (leg.qty === 'ALL' || leg.qty === 'HALF') {
      const positions = await getPositions(portfolioId);
      const pos = positions.find((p: Position) => p.ticker === leg.ticker);
      if (!pos) {
        throw new Error(`No position in ${leg.ticker}`);
      }
      qty = leg.qty === 'ALL' ? Math.abs(pos.qty) : Math.floor(Math.abs(pos.qty) / 2);
    } else {
      const n = parseFloat(leg.qty);
      qty = Number.isFinite(n) ? n : null;
    }
  } else if (typeof leg.qty === 'number' && leg.qty > 0) {
    qty = leg.qty;
  }
  // Sanity-check resolved notionals. A percentage of an empty
  // portfolio resolves to $0, which executeTrade() will reject as
  // "too small to buy 1 share". Surface a clearer error here.
  if (resolvedNotional != null && resolvedNotional <= 0 && qty == null) {
    throw new Error(
      `${basisResolved?.basisLabel ?? 'Notional'} for ${leg.ticker} resolves to $0. ` +
      `Portfolio appears empty (no cash, no positions).`
    );
  }
  await executeTrade({
    portfolio_id: portfolioId,
    ticker: leg.ticker,
    side,
    direction,
    qty,
    // resolvedNotional was computed above (either the leg's explicit
    // USD notional or the pct/fraction-resolved value). Pass it
    // through; executeTrade() handles notional -> qty using `price`.
    notional: resolvedNotional,
    price,
    stop_price: stopPrice,
    notes: basisResolved
      ? `AI: ${parsed.original_command} (leg ${leg.ticker}, ${basisResolved.basisLabel})`
      : `AI: ${parsed.original_command} (leg ${leg.ticker})`,
    executed_at: executedAt,
  });
}
