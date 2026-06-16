/**
 * ai-service Edge Function
 *
 * Parses natural-language trade commands into structured orders, and
 * stores the conversation in `ai_chat_history`. The LLM fills the trade
 * form fields (action, ticker, qty, notional, price_type, limit_price,
 * stop_loss_pct) from a sentence like "short 100 AAPL at market with
 * a 7% stop" or "buy $50k of NVDA".
 *
 * Market context is read from the `instrument_prices` cache, which is
 * populated by the `market-data` Edge Function -> bloomberg-service ->
 * Bloomberg SAPI chain. The ai-service does NOT call Bloomberg directly.
 *
 * For historical-date commands ("buy NVDA 3 days ago"), the resolved price
 * is fetched from the market-data `/historical` endpoint, which proxies
 * Bloomberg historical data via the bloomberg-service relay.
 *
 * Routes:
 *   POST /parse  - turn a sentence into a trade object (user-only)
 *   GET  /history - recent ai_chat_history turns for the user (user-only)
 *
 * Auth: uses the shared `_shared/auth.ts` helper. Requires a valid user
 * JWT in the Authorization header (verified by GoTrue). The same JWT is
 * forwarded on inner calls to market-data — one credential, one source
 * of truth. The DB service-role key never appears in an HTTP header.
 *
 * Env:
 *   GEMINI_API_KEY       required for the LLM call (no key -> regex fallback)
 *   GEMINI_LITE_MODEL    optional, default 'gemini-2.5-flash-lite' (first pass)
 *   GEMINI_FALLBACK_MODEL optional, default 'gemini-2.5-flash' (self-critique)
 *   SERVICE_KEY          Supabase service-role key (DB only, read by _shared/db.ts)
 *   SUPABASE_URL         auto-injected by Supabase
 *   ALLOWED_ORIGINS      optional, comma-separated. If set, the auth helper
 *                        rejects requests from origins not on the list
 *                        (the Supabase gateway handles the actual CORS
 *                        preflight; this is a second layer if you want it)
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { supabaseAdmin } from '../_shared/db.ts';
import { getUserFromRequest, checkOrigin } from '../_shared/auth.ts';

// =====================================================================
// 1. Config  (env-driven - no magic constants)
// =====================================================================

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const GEMINI_LITE_MODEL = Deno.env.get('GEMINI_LITE_MODEL') ?? 'gemini-2.5-flash-lite';
const GEMINI_FALLBACK_MODEL = Deno.env.get('GEMINI_FALLBACK_MODEL') ?? 'gemini-2.5-flash';
const GEMINI_LITE_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_LITE_MODEL)}:generateContent`;
const GEMINI_FALLBACK_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_FALLBACK_MODEL)}:generateContent`;
const LLM_TIMEOUT_MS = 4_000;
// Self-critique uses the larger fallback model and is a yes/no question,
// so we give it a longer budget. 4s against gemini-2.5-flash is too tight
// and the critique is silently dropped on abort.
const LLM_CRITIQUE_TIMEOUT_MS = 7_000;
const HISTORICAL_FETCH_TIMEOUT_MS = 8_000;

// Hoisted to module scope: the resolveTicker() function is on the hot
// path of every /parse call, and rebuilding this 60+ entry Set on
// every invocation was measurable in the request budget.
const STOPWORDS = new Set([
  // Action verbs
  'BUY', 'SELL', 'CLOSE', 'COVER', 'SHORT', 'LONG',
  // Prepositions / articles
  'AT', 'IN', 'ON', 'TO', 'OF', 'FOR', 'WITH', 'AND', 'OR', 'THE',
  'A', 'AN', 'IS', 'IT', 'MY', 'BY', 'NOT', 'NO', 'AS',
  // Common quantifiers
  'ALL', 'HALF', 'NOW', 'SOME', 'ANY', 'NEW', 'OLD', 'BIG', 'FEW',
  'I', 'WANT', 'WANTED', 'TEXT', 'ENTIRE', 'THIS', 'THAT',
  'HIGH', 'LOW', 'MORE', 'LESS', 'JUST', 'ONLY', 'ALSO', 'HAVE', 'WILL',
  'AFTER', 'BEFORE',
  // Order-type words
  'STOP', 'LOSS', 'LIMIT', 'MARKET', 'ENTRY', 'EXIT',
  // Time units
  'DAY', 'DAYS', 'WEEK', 'WEEKS', 'MONTH', 'MONTHS',
  'YEAR', 'YEARS', 'QUARTER', 'QUARTERS', 'HOUR', 'HOURS',
  'MINUTE', 'MINUTES', 'SECOND', 'SECONDS',
  'Q1', 'Q2', 'Q3', 'Q4',
  'AGO', 'TODAY', 'YESTERDAY', 'TOMORROW', 'LAST', 'NEXT',
  'EOD', 'EOM', 'EOY', 'MORNING', 'AFTERNOON', 'EVENING',
  // Currency codes (as standalone words, not part of a pair)
  'USD', 'JPY', 'EUR', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD',
  'HKD', 'SGD', 'CNY', 'CNH', 'KRW', 'INR',
  'DOLLAR', 'DOLLARS', 'CENT', 'CENTS',
  // Option / derivative words
  'CALL', 'PUT', 'ITM', 'OTM', 'ATM', 'STRIKE', 'EXPIRY',
  // Magnitude suffixes
  'THOUSAND', 'MILLION', 'BILLION', 'TRILLION',
  // Nouns
  'SHARES', 'STOCK', 'STOCKS', 'SHARE',
  'TRADE', 'TRADING', 'ORDER', 'ORDERS',
  'PRICE', 'PRICES', 'VALUE', 'VALUES', 'WORTH',
  'POSITION', 'POSITIONS', 'PORTFOLIO', 'PORTFOLIOS',
  'CONTRACT', 'CONTRACTS',
  // Numerals (when spelled out) — belt-and-suspenders for the
  // "$50k" pattern where k is not a ticker.
  'K', 'M', 'B', 'T',
  // Month names
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
  // Trading/finance acronyms that the 1-5 char token regex WILL match
  // and that are almost never the actual ticker the user means.
  'ETF', 'CEO', 'CFO', 'CTO', 'COO', 'IPO', 'EPS', 'PE',
  'NYSE', 'RSU', 'DCA', 'ATH', 'ATL', 'PIPE', 'SPAC', 'REIT',
  'FD', 'DTE', 'IV', 'OI', 'PT', 'ME', 'USA', 'US', 'EU',
  // 'AI' is ambiguous (C3.ai is a real ticker) — keep it OUT of the
  // stopwords so users can still type "buy AI" and have the LLM
  // resolve it. If a real false-positive emerges we can add it.
]);
// =====================================================================
// 2. Types
// =====================================================================

interface ParsedCommand {
  portfolio_id: string | null;
  portfolio_name: string | null;
  action: 'BUY' | 'SELL' | 'CLOSE' | 'SHORT' | 'COVER';
  direction: 'LONG' | 'SHORT';
  ticker: string | null;
  qty: number | string | null;
  price_type: 'MARKET' | 'LIMIT' | 'STOP';
  limit_price: number | null;
  stop_loss_pct: number | null;
  confidence: number;
  needs_confirmation: boolean;
  explanation: string;
  original_command: string;
  trade_date: string | null;
  is_historical: boolean;
  // Intraday session tag: "at the open" -> 'open', "pre-market" -> 'pre',
  // "at close" -> 'close', "after hours" -> 'post', etc. null if the
  // user didn't specify one.
  time_of_day: 'pre' | 'open' | 'regular' | 'close' | 'post' | 'eod' | null;
  // Notional (USD) when the user spoke in dollars ("$50k of AAPL",
  // "1 million of NVDA worth $200"). The system — not the LLM —
  // resolves notional to qty at execution time using the freshest
  // cached price. Null if the user gave a share count instead.
  notional: number | null;
  // Informational only: how many shares the system would buy at the
  // current price. The frontend shows it for transparency but the
  // authoritative qty is recomputed by executeTrade() at click time.
  preview_qty: number | null;
}

interface MarketQuote {
  ticker: string;
  current_price: number;
  previous_close: number | null;
  change_pct: number | null;
  day_high: number | null;
  day_low: number | null;
  company_name: string | null;
  sector: string | null;
  last_updated: string;
  from_cache?: boolean;
}

interface ResolvedTicker {
  ticker: string;
  matchedTerm: string;
  // Which branch of `resolveTicker` produced this match. The fallback
  // parser (`simpleParse`) uses this to reject low-confidence matches
  // (HK regex, general token scan) that the LLM path would have
  // corrected. `simpleParse` only accepts 'company' | 'suffixed' |
  // 'fx' | 'future'.
  source: 'company' | 'suffixed' | 'fx' | 'future' | 'hk' | 'token';
}

// =====================================================================
// 2b. System instructions file (loaded at cold start)
//
// Lets the user tune the assistant's tone, examples, and edge cases
// without redeploying the function. Cached in memory after first read.
// =====================================================================

let SYSTEM_INSTRUCTIONS_CACHE: string | null = null;
async function loadSystemInstructions(): Promise<string> {
  if (SYSTEM_INSTRUCTIONS_CACHE !== null) return SYSTEM_INSTRUCTIONS_CACHE;
  try {
    // The function runs from supabase/functions/ai-service/. The file
    // is bundled at deploy time so we can use Deno.readTextFile.
    SYSTEM_INSTRUCTIONS_CACHE = await Deno.readTextFile(
      new URL('./SYSTEM_INSTRUCTIONS.md', import.meta.url),
    );
  } catch (err) {
    console.warn('SYSTEM_INSTRUCTIONS.md not readable, using empty fallback:', err);
    SYSTEM_INSTRUCTIONS_CACHE = '';
  }
  return SYSTEM_INSTRUCTIONS_CACHE;
}

// =====================================================================
// 2c. In-memory LRU cache for parsed commands
//
// Keyed by (user_id, command). 60s TTL. Many users retype the same
// command ("buy 100 AAPL") and re-running the LLM is wasteful.
// =====================================================================

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 256;
interface CacheEntry {
  expires: number;
  result: ParsedCommand;
}
const PARSE_CACHE = new Map<string, CacheEntry>();

function cacheGet(key: string): ParsedCommand | null {
  const entry = PARSE_CACHE.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    PARSE_CACHE.delete(key);
    return null;
  }
  // LRU touch
  PARSE_CACHE.delete(key);
  PARSE_CACHE.set(key, entry);
  return entry.result;
}
function cacheSet(key: string, value: ParsedCommand): void {
  if (PARSE_CACHE.size >= CACHE_MAX_ENTRIES) {
    const firstKey = PARSE_CACHE.keys().next().value;
    if (firstKey) PARSE_CACHE.delete(firstKey);
  }
  PARSE_CACHE.set(key, { expires: Date.now() + CACHE_TTL_MS, result: value });
}

// =====================================================================
// 2d. Company-name -> ticker map
//
// Keys are lowercase. Multi-word phrases come first in iteration order
// (we sort by length desc) so "jp morgan" matches before "jpmorgan".
// Extend this list as needed; it's a quick safety-net for the LLM.
// =====================================================================

const COMPANY_TO_TICKER: Record<string, string> = {
  apple: 'AAPL',
  microsoft: 'MSFT',
  google: 'GOOGL',
  alphabet: 'GOOGL',
  amazon: 'AMZN',
  meta: 'META',
  facebook: 'META',
  netflix: 'NFLX',
  tesla: 'TSLA',
  nvidia: 'NVDA',
  amd: 'AMD',
  intel: 'INTC',
  ibm: 'IBM',
  oracle: 'ORCL',
  salesforce: 'CRM',
  adobe: 'ADBE',
  paypal: 'PYPL',
  shopify: 'SHOP',
  spotify: 'SPOT',
  uber: 'UBER',
  lyft: 'LYFT',
  airbnb: 'ABNB',
  snap: 'SNAP',
  coinbase: 'COIN',
  robinhood: 'HOOD',
  jpmorgan: 'JPM',
  'jp morgan': 'JPM',
  'goldman sachs': 'GS',
  goldman: 'GS',
  'morgan stanley': 'MS',
  'bank of america': 'BAC',
  'wells fargo': 'WFC',
  visa: 'V',
  mastercard: 'MA',
  'berkshire hathaway': 'BRK.B',
  'johnson & johnson': 'JNJ',
  'j&j': 'JNJ',
  walmart: 'WMT',
  costco: 'COST',
  'home depot': 'HD',
  disney: 'DIS',
  'coca cola': 'KO',
  coke: 'KO',
  pepsi: 'PEP',
  starbucks: 'SBUX',
  mcdonald: 'MCD',
  nike: 'NKE',
  exxon: 'XOM',
  chevron: 'CVX',
  boeing: 'BA',
  caterpillar: 'CAT',
  '3m': 'MMM',
  honeywell: 'HON',
  ge: 'GE',
  'general electric': 'GE',
  ford: 'F',
  gm: 'GM',
  'general motors': 'GM',
  toyota: 'TM',
  honda: 'HMC',
};

// =====================================================================
// 3. LLM call  (Gemini function calling, fast & strict)
// =====================================================================

/**
 * Function-calling schema for Gemini. The LLM is forced to call this
 * function (or return null), giving the strongest schema guarantees
 * and avoiding the cost/error rate of freeform JSON generation.
 */
const PARSE_TRADE_FUNCTION = {
  name: 'parse_trade',
  description: 'Extract a structured trade order from the user\'s natural-language command.',
  parameters: {
    type: 'object',
    properties: {
      portfolio_id: { type: 'string', nullable: true, description: 'UUID of the portfolio, or null if unspecified.' },
      portfolio_name: { type: 'string', nullable: true, description: 'Name of the portfolio if the user mentioned one.' },
      action: { type: 'string', enum: ['BUY', 'SELL', 'CLOSE', 'SHORT', 'COVER'] },
      ticker: { type: 'string', nullable: true, description: 'Symbol, uppercase. Null if not detected.' },
      qty: {
        oneOf: [
          { type: 'number' },
          { type: 'string', enum: ['ALL', 'HALF'] },
          { type: 'null' },
        ],
        description: 'Share count, or ALL/HALF to mean entire or half of the existing position, or null if not given.',
      },
      notional: { type: 'number', nullable: true, description: 'USD dollar amount the user wants to spend. Null if qty was given.' },
      price_type: { type: 'string', enum: ['MARKET', 'LIMIT', 'STOP'] },
      limit_price: { type: 'number', nullable: true },
      stop_loss_pct: { type: 'number', nullable: true, description: 'Stop-loss as a percent of entry, e.g. 7 means -7%.' },
      confidence: { type: 'number', description: '0.0-1.0 self-rated confidence.' },
      needs_confirmation: { type: 'boolean', description: 'True if anything is ambiguous.' },
      explanation: { type: 'string', description: 'Short user-facing explanation of what the trade does.' },
      trade_date: { type: 'string', nullable: true, description: 'YYYY-MM-DD if the user named a historical date, else null.' },
      time_of_day: { type: 'string', nullable: true, enum: ['pre', 'open', 'regular', 'close', 'post', 'eod'] },
    },
    required: ['action', 'price_type', 'confidence', 'needs_confirmation', 'explanation'],
  },
};

/**
 * Call Google Gemini with a system + user prompt. Uses function calling
 * for a strict output schema. Returns the parsed function-call args, or
 * null on any failure (no key, timeout, non-2xx, network).
 *
 * - 4s AbortController timeout (faster than the old 10s; slow calls
 *   usually mean the LLM is hallucinating — fall back to regex).
 * - Function-calling mode (not responseMimeType) — faster and stricter.
 */
async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  modelUrl: string = GEMINI_LITE_URL,
  timeoutMs: number = LLM_TIMEOUT_MS,
): Promise<Record<string, any> | null> {
  if (!GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY not set - LLM call skipped, using regex fallback');
    return null;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${modelUrl}?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        tools: [{ function_declarations: [PARSE_TRADE_FUNCTION] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 400,
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`Gemini error ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part?.functionCall?.args) return part.functionCall.args;
    }
    return null;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.error(`Gemini call timed out after ${timeoutMs}ms`);
    } else {
      console.error('Gemini call failed:', err);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// =====================================================================
// 4. Market data  (read instrument_prices cache + historical endpoint)
// =====================================================================

/**
 * Look up the latest cached quote for `ticker` in the `instrument_prices`
 * table. Returns null on a cache miss - a miss is normal (the user
 * may have typed a ticker the scheduler hasn't refreshed yet) and is
 * NOT logged as an error.
 */
async function fetchMarketPrice(ticker: string): Promise<MarketQuote | null> {
  if (!ticker) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('instrument_prices')
      .select('*')
      .eq('ticker', ticker.toUpperCase())
      .maybeSingle();
    if (error) {
      console.error(`instrument_prices read failed for ${ticker}:`, error.message);
      return null;
    }
    return (data as MarketQuote) ?? null;
  } catch (err) {
    console.error(`instrument_prices read threw for ${ticker}:`, err);
    return null;
  }
}

/**
 * Fetch the historical close price for a ticker on a given date from the
 * market-data `/historical` endpoint. Returns null on any failure.
 */
async function fetchHistoricalPrice(
  ticker: string,
  date: string,
  userAuth: string,
): Promise<{ close_price: number; date: string } | null> {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!supabaseUrl) {
      console.error('SUPABASE_URL not set; cannot call /historical');
      return null;
    }
    const url = `${supabaseUrl}/functions/v1/market-data/historical?ticker=${encodeURIComponent(ticker)}&date=${encodeURIComponent(date)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HISTORICAL_FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { 'Authorization': userAuth },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      console.error(`market-data/historical returned ${res.status} for ${ticker}@${date}`);
      return null;
    }
    const body = await res.json();
    const data = body?.data;
    if (!data || typeof data.close_price !== 'number') return null;
    return { close_price: data.close_price, date: data.date ?? date };
  } catch (err) {
    console.error(`fetchHistoricalPrice failed for ${ticker}@${date}:`, err);
    return null;
  }
}

interface QuoteResult {
  quote: MarketQuote | null;
  unavailable_reason: string | null;
}

async function ensureFreshQuote(ticker: string, userAuth: string): Promise<QuoteResult> {
  if (!ticker) return { quote: null, unavailable_reason: 'empty ticker' };
  const cached = await fetchMarketPrice(ticker);
  if (cached) return { quote: cached, unavailable_reason: null };

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) {
    const reason = 'SUPABASE_URL not set in ai-service env';
    console.error(`ensureFreshQuote(${ticker}): ${reason}`);
    return { quote: null, unavailable_reason: reason };
  }
  const url = `${supabaseUrl}/functions/v1/market-data/refresh?ticker=${encodeURIComponent(ticker.toUpperCase())}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8_000);
  let res: Response | null = null;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': userAuth },
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      const reason = `market-data/refresh timed out after 8s (is the bloomberg relay running? see SETUP.md)`;
      console.error(`ensureFreshQuote(${ticker}): ${reason}`);
      return { quote: null, unavailable_reason: reason };
    }
    const reason = `market-data/refresh network error: ${(err as Error).message}`;
    console.error(`ensureFreshQuote(${ticker}): ${reason}`);
    return { quote: null, unavailable_reason: reason };
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    const reason = res.status === 502 || res.status === 504
      ? `bloomberg relay unreachable (status ${res.status}). Start uvicorn + cloudflared per SETUP.md.`
      : res.status === 404
      ? `no bloomberg data for ${ticker} (status 404)`
      : `market-data/refresh returned ${res.status}: ${body.slice(0, 200)}`;
    console.error(`ensureFreshQuote(${ticker}): ${reason}`);
    return { quote: null, unavailable_reason: reason };
  }

  // The refresh response contains the freshly-merged row (market-data
  // already wrote it and returned it in the same call). Use it directly
  // instead of re-reading the DB — saves a round-trip and removes a
  // latent read-replica race.
  let body: any = null;
  try { body = await res.json(); } catch { /* ignore */ }
  const merged = body?.data;
  if (!merged || typeof merged.current_price !== 'number') {
    const reason = `refresh succeeded but no quote data for ${ticker}`;
    console.error(`ensureFreshQuote(${ticker}): ${reason}`);
    return { quote: null, unavailable_reason: reason };
  }
  return { quote: merged as MarketQuote, unavailable_reason: null };
}

/**
 * Render a market quote into a short context string for the LLM prompt.
 */
function formatMarketContext(
  q: MarketQuote | null,
  ticker: string,
  historical: { date: string; close_price: number } | null = null,
): string {
  if (historical) {
    return `Market data for ${ticker}: close=$${historical.close_price.toFixed(2)} on ${historical.date} (historical).`;
  }
  if (!q) return `Market data for ${ticker}: unavailable (use limit_price or fallback).`;
  const change = q.change_pct != null
    ? `${q.change_pct >= 0 ? '+' : ''}${q.change_pct.toFixed(2)}%`
    : 'n/a';
  const name = q.company_name ? ` (${q.company_name})` : '';
  return `Market data for ${ticker}${name}: current=$${q.current_price.toFixed(2)}, `
       + `prev_close=$${(q.previous_close ?? q.current_price).toFixed(2)}, `
       + `day_change=${change}, source=${q.from_cache ? 'cache' : 'live'}.`;
}

// =====================================================================
// 5. Ticker resolution & date detection
// =====================================================================

/**
 * Resolve a ticker from the user's command. Tries, in order:
 *   1. A company name lookup against COMPANY_TO_TICKER.
 *   2. A shape-based classifier (3-5 letters -> equity/ETF, 6 letters
 *      -> FX, digit/letter mix -> futures, all-digits -> HK equity).
 *   3. A general uppercase token scan, with an expanded stopword set
 *      that includes currency codes, time units, and option words.
 *
 * The stopword set is now MUCH larger than the original — it
 * includes USD/JPY/EUR/GBP/etc. as currency words, YEAR/YEARS/MONTH
 * etc. as time units, and LONG/SHORT/CALL/PUT as option words, all of
 * which were common false-positive tickers in the old code.
 */
function resolveTicker(command: string): ResolvedTicker | null {
  // 1. Company-name lookup. Longer phrases first.
  const keys = Object.keys(COMPANY_TO_TICKER).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(command)) {
      return { ticker: COMPANY_TO_TICKER[key], matchedTerm: key, source: 'company' };
    }
  }

  const upper = command.toUpperCase();
  // 2. Shape-based classification. Try these in priority order so
  //    "1 ES1" is parsed as futures, not "ES1" as equity, and
  //    "EURUSD" is parsed as FX, not two letters.
  const trimmed = upper.trim();

  // Already suffixed: "AAPL US EQUITY" -> return as-is.
  // Match actual Bloomberg format: <TICKER> <2-LETTER-EXCHANGE> <ASSET-CLASS>.
  // The previous regex `/\s[A-Z]{2,}\s+[A-Z]{2,}/` was way too loose: it
  // matched common English phrases like "OF NVDA" or "SEMICONDUCTER BULL"
  // and returned the entire command as the ticker. Requiring a
  // 2-letter exchange code (US, HK, JP, GB, ...) followed by a known
  // asset class (EQUITY, COMDTY, CURNCY, INDEX, FUTURE, OPT, WARNT)
  // prevents that.
  const SUFFIXED_TICKER_RE =
    /\b([A-Z]{1,5}\d{0,2})\s+([A-Z]{2})\s+(EQUITY|COMDTY|CURNCY|INDEX|FUTURE|FUT|OPT|WARNT)\b/;
  const suffixedMatch = trimmed.match(SUFFIXED_TICKER_RE);
  if (suffixedMatch) {
    return { ticker: suffixedMatch[0], matchedTerm: suffixedMatch[0], source: 'suffixed' };
  }

  // 6-letter all-alpha: FX pair (EURUSD, GBPJPY, etc.).
  const fxRe = /\b([A-Z]{6})\b/;
  const fxMatch = upper.match(fxRe);
  if (fxMatch) return { ticker: fxMatch[1], matchedTerm: fxMatch[1], source: 'fx' };

  // Digit-then-letters or letter-then-digit (ES1, CLZ25, GC=F): futures.
  const futureRe = /\b([A-Z]+\d+[A-Z]?|[A-Z]+=[A-Z]?)\b/;
  const futureMatch = upper.match(futureRe);
  if (futureMatch) return { ticker: futureMatch[1], matchedTerm: futureMatch[1], source: 'future' };

  // All-digits 4-5: HK equity (0700 -> 700 HK Equity, 9988 -> 9988 HK
  // Equity). We require 4+ digits to avoid matching share counts like
  // "buy 30 SOXL" or "buy 100 NVDA". 3-digit codes like "700" should
  // be zero-padded to "0700" by the user; the bloomberg-service will
  // handle the padding either way.
  const hkRe = /\b(0?\d{4,5})\b/;
  const hkMatch = upper.match(hkRe);
  if (hkMatch) {
    const num = parseInt(hkMatch[1], 10);
    if (num > 0 && num < 100000) {
      return { ticker: hkMatch[1], matchedTerm: hkMatch[1], source: 'hk' };
    }
  }

  // 3. General uppercase token scan with an expanded stopword set.
  const matches = upper.match(/\b([A-Z]{1,5})\b/g);
  if (matches) {
    for (const tok of matches) {
      if (!STOPWORDS.has(tok)) return { ticker: tok, matchedTerm: tok, source: 'token' };
    }
  }
  return null;
}

/**
 * Extract a trade date from the user's command. Returns YYYY-MM-DD or null.
 */
function detectDate(command: string): string | null {
  const lower = command.toLowerCase();
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const daysAgo = (n: number) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - n);
    return fmt(d);
  };

  if (/\btoday\b|\bnow\b/.test(lower)) return fmt(today);
  if (/\byesterday\b/.test(lower)) return daysAgo(1);

  let m: RegExpMatchArray | null;
  if ((m = lower.match(/(\d+)\s*days?\s*ago/))) return daysAgo(parseInt(m[1]));
  if ((m = lower.match(/(\d+)\s*weeks?\s*ago/))) return daysAgo(parseInt(m[1]) * 7);
  if ((m = lower.match(/(\d+)\s*months?\s*ago/))) {
    const d = new Date(today);
    d.setUTCMonth(d.getUTCMonth() - parseInt(m[1]));
    return fmt(d);
  }
  if ((m = lower.match(/(\d+)\s*years?\s*ago/))) {
    const d = new Date(today);
    d.setUTCFullYear(d.getUTCFullYear() - parseInt(m[1]));
    return fmt(d);
  }
  if ((m = lower.match(/(\d+)\s*hours?\s*ago/))) {
    return fmt(today);
  }
  if (/\blast\s+week\b/.test(lower)) return daysAgo(7);
  if (/\blast\s+month\b/.test(lower)) return daysAgo(30);
  if (/\blast\s+year\b/.test(lower)) return daysAgo(365);
  if (/\bthis\s+week\b/.test(lower)) {
    const d = new Date(today);
    const dow = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - (dow - 1));
    return fmt(d);
  }

  if ((m = command.match(/\b(\d{4}-\d{2}-\d{2})\b/))) return m[1];
  if ((m = command.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/))) {
    const [, mo, da, yr] = m;
    return `${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`;
  }

  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  for (let i = 0; i < 12; i++) {
    const re = new RegExp(
      `\\b(on\\s+)?${monthNames[i].slice(0, 3)}\\w*\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`,
      'i',
    );
    const mm = command.match(re);
    if (mm) {
      const day = parseInt(mm[2]);
      const year = mm[3] ? parseInt(mm[3]) : today.getUTCFullYear();
      return `${year}-${String(i + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

/**
 * Detect an intraday time-of-day phrase in the user's command.
 */
function detectTimeOfDay(command: string): 'pre' | 'open' | 'regular' | 'close' | 'post' | 'eod' | null {
  const lower = command.toLowerCase();
  const patterns: Array<[RegExp, 'pre' | 'open' | 'regular' | 'close' | 'post' | 'eod']> = [
    [/\bat\s+the\s+open\b|\bat\s+open\b|\bon\s+the\s+open\b/, 'open'],
    [/\bpre[\s-]?market\b|\bpremarket\b|\bthis\s+morning\b/, 'pre'],
    [/\bat\s+the\s+close\b|\bat\s+close\b|\bend\s+of\s+(the\s+)?day\b|\beod\b/, 'close'],
    [/\bafter[\s-]?hours\b|\bpost[\s-]?market\b|\bpostmarket\b/, 'post'],
    [/\bregular\s+(session|hours|trading)\b/, 'regular'],
  ];
  for (const [re, tag] of patterns) {
    if (re.test(lower)) return tag;
  }
  return null;
}

function buildSessionContext(): string {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();
  const dayOfWeek = now.getUTCDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const session = isWeekend ? 'closed' : sessionOf(utcHour, utcMin);

  const lastClose = new Date(now);
  if (isWeekend) {
    const back = dayOfWeek === 0 ? 2 : 1;
    lastClose.setUTCDate(lastClose.getUTCDate() - back);
  } else if (session === 'closed') {
    lastClose.setUTCDate(lastClose.getUTCDate() - 1);
  }
  const lastCloseIso = lastClose.toISOString().slice(0, 10);

  const nextOpen = new Date(now);
  if (isWeekend) {
    const add = dayOfWeek === 0 ? 1 : 2;
    nextOpen.setUTCDate(nextOpen.getUTCDate() + add);
  } else if (utcHour >= 13 && utcMin >= 30) {
    nextOpen.setUTCDate(nextOpen.getUTCDate() + 1);
  }
  nextOpen.setUTCHours(13, 30, 0, 0);
  const nextOpenIso = nextOpen.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const sgOffsetMin = 8 * 60;
  const sgTime = new Date(now.getTime() + sgOffsetMin * 60_000);
  const sgIso = sgTime.toISOString().replace('T', ' ').slice(0, 16) + ' UTC+8';

  return [
    'Market session:',
    `  now_utc:        ${now.toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    `  user_local:     ${sgIso} (Asia/Singapore, UTC+8)`,
    `  session:        ${session} (US regular hours 13:30–20:00 UTC; pre 09:00–13:30; post 20:00–00:00; closed overnight + weekends)`,
    `  last_close_us:  ${lastCloseIso}`,
    `  next_open_us:   ${nextOpenIso}`,
  ].join('\n');
}

function sessionOf(utcHour: number, utcMin: number): 'pre' | 'open' | 'regular' | 'close' | 'post' | 'closed' {
  const mins = utcHour * 60 + utcMin;
  if (mins < 9 * 60) return 'closed';
  if (mins < 13 * 60 + 30) return 'pre';
  if (mins < 13 * 60 + 45) return 'open';
  if (mins < 20 * 60) return 'regular';
  return 'post';
}

// =====================================================================
// 6. Parser  (LLM with regex fallback + safety-net validation)
// =====================================================================

/**
 * Build the system prompt. The custom-instructions file (loaded at
 * cold start) is prepended so the user can tune tone/examples without
 * redeploying. The session context and market context are weaved in
 * per-request.
 */
function buildSystemPrompt(customInstructions: string): string {
  return `You are a trading assistant for a paper trading platform. Parse natural language trade commands and extract structured information.

${customInstructions}

You MUST call the parse_trade function. Do not return prose.

If no portfolio is specified, set portfolio_id to null and the frontend will use the active one. "at market" means MARKET order type. "half" or "percentage" refers to existing position size. "close" or "exit" means sell the entire position. Always extract ticker symbols in uppercase. Provide a brief explanation of what the command does.`;
}

function deriveDirectionFromAction(action: 'BUY' | 'SELL' | 'CLOSE' | 'SHORT' | 'COVER'): 'LONG' | 'SHORT' {
  return (action === 'SHORT' || action === 'COVER') ? 'SHORT' : 'LONG';
}

/**
 * Parse a magnitude token from a natural-language quantity string.
 */
function parseMagnitude(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/,/g, '');
  const spelled = s.match(/^(\d+(?:\.\d+)?)\s*(thousand|million|billion|trillion|k\b|m\b|b\b|t\b)$/i);
  if (spelled) {
    const n = parseFloat(spelled[1]);
    const unit = spelled[2].toLowerCase();
    if (!Number.isFinite(n)) return null;
    if (unit === 'thousand' || unit === 'k') return Math.round(n * 1_000);
    if (unit === 'million' || unit === 'm')  return Math.round(n * 1_000_000);
    if (unit === 'billion' || unit === 'b')  return Math.round(n * 1_000_000_000);
    if (unit === 'trillion' || unit === 't') return Math.round(n * 1_000_000_000_000);
  }
  const compact = s.match(/^\$?(\d+(?:\.\d+)?)\s*([kmbt])$/i);
  if (compact) {
    const n = parseFloat(compact[1]);
    const u = compact[2].toLowerCase();
    if (!Number.isFinite(n)) return null;
    if (u === 'k') return Math.round(n * 1_000);
    if (u === 'm') return Math.round(n * 1_000_000);
    if (u === 'b') return Math.round(n * 1_000_000_000);
    if (u === 't') return Math.round(n * 1_000_000_000_000);
  }
  const plain = s.match(/^\$?(\d+(?:\.\d+)?)$/);
  if (plain) {
    const n = parseFloat(plain[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Extract a notional (USD) value from a natural-language command.
 */
function parseNotional(command: string): number | null {
  const lower = command.toLowerCase();
  const dollarRe = /\$\s*([\d,]+(?:\.\d+)?\s*[kmbt]?|\d+(?:\.\d+)?)\b/i;
  const dollarHit = lower.match(dollarRe);
  if (dollarHit) {
    const mag = parseMagnitude(dollarHit[1]);
    if (mag == null) return null;
    const afterIdx = (dollarHit.index ?? 0) + dollarHit[0].length;
    const after = lower.slice(afterIdx, afterIdx + 40);
    if (/\bworth\b|\bof\b/.test(after)) return mag;
    const before = lower.slice(Math.max(0, (dollarHit.index ?? 0) - 12), dollarHit.index ?? 0);
    if (/\b(for|spend|put|invest|allocate|deploy|use|buy|sell)\b/.test(before)) return mag;
  }
  const dollarsWorthRe = /(\d+(?:\.\d+)?\s*(?:thousand|million|billion|trillion|k\b|m\b|b\b|t\b)|[\d,]+)\s+dollars?\s+worth/i;
  const dw = lower.match(dollarsWorthRe);
  if (dw) {
    const mag = parseMagnitude(dw[1]);
    if (mag != null) return mag;
  }
  const dollarsOfRe = /(\d+(?:\.\d+)?\s*(?:thousand|million|billion|trillion|k\b|m\b|b\b|t\b)|[\d,]+)\s+dollars?\s+of\b/i;
  const df = lower.match(dollarsOfRe);
  if (df) {
    const mag = parseMagnitude(df[1]);
    if (mag != null) return mag;
  }
  const bareWorthRe = /(\d+(?:\.\d+)?\s*(?:thousand|million|billion|trillion|k\b|m\b|b\b|t\b)|[\d,]+)\s+worth\b/i;
  const bw = lower.match(bareWorthRe);
  if (bw) {
    const beforeIdx = bw.index ?? 0;
    const before = lower.slice(Math.max(0, beforeIdx - 10), beforeIdx);
    if (!/\bdollar/i.test(before)) {
      const mag = parseMagnitude(bw[1]);
      if (mag != null) return mag;
    }
  }
  return null;
}

function parseShareCount(command: string): number | string | null {
  const lower = command.toLowerCase();
  const compactRe = /(\d+(?:\.\d+)?)\s*(thousand|million|billion|trillion|k\b|m\b|b\b|t\b)\b/i;
  const cm = lower.match(compactRe);
  if (cm) {
    const afterIdx = (cm.index ?? 0) + cm[0].length;
    const after = lower.slice(afterIdx, afterIdx + 20);
    if (/^\s*(dollars?|worth)\b/i.test(after)) return null;
    return parseMagnitude(cm[1] + cm[2]);
  }
  const bareRe = /(\d+)\s*(?:shares?|stocks?|units?)?\b/i;
  const bm = command.match(bareRe);
  if (bm) {
    const afterIdx = (bm.index ?? 0) + bm[0].length;
    const after = lower.slice(afterIdx, afterIdx + 20);
    if (/^\s*worth\b/i.test(after)) return null;
    return parseInt(bm[1]);
  }
  return null;
}

/**
 * Regex-based fallback. Used when the LLM is unavailable, returns
 * unparseable JSON, or times out. Conservative: defaults action to
 * BUY, marks needs_confirmation=true if the ticker wasn't detected.
 */
function simpleParse(command: string): ParsedCommand {
  const lower = command.toLowerCase();
  let action: 'BUY' | 'SELL' | 'CLOSE' | 'SHORT' | 'COVER' = 'BUY';
  if (/\bcover(ing)?\b/.test(lower) || /\bbuy\s+to\s+cover\b/.test(lower)) {
    action = 'COVER';
  } else if (/\bclose\b|\bexit\b|\bsell\s+all\b/.test(lower)) {
    action = 'CLOSE';
  } else if (/\bshort(\s+sell)?\b|\bshorting\b/.test(lower) && !/\bshort\s+term\b/.test(lower)) {
    action = 'SHORT';
  } else if (/\bsell\b/.test(lower)) {
    action = 'SELL';
  } else if (/\bbuy\b|\bpurchase\b|\bacquire\b/.test(lower)) {
    action = 'BUY';
  }
  const direction = deriveDirectionFromAction(action);
  // Only accept high-confidence ticker matches. The HK regex and the
  // general uppercase token scan both produce false positives on common
  // share counts (buy 1000 NVDA) and stray letters (Buy 30 minimax ->
  // ticker "N"). The LLM path corrects these; the fallback must not
  // pretend to know better. Bail to null and flag needs_confirmation.
  const resolved = resolveTicker(command);
  const HIGH_CONFIDENCE: ReadonlyArray<ResolvedTicker['source']> = ['company', 'suffixed', 'fx', 'future'];
  const ticker =
    resolved && HIGH_CONFIDENCE.includes(resolved.source) ? resolved.ticker : null;

  let qty: number | string | null = null;
  let notional: number | null = null;
  const notionalHit = parseNotional(command);
  if (notionalHit != null) {
    notional = notionalHit;
  } else {
    const shareHit = parseShareCount(command);
    if (shareHit != null) {
      qty = shareHit;
    } else if (lower.includes('half')) {
      qty = 'HALF';
    } else if (lower.includes('all') || lower.includes('entire')) {
      qty = 'ALL';
    } else {
      qty = null;
    }
  }

  let stopLossPct: number | null = null;
  const stopMatch = lower.match(/(\d+(?:\.\d+)?)\s*%\s*(?:stop|stop loss|sl)/);
  if (stopMatch) stopLossPct = parseFloat(stopMatch[1]);
  let portfolioName: string | null = null;
  const inMatch = command.match(/in\s+([A-Za-z][A-Za-z\s]*?)(?:,|\s+(?:buy|sell|close|short|cover))/i);
  if (inMatch) portfolioName = inMatch[1].trim();

  const actionLabel: Record<typeof action, string> = {
    BUY: 'Buy',
    SELL: 'Sell',
    CLOSE: 'Close',
    SHORT: 'Short',
    COVER: 'Cover',
  };
  const explanationParts: string[] = [actionLabel[action]];
  if (notional != null) explanationParts.push(`$${notional.toLocaleString()}`);
  if (qty != null) explanationParts.push(`${qty}`);
  explanationParts.push(ticker || '???');
  explanationParts.push(`at ${lower.includes('limit') ? 'limit' : 'market'} price`);
  if (stopLossPct) explanationParts.push(`with ${stopLossPct}% stop loss`);

  return {
    portfolio_id: null,
    portfolio_name: portfolioName,
    action,
    direction,
    ticker,
    qty,
    notional,
    price_type: lower.includes('limit') ? 'LIMIT' : 'MARKET',
    limit_price: null,
    stop_loss_pct: stopLossPct,
    confidence: 0.7,
    needs_confirmation: !ticker || (notional == null && qty == null),
    explanation: explanationParts.join(' '),
    original_command: command,
    trade_date: null,
    time_of_day: detectTimeOfDay(command),
    is_historical: false,
    preview_qty: null,
  };
}

/**
 * Safety net: accept whatever the LLM returned, coerce types, fill
 * missing fields with safe defaults.
 */
function validateAndNormalize(raw: any, command: string): ParsedCommand {
  // Action whitelist expanded to include SHORT and COVER. Unknown
  // values fall back to BUY (matches the old behaviour).
  const validActions: Array<'BUY' | 'SELL' | 'CLOSE' | 'SHORT' | 'COVER'> =
    ['BUY', 'SELL', 'CLOSE', 'SHORT', 'COVER'];
  const action: 'BUY' | 'SELL' | 'CLOSE' | 'SHORT' | 'COVER' =
    validActions.includes(raw?.action) ? raw.action : 'BUY';
  const direction = deriveDirectionFromAction(action);

  const priceType: 'MARKET' | 'LIMIT' | 'STOP' =
    ['MARKET', 'LIMIT', 'STOP'].includes(raw?.price_type) ? raw.price_type : 'MARKET';

  let qty: number | string | null = raw?.qty ?? null;
  if (typeof qty === 'number' && !Number.isFinite(qty)) qty = null;
  if (typeof qty === 'string' && !['ALL', 'HALF'].includes(qty)) {
    const n = Number(qty);
    qty = Number.isFinite(n) ? n : null;
  }

  const numOrNull = (v: any): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const limitPrice = numOrNull(raw?.limit_price);
  const stopLossPct = numOrNull(raw?.stop_loss_pct);

  let confidence = numOrNull(raw?.confidence);
  if (confidence == null) confidence = 0.7;
  confidence = Math.max(0, Math.min(1, confidence));

  const todayIso = new Date().toISOString().slice(0, 10);
  const tradeDate =
    typeof raw?.trade_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trade_date)
      ? raw.trade_date
      : null;
  const isHistorical = tradeDate != null && tradeDate < todayIso;

  const notional = numOrNull(raw?.notional);

  const timeOfDayRaw = raw?.time_of_day;
  const validSessions = ['pre', 'open', 'regular', 'close', 'post', 'eod'];
  const timeOfDay: 'pre' | 'open' | 'regular' | 'close' | 'post' | 'eod' | null =
    typeof timeOfDayRaw === 'string' && validSessions.includes(timeOfDayRaw)
      ? (timeOfDayRaw as 'pre' | 'open' | 'regular' | 'close' | 'post' | 'eod')
      : null;

  return {
    portfolio_id: typeof raw?.portfolio_id === 'string' ? raw.portfolio_id : null,
    portfolio_name: typeof raw?.portfolio_name === 'string' ? raw.portfolio_name : null,
    action,
    direction,
    ticker: typeof raw?.ticker === 'string' ? raw.ticker.toUpperCase() : null,
    qty,
    notional: notional != null && notional > 0 ? notional : null,
    price_type: priceType,
    limit_price: limitPrice,
    stop_loss_pct: stopLossPct,
    confidence,
    needs_confirmation: Boolean(raw?.needs_confirmation),
    explanation: typeof raw?.explanation === 'string' ? raw.explanation : '',
    original_command: command,
    trade_date: tradeDate,
    time_of_day: timeOfDay,
    is_historical: isHistorical,
    preview_qty: null,
  };
}

/**
 * Run the LLM (or the regex fallback) and return a normalized
 * ParsedCommand. Never throws.
 */
async function parseCommand(
  command: string,
  marketContext: string,
  sessionContext: string,
  customInstructions: string,
): Promise<ParsedCommand> {
  const fallback = simpleParse(command);

  const systemPrompt = buildSystemPrompt(customInstructions);
  // Market + session context go in the user message (per workstream
  // 4b: shrinks the system prompt from ~3k to ~1k tokens).
  const userPrompt = [
    sessionContext,
    '',
    marketContext,
    '',
    `User command: ${command}`,
  ].join('\n');

  // Self-critique step: if the LLM is uncertain, re-prompt with a
  // yes/no question. Cheap, usually instant.
  const liteResult = await callLLM(systemPrompt, userPrompt, GEMINI_LITE_URL);
  if (!liteResult) return fallback;

  let parsed = validateAndNormalize(liteResult, command);

  if (parsed.confidence < 0.8 && parsed.ticker) {
    const critSystem = `You are a trade-command disambiguator. Answer with a single JSON object: {"answer": "yes" or "no", "reason": "..."}.`;
    const critPrompt = `Did the user mean ticker ${parsed.ticker} for command: "${command}"? Consider context: action verb, asset class, position size. Answer concisely.`;
    const crit = await callLLM(critSystem, critPrompt, GEMINI_FALLBACK_URL, LLM_CRITIQUE_TIMEOUT_MS);
    if (crit && typeof crit.answer === 'string') {
      if (crit.answer.toLowerCase() === 'no') {
        parsed.needs_confirmation = true;
        parsed.explanation = (parsed.explanation || '') +
          ` (self-critique: ticker ${parsed.ticker} may be wrong — ${crit.reason || 'low confidence'})`;
      } else {
        parsed.confidence = Math.min(1, parsed.confidence + 0.1);
      }
    }
  }

  return parsed;
}

// =====================================================================
// 7. HTTP entry
// =====================================================================

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request) => {
  // Optional Origin allowlist (ALLOWED_ORIGINS env var). The Supabase
  // gateway handles the actual CORS preflight + headers; this is a
  // single explicit config point if you want to lock things down at
  // the function layer too. Skip for OPTIONS — the gateway owns preflight.
  if (req.method !== 'OPTIONS') {
    const originErr = checkOrigin(req);
    if (originErr) return originErr;
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
    }
    // Pass the user's JWT through to inner market-data calls instead
    // of a separate INTERNAL_API_KEY — one credential, one source of
    // truth. Safe because market-data only reads the relay, not
    // user-scoped data.
    const userAuth = req.headers.get('Authorization')!;

    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const route = pathParts[pathParts.length - 1] || '';

    if (req.method === 'POST' && route === 'parse') {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ success: false, error: 'Body must be JSON' }, 400);
      }
      const command = body?.command;
      if (typeof command !== 'string' || !command.trim()) {
        return jsonResponse(
          { success: false, error: '`command` (string) is required' },
          400,
        );
      }

      // 60s in-memory LRU. Keyed by (user, command) so the same input
      // from the same user in a 60s window is a cache hit.
      const cacheKey = `${user.id}:${command}`;
      const cached = cacheGet(cacheKey);
      if (cached) {
        // Re-fetch market context for the cached result so the
        // response still reflects current prices, but skip the LLM.
        const resolved = resolveTicker(command);
        let displayPrice: number | null = null;
        let marketContext = '';
        if (resolved) {
          const live = await ensureFreshQuote(resolved.ticker, userAuth);
          displayPrice = live.quote?.current_price ?? null;
          marketContext = live.quote
            ? formatMarketContext(live.quote, resolved.ticker)
            : '';
        }
        return jsonResponse({
          success: true,
          data: {
            ...cached,
            market_price: displayPrice,
            market_context: marketContext,
            from_cache: true,
            price_unavailable_reason: null,
            preview_qty: null,
          },
        });
      }

      // Load the user's portfolios for prompt context
      const { data: portfolios } = await supabaseAdmin
        .from('portfolios')
        .select('id, name')
        .eq('user_id', user.id)
        .eq('is_archived', false);
      const portfolioList =
        (portfolios || []).map((p: any) => `${p.name} (${p.id})`).join(', ') || 'None';

      const resolved = resolveTicker(command);
      const detectedDate = detectDate(command);
      const detectedTimeOfDay = detectTimeOfDay(command);
      const todayIso = new Date().toISOString().slice(0, 10);
      const detectedIsHistorical =
        detectedDate != null && detectedDate < todayIso;

      let marketQuote: MarketQuote | null = null;
      let historicalPrice: number | null = null;
      let historicalDate: string | null = null;
      let priceUnavailableReason: string | null = null;

      if (resolved && detectedIsHistorical) {
        const hist = await fetchHistoricalPrice(resolved.ticker, detectedDate!, userAuth);
        if (hist) {
          historicalPrice = hist.close_price;
          historicalDate = hist.date;
          marketQuote = {
            ticker: resolved.ticker,
            current_price: hist.close_price,
            previous_close: null,
            change_pct: null,
            day_high: null,
            day_low: null,
            company_name: resolved.matchedTerm,
            sector: null,
            last_updated: new Date().toISOString(),
            from_cache: false,
          };
        } else {
          console.warn(`Historical fetch failed for ${resolved.ticker}@${detectedDate}, trying live fallback`);
          const live = await ensureFreshQuote(resolved.ticker, userAuth);
          marketQuote = live.quote;
          if (!live.quote) priceUnavailableReason = `historical: ${live.unavailable_reason}`;
        }
      } else if (resolved) {
        const live = await ensureFreshQuote(resolved.ticker, userAuth);
        marketQuote = live.quote;
        priceUnavailableReason = live.unavailable_reason;
      } else {
        priceUnavailableReason = 'no ticker detected in command';
      }

      const marketContext = marketQuote
        ? (historicalPrice
            ? `Market data for ${resolved!.ticker} as of ${historicalDate}: close=$${historicalPrice.toFixed(2)}, source=bloomberg historical.`
            : formatMarketContext(marketQuote, resolved!.ticker))
        : `Market data for the requested ticker: unavailable${priceUnavailableReason ? ` (${priceUnavailableReason})` : ''}. The user may need to specify a limit price or check the bloomberg relay (see SETUP.md).`;

      const sessionContext = buildSessionContext();
      const customInstructions = await loadSystemInstructions();

      // Build a richer system prompt that includes the user's
      // portfolio list (small string, no big cost). The market
      // context stays in the user message.
      const systemPromptWithPortfolios =
        buildSystemPrompt(customInstructions) + `\n\nAvailable portfolios: ${portfolioList}`;

      const parsed = await parseCommand(
        command,
        marketContext,
        sessionContext,
        systemPromptWithPortfolios,
      );

      const finalTicker = parsed.ticker ?? resolved?.ticker ?? null;
      const finalTradeDate = parsed.trade_date ?? detectedDate ?? null;
      const finalIsHistorical =
        finalTradeDate != null && finalTradeDate < todayIso;
      const finalTimeOfDay = parsed.time_of_day ?? detectedTimeOfDay ?? null;
      const finalParsed: ParsedCommand = {
        ...parsed,
        ticker: finalTicker,
        trade_date: finalTradeDate,
        time_of_day: finalTimeOfDay,
        is_historical: finalIsHistorical,
      };

      const resolvedPrice =
        finalParsed.limit_price ?? historicalPrice ?? marketQuote?.current_price ?? null;
      const displayPrice = historicalPrice ?? marketQuote?.current_price ?? null;

      // Informational preview only — the system, not the LLM, owns
      // the authoritative qty. The frontend shows this so the user
      // can see ~how many shares the notional will buy at the
      // displayed price; the actual qty is recomputed at click time
      // by executeTrade() using the freshest cached price.
      let previewQty: number | null = null;
      if (finalParsed.notional != null && resolvedPrice != null && resolvedPrice > 0) {
        previewQty = Math.floor(finalParsed.notional / resolvedPrice);
        finalParsed.preview_qty = previewQty;
        finalParsed.explanation = (finalParsed.explanation || '') +
          ` (preview: ~${previewQty.toLocaleString()} sh @ $${resolvedPrice.toFixed(2)}; resolved at execute time)`;
      }

      // Verify the LLM-supplied portfolio_id actually belongs to this
      // user. `ai_chat_history` is written via the service-role client
      // (bypasses RLS), and the FK to `portfolios(id)` succeeds even
      // for another user's portfolio. Drop to null and flag
      // `needs_confirmation` if the LLM invented or cross-user-leaked
      // a portfolio id.
      let safePortfolioId: string | null = finalParsed.portfolio_id;
      if (safePortfolioId) {
        const { data: owned } = await supabaseAdmin
          .from('portfolios')
          .select('id')
          .eq('id', safePortfolioId)
          .eq('user_id', user.id)
          .maybeSingle();
        if (!owned) {
          console.warn(
            `ai-service: dropping cross-user portfolio_id ${safePortfolioId} for user ${user.id}`,
          );
          safePortfolioId = null;
          finalParsed.portfolio_id = null;
          finalParsed.needs_confirmation = true;
          finalParsed.explanation = (finalParsed.explanation || '') +
            ' (portfolio id rejected: not owned by current user)';
        }
      }

      // Save BOTH turns to chat history.
      const baseTurn = {
        user_id: user.id,
        portfolio_id: safePortfolioId,
        parsed_command: { ...finalParsed, portfolio_id: safePortfolioId },
      };
      await supabaseAdmin.from('ai_chat_history').insert([
        { ...baseTurn, role: 'user',      content: command },
        { ...baseTurn, role: 'assistant', content: finalParsed.explanation || 'Parsed trade command.' },
      ]);

      // Store in the in-memory LRU so a quick re-Parse doesn't
      // re-run the LLM.
      cacheSet(cacheKey, finalParsed);

      return jsonResponse({
        success: true,
        data: {
          ...finalParsed,
          market_price: displayPrice,
          market_change_pct: marketQuote?.change_pct ?? null,
          market_context: marketContext,
          resolved_price: resolvedPrice,
          from_cache: marketQuote?.from_cache ?? null,
          price_unavailable_reason: priceUnavailableReason,
        },
      });
    }

    if (req.method === 'GET' && route === 'history') {
      const portfolioId = url.searchParams.get('portfolio_id');
      const limit = parseInt(url.searchParams.get('limit') || '20');
      let query = supabaseAdmin
        .from('ai_chat_history')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (portfolioId) query = query.eq('portfolio_id', portfolioId);
      const { data, error } = await query;
      if (error) throw error;
      return jsonResponse({ success: true, data });
    }

    return jsonResponse(
      { success: false, error: `Unknown route: ${req.method} /${route}` },
      404,
    );
  } catch (err) {
    console.error('ai-service unhandled error:', err);
    return jsonResponse(
      { success: false, error: (err as Error).message || 'Internal error' },
      500,
    );
  }
});
