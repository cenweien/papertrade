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
import { jsonResponse, handleOptions } from '../_shared/cors.ts';

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

// =====================================================================
// 2. Types
//
// Canonical model: a parsed command is an ordered list of `legs`.
// Every leg is fully self-describing (verb, ticker, qty/notional,
// price_type, limit_price, stop_loss_pct, trade_date, time_of_day).
// There is no global action/ticker/date anymore — single-ticker
// commands are simply a 1-element legs array.
//
// This makes "buy AAPL short TSLA 3 days ago" or
// "buy AAPL yesterday at open, short TSLA last week" expressible
// directly, and prevents the LLM from hallucinating a global ticker
// (the SPCX→SPCE class of bug).
// =====================================================================

export type LegAction = 'BUY' | 'SELL' | 'CLOSE' | 'SHORT' | 'COVER';
export type LegDirection = 'LONG' | 'SHORT';
export type PriceType = 'MARKET' | 'LIMIT' | 'STOP';
export type TimeOfDay = 'pre' | 'open' | 'regular' | 'close' | 'post' | 'eod';
// How the user expressed the dollar size of this leg. The system
// resolves anything other than USD into a USD notional at execute
// time using the live portfolio state (so the LLM never has to
// guess a share count from a percentage).
//
//   USD                — explicit $X / X dollars / Xk worth
//   PCT_PORTFOLIO      — "10% of my portfolio" / "10% of equity / NAV / holdings"
//   PCT_CASH           — "10% of my cash"
//   FRACTION_PORTFOLIO — "half my portfolio" / "a quarter of equity"
//   FRACTION_CASH      — "half my cash" / "a quarter of available cash"
export type NotionalBasis =
  | 'USD'
  | 'PCT_PORTFOLIO'
  | 'PCT_CASH'
  | 'FRACTION_PORTFOLIO'
  | 'FRACTION_CASH';

interface ParsedLeg {
  // The verb that applies to THIS ticker. The LLM commits to this
  // directly in its `legs` output (no global action to override).
  action: LegAction;
  direction: LegDirection;
  ticker: string;
  // Share count, "ALL", "HALF", or null when the user spoke in USD.
  qty: number | string | null;
  // USD amount the user wants to spend on this leg. Null when qty
  // was given. The system resolves notional -> qty at execute time.
  notional: number | null;
  // How `notional` (or the leg's dollar size) was specified. Defaults
  // to 'USD'. See NotionalBasis docs above for the full list.
  notional_basis: NotionalBasis;
  // Percentage (0-100) when basis is PCT_*. Null otherwise.
  // Example: "10% of my portfolio" -> notional_pct: 10.
  notional_pct: number | null;
  // Fraction (0-1) when basis is FRACTION_*. Null otherwise.
  // Example: "half my portfolio" -> notional_fraction: 0.5.
  notional_fraction: number | null;
  price_type: PriceType;
  limit_price: number | null;
  stop_loss_pct: number | null;
  // YYYY-MM-DD, or null if "now". Per-leg so a single command can
  // mix "yesterday" and "last week" across tickers.
  trade_date: string | null;
  time_of_day: TimeOfDay | null;
  // Populated server-side after market lookup.
  market_price: number | null;
  resolved_price: number | null;
  // Informational: floor(notional / resolved_price) for notional-based
  // legs. The authoritative qty is recomputed at execute time, but
  // seeding this lets the UI display a real share count immediately
  // (instead of an empty "qty" box) and lets the user edit it before
  // clicking Execute. Null when qty was given explicitly, or when
  // we don't yet have a price to divide into the notional.
  preview_qty: number | null;
  price_unavailable_reason: string | null;
  ticker_suggestion: string | null;
  company_name: string | null;
  sector: string | null;
  from_cache: boolean | null;
}

interface ParsedCommand {
  portfolio_id: string | null;
  portfolio_name: string | null;
  // Canonical. Always non-null and >= 1 element after validation.
  // A "Buy 100 AAPL" command produces [{ action: 'BUY', ticker: 'AAPL', qty: 100, ... }].
  legs: ParsedLeg[];
  // Aggregate flags. `is_historical` is true if ANY leg has a
  // trade_date in the past. The LLM never sets these — the system
  // derives them.
  is_historical: boolean;
  // Self-rated 0-1 confidence. LLM supplies; system uses it to
  // gate the self-critique step and to badge the UI.
  confidence: number;
  needs_confirmation: boolean;
  explanation: string;
  original_command: string;
  // Informational only: total shares the notional would buy at the
  // current price across all notional-based legs. The authoritative
  // qty is recomputed at click time by executeTrade().
  preview_qty: number | null;
  // Convenience: market context line for the primary (first) leg.
  // The per-leg `market_price` / `resolved_price` are the
  // authoritative numbers; this is just for the chat-bubble header.
  market_context: string;
  // Below: legacy fields the frontend still reads. They mirror the
  // first leg so single-ticker commands keep working without a
  // frontend refactor. Multi-leg commands ALSO populate them with
  // the first leg's data; the frontend should prefer `legs[]`.
  // (Will be removed once the frontend migration lands.)
  action: LegAction;
  direction: LegDirection;
  ticker: string | null;
  qty: number | string | null;
  price_type: PriceType;
  limit_price: number | null;
  stop_loss_pct: number | null;
  trade_date: string | null;
  time_of_day: TimeOfDay | null;
  notional: number | null;
  ticker_suggestion: string | null;
  price_unavailable_reason: string | null;
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
  // Common brand / colloquial names the regex misses and the LLM
  // otherwise echoes verbatim (e.g. "buy sandisk" -> SANDISK instead
  // of the real NASDAQ ticker SNDK; "buy lily" -> LILY instead of
  // LLY). Longer phrases precede their substrings because keys are
  // sorted by length desc before lookup.
  sandisk: 'SNDK',
  'eli lilly': 'LLY',
  lily: 'LLY',
};

// =====================================================================
// 2e. Known tickers (fuzzy-correction + LLM disambiguation hint)
//
// A curated list of well-known US-listed tickers (equities + ETFs +
// the most-traded futures). Used to:
//   1. Suggest a correction when the user mistypes a ticker (e.g.
//      "APPL" -> "AAPL") via Levenshtein distance.
//   2. Hand the LLM a hint of the valid ticker space so it can pick
//      from real symbols rather than inventing nonsense.
//
// The list is intentionally compact (~250 entries) so the function
// bundle stays under 1MB. Coverage targets the top 200 S&P 500 names,
// major ETFs, and the most-traded CME futures. Anything outside this
// list is still allowed (resolveTicker and the LLM both pass it
// through) — the list is a hint, not a gate.
// =====================================================================

const KNOWN_TICKERS: ReadonlySet<string> = new Set([
  // Mega-cap US equities (S&P 50 + a few popular names)
  'AAPL','MSFT','GOOGL','GOOG','AMZN','META','NVDA','TSLA','BRK.B','BRK.B',
  'UNH','XOM','JNJ','JPM','V','MA','PG','HD','CVX','AVGO','LLY','ABBV','PFE',
  'KO','PEP','COST','WMT','MRK','DIS','CSCO','ACN','TMO','ABT','CRM','VZ',
  'NKE','ADBE','NFLX','INTC','AMD','QCOM','TXN','HON','IBM','GS','MS','WFC',
  'BA','CAT','GE','GM','F','TM','HMC','NVS','AZN','ASML','TSM','BABA','PDD',
  'ORCL','SAP','SHOP','UBER','LYFT','ABNB','SNAP','PINS','RBLX','SPOT','SQ',
  'PYPL','COIN','HOOD','SOFI','PLTR','SNOW','CRWD','NET','DDOG','ZS','PANW',
  'FTNT','OKTA','MDB','TEAM','TWLO','DOCU','ZM','ROKU','TTD','AMAT','LRCX',
  'KLAC','MRVL','MU','WDC','STX','NTAP','SMCI','ARM','DELL','HPQ','HPE',
  'CSX','UNP','NSC','FDX','UPS','DAL','UAL','AAL','LUV','JBLU','RCL','NCLH',
  'MAR','HLT','MGM','WYNN','LVS','CZR','DKNG','PENN','DPZ','CMG','YUM','DPZ',
  'SBUX','MCD','CMG','WEN','DPZ','TXRH','CAKE','EAT','DRI','BLMN','TXRH',
  'OXY','SLB','BKR','HAL','DVN','EOG','PXD','COP','PSX','VLO','MPC','KMI',
  'WMB','OKE','EPD','ENB','TRP','PAA','MPLX','NEE','DUK','SO','D','AEP','EXC',
  'XEL','SRE','WEC','ED','PEG','ES','AWK','ATO','CMS','CNP','DTE','EIX','ETR',
  'FE','NI','OGE','PNW','PPL','XEL','VST','CEG','NRG','AES','NEE','BEP','NEP',
  'MO','PM','BTI','UL','STZ','DEO','BUD','TAP','SAM','CCU','FIBR','VICI','GLPI',
  'PLD','AMT','EQIX','DLR','PSA','O','WPC','VICI','SPG','REG','FRT','KIM','MAC',
  'AVB','EQR','ESS','MAA','CPT','UDR','CPT','AIRC','AMH','INVH','NXRT','EPRT',
  'JNPR','CIEN','NOK','ERIC','ADTRAN','LITE','OCLR','COMM','IIVI','AAOI','FNSR',
  'GTLB','PD','FROG','ESTC','S','MDB','CFLT','SUMO','PRGS','MANH','CDW','GWW',
  'FAST','POOL','WCC','WSM','RH','BBY','ANF','URBN','GPS','M','KSS','JWN','DKS',
  'TGT','DG','DLTR','FIVE','OLLI','W','CHWY','CHEWY','PETS','WOOF','BMO','BNS',
  'TD','RBC','USB','PNC','TFC','KEY','CFG','RF','CFG','FITB','HBAN','MTB','ZION',
  'C','BAC','WFC','JPM','GS','MS','BLK','SCHW','ETFC','AMTD','RJF','SF','LPLA',
  'HOOD','IBKR','MKTX','TW','VIRT','COHR','LPL','LM','NMR','RVTY','TMO','DHR',
  'A','ABT','BAX','BDX','BSX','MDT','SYK','ZBH','STE','TFX','HOLX','ALGN','TXRH',
  'EW','BSX','MDT','SYK','ZBH','STE','HOLX','BAX','BDX','VAR','VREX','TMDX','GKOS',
  'PODD','ROLL','WCC','RBC','AIT','FAST','POOL','WSC','WSM','GWW','HEI','TDY',
  'HUBB','AIT','FERG','BLDR','SUM','OC','VMC','MLI','MHO','PHM','DHI','LEN','KBH',
  'TOL','MTH','TMHC','CCS','GRBK','HOV','MDC','BZH','TPH','DFH','MHO','OC','VMC',
  // Major ETFs
  'SPY','QQQ','IWM','DIA','VOO','VTI','VEA','VWO','EFA','EEM','IEFA','IEMG',
  'AGG','BND','TLT','SHY','IEF','BIL','GLD','SLV','IAU','USO','UNG','DBC','DBA',
  'VNQ','IYR','XLK','XLF','XLE','XLV','XLY','XLP','XLI','XLU','XLB','XLC','XLRE',
  'JETS','KOMP','SOXX','SMH','IBB','XBI','ARKW','ARKK','ARKF','ARKG','ARKQ','ARKX',
  'HYG','LQD','MUB','TIP','BKLN','JNK','EMB','CWB','FXE','FXY','FXB','FXA','FXC',
  'UPRO','TQQQ','SQQQ','SPXS','SPXL','SOXL','SOXS','TNA','TZA','FAS','FAZ','TECL',
  'TECS','UVXY','SVXY','VXX','VIXY','BTAL','BTCO','BITO','GBTC','ETHE','ETCG','ETHE',
  // Futures (CME most-traded)
  'ES','NQ','YM','RTY','CL','GC','SI','HG','NG','ZN','ZB','ZF','ZT','6E','6B',
  '6J','6A','6C','6S','6M','6N','6R','E7','B7','J7','A7','S7','C7','MES','MNQ',
  'MYM','M2K','MCL','MGC','MSI','MHG','MNG','MZN','MZB','MZF','MZT','M6E','M6B',
  // Crypto-adjacent equities (proxies)
  'MSTR','COIN','RIOT','MARA','HUT','CLSK','BTBT','CAN','IREN','CORZ','CIFR','WULF',
  // Popular SPACs, recent IPOs, and sector plays
  'ARM','DASH','CAVA','Birkenstock','BIRK','KVUE','ODD','PYCR','PATH','RSI','MSGE',
  'CROX','CELH','ELF','GLOB','FROG','BROS','CAKE','DUOL','SOFI','OPEN','UPST',
  'AFRM','BMBL','RSVR','GTLB','DOCN','GTLB','PRGS','HCP','VICI','RHP','PK','PEAK',
  'DOC','HIMS','TDOC','RDFN','OPEN','Z','ZG','RBLX','U','DKNG','PENN','MGM','LVS',
  // Tickers the LLM commonly confuses with each other (Levenshtein
  // distance <= 2). Without these, the system can't suggest a
  // correction when the user mistypes one for the other. Add new
  // pairs here as they come up. The list is for fuzzy correction
  // only — it does not gate any ticker from being used.
  'SPCE','SPCX','SPC','Virgin','SPCE','ASTR','RKLB','PL',
  'F','GE','GM','FORD','GM','RACE','STLA','TM',
  'META','MVIS','GOOG','GOOGL','BRK.B',
]);

/**
 * Levenshtein distance between two short strings. Iterative O(n*m)
 * implementation, no allocations beyond two arrays. Used for fuzzy
 * ticker correction; both inputs are at most ~6 chars so the inner
 * loop is bounded.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Find a known ticker close to `ticker`. Returns the closest
 * match (by Levenshtein distance) if and only if the distance is at
 * most 2 AND the input has at least 3 characters AND the input isn't
 * already a known ticker. Returns null otherwise.
 *
 * Conservative thresholds: we don't want to "correct" a perfectly
 * valid niche ticker into a popular one (e.g. user really did mean
 * rare "ZIM" and we'd never auto-correct that, distance is 2+ to
 * any popular name).
 */
function suggestTickerCorrection(ticker: string): string | null {
  if (!ticker) return null;
  const upper = ticker.toUpperCase();
  if (upper.length < 3) return null;
  if (KNOWN_TICKERS.has(upper)) return null;
  let best: { ticker: string; distance: number } | null = null;
  for (const known of KNOWN_TICKERS) {
    // Quick length-based filter: a 1-char or 2-char edit is the most
    // we accept, so the lengths can't differ by more than 2.
    if (Math.abs(known.length - upper.length) > 2) continue;
    const d = levenshtein(upper, known);
    if (d <= 2 && (best == null || d < best.distance)) {
      best = { ticker: known, distance: d };
    }
  }
  return best ? best.ticker : null;
}

/**
 * Split a natural-language command on common multi-ticker
 * conjunctions and run the single-ticker resolver on each segment.
 * Returns an ordered array of unique resolved tickers.
 *
 * Examples:
 *   "Buy 100 AAPL and 50 MSFT" -> [AAPL, MSFT]
 *   "Short NVDA, buy TSLA"     -> [NVDA, TSLA]
 *   "Buy 100 AAPL"             -> [AAPL]  (single)
 *   "Buy apple"                -> [AAPL]  (via company map)
 *
 * The split is intentionally simple (split on " and ", " & ", " + ",
 * " , ", or sentence-boundary punctuation that follows a ticker
 * shape). For everything else, the single-ticker path is used.
 */
function resolveAllTickers(command: string): ResolvedTicker[] {
  const segments: string[] = [];
  // Split on common conjunctions. We require the conjunction to be
  // surrounded by spaces to avoid breaking ticker shapes like "BRK.B".
  const splitRe = / (?:,|and|&|\+|plus) /i;
  const rawSegments = command.split(splitRe);
  for (const seg of rawSegments) {
    const cleaned = seg.trim();
    if (cleaned) segments.push(cleaned);
  }
  const seen = new Set<string>();
  const out: ResolvedTicker[] = [];
  for (const seg of segments) {
    const r = resolveTicker(seg);
    if (r && !seen.has(r.ticker)) {
      seen.add(r.ticker);
      out.push(r);
    }
  }
  // Fallback: if splitting on conjunctions left us with nothing
  // (the segment split should always produce at least 1), the
  // single-ticker resolver on the full command is the last resort.
  if (out.length === 0) {
    const r = resolveTicker(command);
    if (r) out.push(r);
  }
  return out;
}

// =====================================================================
// 3. LLM call  (Gemini function calling, fast & strict)
// =====================================================================

/**
 * Function-calling schema for Gemini. The LLM is forced to call this
 * function (or return null), giving the strongest schema guarantees
 * and avoiding the cost/error rate of freeform JSON generation.
 *
 * Schema shape: `legs` is the canonical output. The LLM must produce
 * at least one leg per detected ticker, with each leg carrying its
 * own action, qty/notional, price_type, date, and time_of_day. There
 * is no global `action` / `ticker` / `trade_date` field — the
 * previous design forced mixed-verb commands to overwrite the
 * per-leg verb with a single global verb (the "Buy A short B only
 * buys" bug), and the global `ticker` slot was where the LLM
 * hallucinated similar real tickers (the "SPCX → SPCE" bug).
 */
const PARSE_TRADE_FUNCTION = {
  name: 'parse_trade',
  description: 'Extract a structured trade order from the user\'s natural-language command. Output an ordered list of legs; every named ticker is its own leg with its own action verb and date.',
  parameters: {
    type: 'object',
    properties: {
      portfolio_id: { type: 'string', nullable: true, description: 'UUID of the portfolio, or null if unspecified.' },
      portfolio_name: { type: 'string', nullable: true, description: 'Name of the portfolio if the user mentioned one.' },
      confidence: { type: 'number', description: '0.0-1.0 self-rated confidence across all legs.' },
      needs_confirmation: { type: 'boolean', description: 'True if any leg is ambiguous.' },
      explanation: { type: 'string', description: 'Short user-facing explanation of what the command does.' },
      // One entry per ticker named in the command. Single-ticker
      // commands produce a 1-element array. The LLM MUST populate
      // this — there is no fallback `action` / `ticker` slot.
      legs: {
        type: 'array',
        description: 'One entry per ticker. Each leg carries its own verb, qty/notional, price type, and (optional) date.',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['BUY', 'SELL', 'CLOSE', 'SHORT', 'COVER'], description: 'Verb for this specific ticker. Mixed verbs ("buy A and short B") are supported.' },
            ticker: { type: 'string', description: 'Symbol, uppercase. Echo the user\'s input verbatim — do NOT correct typos or substitute a similar-looking ticker.' },
            // Schema quirk: Gemini's stricter validator chokes on
            // oneOf/nullable, so we declare qty as a string and
            // coerce in validateAndNormalize().
            qty: { type: 'string', nullable: true, description: 'Number (as string), "ALL", "HALF", or null if notional was given.' },
            notional: { type: 'number', nullable: true, description: 'USD for this leg, or null if qty was given.' },
            // NEW: how the user expressed the dollar size. The system
            // resolves non-USD bases at execute time using live
            // portfolio state (you never have to compute a share count
            // from a percentage yourself).
            notional_basis: { type: 'string', enum: ['USD', 'PCT_PORTFOLIO', 'PCT_CASH', 'FRACTION_PORTFOLIO', 'FRACTION_CASH'], nullable: true, description: 'How the user sized this leg. "USD" (default) for $X / X dollars / Xk worth. "PCT_PORTFOLIO" for "10% of my portfolio". "PCT_CASH" for "10% of my cash". "FRACTION_PORTFOLIO" for "half my portfolio" / "a quarter of equity". "FRACTION_CASH" for "half my cash". When you set a non-USD basis, set notional=null and fill notional_pct (0-100) or notional_fraction (0-1) instead.' },
            notional_pct: { type: 'number', nullable: true, description: 'Percentage 0-100. Set when notional_basis is PCT_PORTFOLIO or PCT_CASH. Leave null otherwise. Example: "10% of my portfolio" -> 10.' },
            notional_fraction: { type: 'number', nullable: true, description: 'Fraction 0-1. Set when notional_basis is FRACTION_PORTFOLIO or FRACTION_CASH. Leave null otherwise. Example: "half my portfolio" -> 0.5; "a quarter of equity" -> 0.25.' },
            price_type: { type: 'string', enum: ['MARKET', 'LIMIT', 'STOP'], description: 'Order type for this leg. Defaults to MARKET if unspecified.' },
            limit_price: { type: 'number', nullable: true },
            stop_loss_pct: { type: 'number', nullable: true, description: 'Stop-loss as a percent of entry, e.g. 7 means -7%.' },
            trade_date: { type: 'string', nullable: true, description: 'YYYY-MM-DD if this leg was specified for a past date, else null. "3 days ago" on the whole command sets this on every leg; per-leg dates override.' },
            time_of_day: { type: 'string', nullable: true, enum: ['pre', 'open', 'regular', 'close', 'post', 'eod'] },
          },
          required: ['action', 'ticker'],
        },
      },
    },
    required: ['legs', 'confidence', 'needs_confirmation', 'explanation'],
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
  // Digit is optional so "a year ago" / "year ago" work the same as "1 year ago".
  const n = (s: string | undefined) => parseInt(s || '1', 10);
  if ((m = lower.match(/(\d+)?\s*days?\s*ago/))) return daysAgo(n(m[1]));
  if ((m = lower.match(/(\d+)?\s*weeks?\s*ago/))) return daysAgo(n(m[1]) * 7);
  if ((m = lower.match(/(\d+)?\s*months?\s*ago/))) {
    const d = new Date(today);
    d.setUTCMonth(d.getUTCMonth() - n(m[1]));
    return fmt(d);
  }
  if ((m = lower.match(/(\d+)?\s*years?\s*ago/))) {
    const d = new Date(today);
    d.setUTCFullYear(d.getUTCFullYear() - n(m[1]));
    return fmt(d);
  }
  if ((m = lower.match(/(\d+)?\s*hours?\s*ago/))) {
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

/**
 * Render a 0-1 fraction as a human label ("half", "quarter", ...,
 * else "<n>%"). Used in chat-bubble explanations for legs sized as
 * fractions of portfolio/cash.
 */
function formatFraction(f: number): string {
  if (!Number.isFinite(f) || f <= 0) return '0%';
  if (Math.abs(f - 0.5) < 0.01) return 'half';
  if (Math.abs(f - 0.25) < 0.01) return 'quarter';
  if (Math.abs(f - 1 / 3) < 0.01) return 'third';
  if (Math.abs(f - 0.125) < 0.01) return 'eighth';
  if (Math.abs(f - 0.1) < 0.01) return 'tenth';
  return `${Math.round(f * 1000) / 10}%`;
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

CRITICAL REMINDERS:
1. You MUST populate the \`legs\` array. There is no global action/ticker/trade_date field — every named ticker is its own leg with its own verb.
2. Mixed-verb commands ("buy A and short B") require per-leg \`action\` fields. The system CANNOT recover a mixed-verb trade from a single global action.
3. Per-leg \`trade_date\` and \`time_of_day\` allow commands like "Buy AAPL yesterday at open, short TSLA last week" to produce two different dates.
4. NEVER invent or "correct" a ticker. If the user wrote SPCX, output SPCX — not SPCE. The system runs Levenshtein correction separately.
5. NEVER echo price-type keywords (MARKET, LIMIT, STOP, ENTRY, EXIT) as tickers. These are stopwords and the system strips them.
6. NOTIONAL vs QTY — DO NOT convert between them yourself. If the user spoke in USD ("$1M of NVDA", "$50,000 worth of AAPL", "$25k of TSLA"), set \`qty\` to null and \`notional\` to the dollar amount. If the user spoke in shares ("buy 100 AAPL", "short 50 TSLA"), set \`notional\` to null and \`qty\` to the share count. NEVER set both. NEVER compute share counts from a notional amount — the system owns that math (using the live or historical price) and surfaces the result in the UI; a hard-coded qty you invent will be wrong.

If no portfolio is specified, set portfolio_id to null and the frontend will use the active one. "at market" means MARKET order type. "close" or "exit" means sell the entire position. Always extract ticker symbols in uppercase. Provide a brief explanation of what the command does.

PERCENTAGE / FRACTION SIZING (NEW — read carefully):
When the user expresses the dollar size as a percentage or fraction of their portfolio/cash, set \`notional_basis\` accordingly and leave \`notional\` null. The system resolves the actual dollar amount at execute time using live portfolio state, so you do NOT need to compute a share count.

  - "10% of my portfolio" / "spend 10% of equity on AAPL" / "10% of NAV" / "10% of holdings"
      -> notional_basis: "PCT_PORTFOLIO", notional_pct: 10
  - "10% of my cash" / "10% of available cash"
      -> notional_basis: "PCT_CASH", notional_pct: 10
  - "half my portfolio" / "a quarter of equity" / "half of my holdings"
      -> notional_basis: "FRACTION_PORTFOLIO", notional_fraction: 0.5 / 0.25
  - "half my cash" / "a quarter of my available cash"
      -> notional_basis: "FRACTION_CASH", notional_fraction: 0.5 / 0.25
  - "half on X, half on Y" (no percentage, no "of portfolio")
      -> Each leg gets notional_basis: "FRACTION_PORTFOLIO", notional_fraction: 0.5
         (system treats this as an EQUAL SPLIT of total portfolio equity — half on X,
          half on Y, both measured against the same portfolio base). If the user
         explicitly says "split my cash" / "of available cash", use FRACTION_CASH.

Recognized fractions: half = 0.5, quarter / a quarter = 0.25, third / a third = 0.333, eighth = 0.125, tenth = 0.1. For other fractions, echo the raw number (e.g. "two thirds" -> 0.6667).

The DEFAULT for ambiguous "% of portfolio"-less phrases is portfolio equity. If the user wrote "10% of my portfolio" the answer is unambiguously PCT_PORTFOLIO. If they wrote only "10%" with no base, set notional_basis: "PCT_PORTFOLIO" and add a note in \`explanation\` clarifying which base the system picked (e.g. "(10% of portfolio equity)").`;
}

function deriveDirectionFromAction(action: 'BUY' | 'SELL' | 'CLOSE' | 'SHORT' | 'COVER'): 'LONG' | 'SHORT' {
  return (action === 'SHORT' || action === 'COVER') ? 'SHORT' : 'LONG';
}

/**
 * Infer the action verb that applies to a specific ticker in a
 * multi-ticker command. The LLM is asked to commit to a per-leg
 * verb directly in `legs[].action`, but as a safety net we also
 * scan the original command: for "buy 10 A and short 10 B", we look
 * backwards from the ticker's first occurrence for the most recent
 * action verb.
 *
 * Returns null if no verb is found — caller should fall back to a
 * global action or mark `needs_confirmation`.
 */
function inferLegAction(
  command: string,
  ticker: string,
): 'BUY' | 'SELL' | 'CLOSE' | 'SHORT' | 'COVER' | null {
  const upper = command.toUpperCase();
  const tk = ticker.toUpperCase();
  // Find the first occurrence of the ticker as a standalone word.
  const tkRe = new RegExp(`\\b${tk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const m = upper.match(tkRe);
  if (!m || m.index == null) return null;
  const beforeTicker = upper.slice(0, m.index);
  // Scan backwards for the most recent action verb. The verb may be
  // separated from the ticker by an adverb ("at market", "now"), a
  // date ("2 days ago"), or a price-type keyword — none of those
  // are verbs, so we keep looking back. Past-tense forms (BOUGHT,
  // SOLD) collapse to the present-tense base action.
  const verbRe = /\b(BUY|BOUGHT|SELL|SOLD|SHORT|SHORTED|COVER|COVERED|CLOSE|CLOSED)\b/g;
  let last: RegExpExecArray | null = null;
  let v: RegExpExecArray | null;
  while ((v = verbRe.exec(beforeTicker)) !== null) last = v;
  if (!last) return null;
  const verb = last[1].toUpperCase();
  // Disambiguate "short" from "short term" / "short term investment"
  // (those are not action verbs). Match both whitespace and hyphen
  // separators ("short term" and "short-term").
  if (verb === 'SHORT' || verb === 'SHORTED') {
    const afterVerb = beforeTicker.slice(last.index + verb.length);
    if (/^[-\s]+(TERM|TERM-LONG|TERM-INVESTMENT|TERM-TRADE)\b/i.test(afterVerb)) {
      return null;
    }
  }
  // Map past tense to present.
  if (verb === 'BOUGHT') return 'BUY';
  if (verb === 'SOLD') return 'SELL';
  if (verb === 'SHORTED') return 'SHORT';
  if (verb === 'COVERED') return 'COVER';
  if (verb === 'CLOSED') return 'CLOSE';
  return verb as 'BUY' | 'SELL' | 'CLOSE' | 'SHORT' | 'COVER';
}

/**
 * Infer the per-leg date and time_of_day by looking at the chunk of
 * the command that precedes this ticker's first occurrence. We
 * extract a date from "before" the ticker if the user wrote something
 * like "buy AAPL yesterday, short TSLA last week" — each leg gets
 * the date closest to (and before) it in the original text.
 *
 * Returns null for both fields when the user didn't speak in dates
 * for that leg.
 */
function inferLegDateTime(
  command: string,
  ticker: string,
): { trade_date: string | null; time_of_day: TimeOfDay | null } {
  const upper = command.toUpperCase();
  const tk = ticker.toUpperCase();
  const tkRe = new RegExp(`\\b${tk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const m = upper.match(tkRe);
  if (!m || m.index == null) return { trade_date: null, time_of_day: null };
  // Look at the half of the command before the ticker AND the
  // ticker's own chunk (which may include a date after it on the
  // same clause). We bias toward the pre-ticker chunk because
  // English orders "verb ... date ... ticker" most of the time.
  const before = command.slice(0, m.index);
  // Detect a date in the surrounding clause. If we find one before
  // the ticker, that's the per-leg date. If not, fall back to a
  // global detectDate() on the full command (which catches "3 days
  // ago" written anywhere in the sentence).
  const localDate = detectDate(before);
  const localTod = detectTimeOfDay(before);
  return {
    trade_date: localDate,
    time_of_day: localTod,
  };
}

/**
 * Parse a percentage / fraction sizing phrase. Returns the basis and
 * the magnitude (pct as 0-100, fraction as 0-1), or null if the user
 * didn't speak in percentages / fractions of their portfolio or cash.
 *
 * Examples:
 *   "spend 10% of my portfolio on AAPL"  -> { basis: 'PCT_PORTFOLIO', pct: 10 }
 *   "put 25% of my cash into NVDA"       -> { basis: 'PCT_CASH', pct: 25 }
 *   "buy a quarter of equity"            -> { basis: 'FRACTION_PORTFOLIO', fraction: 0.25 }
 *   "half my cash"                       -> { basis: 'FRACTION_CASH', fraction: 0.5 }
 *   "half on X, half on Y"               -> { basis: 'FRACTION_PORTFOLIO', fraction: 0.5 } (caller handles multi-leg)
 *   "10% on AAPL" (no base specified)    -> { basis: 'PCT_PORTFOLIO', pct: 10 } (default = portfolio equity)
 *
 * The fraction word-list covers the most common English forms; the
 * LLM path produces more exotic values ("two thirds", "three quarters")
 * and emits them as raw floats via the schema. This regex path is the
 * fallback for when the LLM is unavailable.
 */
function parseNotionalBasis(command: string): {
  basis: 'PCT_PORTFOLIO' | 'PCT_CASH' | 'FRACTION_PORTFOLIO' | 'FRACTION_CASH';
  pct: number | null;
  fraction: number | null;
} | null {
  const lower = command.toLowerCase();

  // ---- Percentages: "10% of my portfolio" / "10% of cash" ----
  // The number is required; the "of X" base is optional (defaults to
  // portfolio equity per the system prompt guidance).
  const pctRe = /(\d+(?:\.\d+)?)\s*(?:%|percent)\s*(?:of\s+(?:my\s+|the\s+|our\s+)?(portfolio|equity|nav|holdings|net\s+worth|account|cash|available\s+cash|buying\s+power))?/i;
  const pctHit = lower.match(pctRe);
  if (pctHit) {
    const pct = parseFloat(pctHit[1]);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
    const base = (pctHit[2] || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (base === 'cash' || base === 'available cash' || base === 'buying power') {
      return { basis: 'PCT_CASH', pct, fraction: null };
    }
    // Default: portfolio equity. "portfolio" / "equity" / "nav" /
    // "holdings" / "net worth" / "account" / no base specified.
    return { basis: 'PCT_PORTFOLIO', pct, fraction: null };
  }

  // ---- Fractions: "half my portfolio" / "a quarter of equity" ----
  // Spelled-out fractions come first because the regex is greedy on
  // numeric patterns. Word list mirrors the prompt's recognition set.
  const fractionWords: Record<string, number> = {
    'half': 0.5,
    'quarter': 0.25,
    'a quarter': 0.25,
    'third': 1 / 3,
    'a third': 1 / 3,
    'eighth': 0.125,
    'tenth': 0.1,
  };
  // (a) Spelled-out fraction with an explicit base.
  const fwRe = new RegExp(
    `\\b(a\\s+)?(${Object.keys(fractionWords).join('|').replace(/\s/g, '\\s+')})\\s+(?:of\\s+(?:my\\s+|the\\s+|our\\s+)?)?(portfolio|equity|nav|holdings|net\\s+worth|cash|available\\s+cash|buying\\s+power)\\b`,
    'i',
  );
  const fwHit = lower.match(fwRe);
  if (fwHit) {
    const phrase = (fwHit[2] || '').toLowerCase().trim();
    const fraction = fractionWords[phrase];
    if (fraction == null) return null;
    const base = (fwHit[3] || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (base === 'cash' || base === 'available cash' || base === 'buying power') {
      return { basis: 'FRACTION_CASH', pct: null, fraction };
    }
    return { basis: 'FRACTION_PORTFOLIO', pct: null, fraction };
  }
  // (b) Bare fraction with no base (e.g. "half on X"). Defaults to
  // portfolio equity — matches the prompt's default interpretation.
  // This is also the path that catches "half on X, half on Y".
  for (const [phrase, value] of Object.entries(fractionWords)) {
    const re = new RegExp(`\\b(?:a\\s+)?${phrase.replace(/\s/g, '\\s+')}\\b`, 'i');
    if (re.test(lower)) {
      return { basis: 'FRACTION_PORTFOLIO', pct: null, fraction: value };
    }
  }

  return null;
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
 * BUY, marks needs_confirmation=true if no ticker was detected.
 *
 * The output is in the new legs-canonical shape: at least one leg
 * in `legs`, and the legacy flat fields mirror the primary (first)
 * leg for back-compat with the existing frontend.
 */
function simpleParse(command: string): ParsedCommand {
  const lower = command.toLowerCase();

  // Resolve tickers (regex). We accept only high-confidence matches
  // (company / suffixed / fx / future) for the fallback path — the
  // HK regex and the general token scan both produce false positives
  // on common share counts and stray letters. The LLM path corrects
  // these; the fallback must not pretend to know better.
  const HIGH_CONFIDENCE: ReadonlyArray<ResolvedTicker['source']> =
    ['company', 'suffixed', 'fx', 'future'];
  const resolved = resolveAllTickers(command);
  const tickers = resolved
    .filter((r) => HIGH_CONFIDENCE.includes(r.source))
    .map((r) => r.ticker);

  // Fallback action (used when no per-ticker verb can be inferred).
  let fallbackAction: 'BUY' | 'SELL' | 'CLOSE' | 'SHORT' | 'COVER' = 'BUY';
  if (/\bcover(ing)?\b/.test(lower) || /\bbuy\s+to\s+cover\b/.test(lower)) {
    fallbackAction = 'COVER';
  } else if (/\bclose\b|\bexit\b|\bsell\s+all\b/.test(lower)) {
    fallbackAction = 'CLOSE';
  } else if (/\bshort(\s+sell)?\b|\bshorting\b/.test(lower) && !/\bshort\s+term\b/.test(lower)) {
    fallbackAction = 'SHORT';
  } else if (/\bsell\b/.test(lower)) {
    fallbackAction = 'SELL';
  } else if (/\bbuy\b|\bpurchase\b|\bacquire\b/.test(lower)) {
    fallbackAction = 'BUY';
  }

  // Single-ticker shortcut for qty/notional/stop: we don't yet know
  // whether the user spoke for one ticker or many, so we run the
  // numeric parsers ONCE on the whole command. If multi-ticker, the
  // qty/notional will be wrong for legs 2..N — the LLM path
  // produces accurate per-leg numbers and supersedes this.
  let qty: number | string | null = null;
  let notional: number | null = null;
  // notional_basis / notional_pct / notional_fraction default to
  // USD/null and are populated only when the user spoke in
  // percentages or fractions. The system resolves these to a USD
  // notional at execute time using the live portfolio state.
  let notionalBasis: NotionalBasis = 'USD';
  let notionalPct: number | null = null;
  let notionalFraction: number | null = null;
  const notionalHit = parseNotional(command);
  if (notionalHit != null) {
    notional = notionalHit;
  } else {
    const basisHit = parseNotionalBasis(command);
    if (basisHit != null) {
      // Percentage / fraction sizing — leave notional null so the
      // system knows to resolve at execute time.
      notionalBasis = basisHit.basis;
      notionalPct = basisHit.pct;
      notionalFraction = basisHit.fraction;
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
  }

  let stopLossPct: number | null = null;
  const stopMatch = lower.match(/(\d+(?:\.\d+)?)\s*%\s*(?:stop|stop loss|sl)/);
  if (stopMatch) stopLossPct = parseFloat(stopMatch[1]);
  let portfolioName: string | null = null;
  const inMatch = command.match(/in\s+([A-Za-z][A-Za-z\s]*?)(?:,|\s+(?:buy|sell|close|short|cover))/i);
  if (inMatch) portfolioName = inMatch[1].trim();

  const priceType: PriceType = lower.includes('limit') ? 'LIMIT' : 'MARKET';

  // Build legs. The fallback can only identify tickers via regex, so
  // for the LLM-supplied `legs` path this function is a coarse sketch;
  // the parseCommand caller merges / overrides with the LLM output.
  const legs: ParsedLeg[] = tickers.length > 0
    ? tickers.map((tk) => {
        const inferred = inferLegAction(command, tk) ?? fallbackAction;
        const dt = inferLegDateTime(command, tk);
        return {
          action: inferred,
          direction: deriveDirectionFromAction(inferred),
          ticker: tk,
          // qty / notional are command-global here; refine for
          // multi-ticker commands in the leg builder.
          qty: tickers.length === 1 ? qty : null,
          notional: tickers.length === 1 ? notional : null,
          // For multi-ticker percentage / fraction commands ("half
          // on X, half on Y"), every leg gets the same basis so the
          // system resolves them as an equal split.
          notional_basis: tickers.length === 1 ? notionalBasis : (notionalBasis !== 'USD' ? notionalBasis : 'USD'),
          notional_pct: tickers.length === 1 ? notionalPct : (notionalBasis !== 'USD' ? notionalPct : null),
          notional_fraction: tickers.length === 1 ? notionalFraction : (notionalBasis !== 'USD' ? notionalFraction : null),
          price_type: priceType,
          limit_price: null,
          stop_loss_pct: stopLossPct,
          trade_date: dt.trade_date,
          time_of_day: dt.time_of_day,
          market_price: null,
          resolved_price: null,
          preview_qty: null,
          price_unavailable_reason: null,
          ticker_suggestion: null,
          company_name: null,
          sector: null,
          from_cache: null,
        };
      })
    : [{
        // No ticker detected — synthesize a placeholder leg so the
        // shape stays consistent. needs_confirmation will flag it.
        action: fallbackAction,
        direction: deriveDirectionFromAction(fallbackAction),
        ticker: '',
        qty,
        notional,
        notional_basis: notionalBasis,
        notional_pct: notionalPct,
        notional_fraction: notionalFraction,
        price_type: priceType,
        limit_price: null,
        stop_loss_pct: stopLossPct,
        trade_date: null,
        time_of_day: null,
        market_price: null,
        resolved_price: null,
        preview_qty: null,
        price_unavailable_reason: null,
        ticker_suggestion: null,
        company_name: null,
        sector: null,
        from_cache: null,
      }];

  const primary = legs[0];
  const actionLabel: Record<LegAction, string> = {
    BUY: 'Buy', SELL: 'Sell', CLOSE: 'Close', SHORT: 'Short', COVER: 'Cover',
  };
  const explanationParts: string[] = [actionLabel[primary.action]];
  if (primary.notional != null) explanationParts.push(`$${primary.notional.toLocaleString()}`);
  if (primary.qty != null) explanationParts.push(`${primary.qty}`);
  explanationParts.push(primary.ticker || '???');
  explanationParts.push(`at ${priceType === 'LIMIT' ? 'limit' : 'market'} price`);
  if (stopLossPct) explanationParts.push(`with ${stopLossPct}% stop loss`);

  return {
    portfolio_id: null,
    portfolio_name: portfolioName,
    legs,
    is_historical: legs.some((l) =>
      l.trade_date != null && l.trade_date < new Date().toISOString().slice(0, 10)),
    confidence: 0.7,
    needs_confirmation: !primary.ticker || (primary.notional == null && primary.qty == null),
    explanation: explanationParts.join(' '),
    original_command: command,
    preview_qty: null,
    market_context: '',
    // Legacy back-compat fields (mirror primary leg):
    action: primary.action,
    direction: primary.direction,
    ticker: primary.ticker || null,
    qty: primary.qty,
    price_type: primary.price_type,
    limit_price: primary.limit_price,
    stop_loss_pct: primary.stop_loss_pct,
    trade_date: primary.trade_date,
    time_of_day: primary.time_of_day,
    notional: primary.notional,
    ticker_suggestion: null,
    price_unavailable_reason: null,
  };
}

/**
 * Sanitize a ticker value returned by the LLM. The LLM doesn't
 * apply the same stopword list as `resolveTicker`, so it sometimes
 * hallucinates tickers from price-type keywords ("MARKET",
 * "LIMIT", "STOP"), action verbs ("BUY", "SELL"), currency codes,
 * etc. We strip those here and return null instead. The
 * `resolveTicker` regex path is unaffected — this is purely a
 * guardrail on the LLM output.
 */
function sanitizeTicker(raw: any): string | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.toUpperCase().trim();
  if (!upper) return null;
  if (STOPWORDS.has(upper)) return null;
  // Extra defensive: price-type keywords. These are already in
  // STOPWORDS, but listing them again here documents the intent.
  if (['MARKET', 'LIMIT', 'STOP', 'LOSS', 'ENTRY', 'EXIT'].includes(upper)) return null;
  return upper;
}

/**
 * Safety net: accept whatever the LLM returned, coerce types, fill
 * missing fields with safe defaults. Output is the new legs-canonical
 * shape: `legs` is always present and has >= 1 element, and the
 * legacy flat fields mirror the first leg.
 */
function validateAndNormalize(raw: any, command: string): ParsedCommand {
  const numOrNull = (v: any): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const validActions: LegAction[] = ['BUY', 'SELL', 'CLOSE', 'SHORT', 'COVER'];
  const validSessions: TimeOfDay[] = ['pre', 'open', 'regular', 'close', 'post', 'eod'];

  const coerceAction = (v: any, fallback: LegAction): LegAction =>
    typeof v === 'string' && (validActions as string[]).includes(v)
      ? (v as LegAction) : fallback;
  const coercePriceType = (v: any, fallback: PriceType): PriceType =>
    v === 'LIMIT' || v === 'STOP' ? v : fallback === 'LIMIT' || fallback === 'STOP' ? fallback : 'MARKET';
  const coerceTimeOfDay = (v: any): TimeOfDay | null =>
    typeof v === 'string' && (validSessions as string[]).includes(v)
      ? (v as TimeOfDay) : null;
  const coerceTradeDate = (v: any): string | null =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  const coerceQty = (v: any): number | string | null => {
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      if (v === 'ALL' || v === 'HALF') return v;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const coerceNotional = (v: any): number | null => {
    const n = numOrNull(v);
    return n != null && n > 0 ? n : null;
  };

  // Coerce a single leg from whatever the LLM produced. The LLM is
  // expected to commit to a per-leg action/date (the new schema has
  // no global slot for these), but we apply safety nets:
  //   - ticker: sanitize (strip stopwords) and null if empty
  //   - action: drop ticker-fallback if sanitize wiped it
  const coerceLeg = (l: any): ParsedLeg | null => {
    const ticker = sanitizeTicker(l?.ticker);
    if (!ticker) return null;
    const action = coerceAction(l?.action, 'BUY');
    // notional_basis: default USD; whitelist the known values.
    const basisRaw = (l?.notional_basis ?? 'USD').toString();
    const validBases: NotionalBasis[] = ['USD', 'PCT_PORTFOLIO', 'PCT_CASH', 'FRACTION_PORTFOLIO', 'FRACTION_CASH'];
    const notionalBasis: NotionalBasis = (validBases as string[]).includes(basisRaw)
      ? (basisRaw as NotionalBasis)
      : 'USD';
    // pct / fraction: only meaningful when the basis says so. Coerce
    // to sensible ranges; out-of-range values fall back to null.
    const pctRaw = numOrNull(l?.notional_pct);
    const fractionRaw = numOrNull(l?.notional_fraction);
    const notionalPct =
      notionalBasis === 'PCT_PORTFOLIO' || notionalBasis === 'PCT_CASH'
        ? (pctRaw != null && pctRaw > 0 && pctRaw <= 100 ? pctRaw : null)
        : null;
    const notionalFraction =
      notionalBasis === 'FRACTION_PORTFOLIO' || notionalBasis === 'FRACTION_CASH'
        ? (fractionRaw != null && fractionRaw > 0 && fractionRaw <= 1 ? fractionRaw : null)
        : null;
    // Invariant: when the basis is non-USD, `notional` must be null
    // (the system resolves at execute time). The LLM sometimes echoes
    // a notional anyway — drop it here so the frontend's
    // resolveLegBasis() is unambiguous.
    const notional =
      notionalBasis === 'USD' ? coerceNotional(l?.notional) : null;
    return {
      action,
      direction: deriveDirectionFromAction(action),
      ticker,
      qty: coerceQty(l?.qty),
      notional,
      notional_basis: notionalBasis,
      notional_pct: notionalPct,
      notional_fraction: notionalFraction,
      price_type: coercePriceType(l?.price_type, 'MARKET'),
      limit_price: numOrNull(l?.limit_price),
      stop_loss_pct: numOrNull(l?.stop_loss_pct),
      trade_date: coerceTradeDate(l?.trade_date),
      time_of_day: coerceTimeOfDay(l?.time_of_day),
      market_price: null,
      resolved_price: null,
      preview_qty: null,
      price_unavailable_reason: null,
      ticker_suggestion: null,
      company_name: null,
      sector: null,
      from_cache: null,
    };
  };

  // Build the leg list from three sources, in priority order:
  //   1. LLM-supplied `raw.legs` (after coercion + filtering).
  //   2. LLM-supplied `raw.ticker` (legacy single-ticker back-compat
  //      for older function versions that still emit a flat ticker).
  //   3. Regex `resolveAllTickers(command)` (the fallback path).
  // The parse handler later overlays per-leg market data and merges
  // anything the regex path adds that the LLM missed.
  let legs: ParsedLeg[] = [];
  if (Array.isArray(raw?.legs)) {
    for (const l of raw.legs) {
      const coerced = coerceLeg(l);
      if (coerced) legs.push(coerced);
    }
  }
  // If the LLM didn't produce legs but did produce a flat ticker
  // (older schema), promote it to a single leg.
  if (legs.length === 0) {
    const flat = coerceLeg({ ticker: raw?.ticker, action: raw?.action });
    if (flat) legs.push(flat);
  }
  // Last-resort: regex-detected tickers. We attach the LLM's global
  // action/date to each so a single-ticker command still parses
  // cleanly. The leg builder later overlays per-leg inference.
  if (legs.length === 0) {
    const regexResolved = resolveAllTickers(command);
    for (const r of regexResolved) {
      const coerced = coerceLeg({ ticker: r.ticker, action: raw?.action });
      if (coerced) legs.push(coerced);
    }
  }
  // If we STILL have no legs (e.g. the LLM returned nothing and the
  // regex found nothing), synthesize a placeholder so the shape
  // stays consistent. needs_confirmation will flag the missing
  // ticker.
  if (legs.length === 0) {
    legs.push({
      action: coerceAction(raw?.action, 'BUY'),
      direction: 'LONG',
      ticker: '',
      qty: coerceQty(raw?.qty),
      notional: coerceNotional(raw?.notional),
      notional_basis: 'USD',
      notional_pct: null,
      notional_fraction: null,
      price_type: coercePriceType(raw?.price_type, 'MARKET'),
      limit_price: numOrNull(raw?.limit_price),
      stop_loss_pct: numOrNull(raw?.stop_loss_pct),
      trade_date: coerceTradeDate(raw?.trade_date),
      time_of_day: coerceTimeOfDay(raw?.time_of_day),
      market_price: null,
      resolved_price: null,
      preview_qty: null,
      price_unavailable_reason: null,
      ticker_suggestion: null,
      company_name: null,
      sector: null,
      from_cache: null,
    });
  }

  let confidence = numOrNull(raw?.confidence);
  if (confidence == null) confidence = 0.7;
  confidence = Math.max(0, Math.min(1, confidence));

  const todayIso = new Date().toISOString().slice(0, 10);
  const isHistorical = legs.some(
    (l) => l.trade_date != null && l.trade_date < todayIso,
  );

  // Ticker guard: if the LLM produced a leg whose ticker was a
  // stopword, it was dropped above. Flag needs_confirmation so the
  // user is prompted.
  const primary = legs[0];
  const anyTickerWasStopword = Array.isArray(raw?.legs)
    ? raw.legs.some(
        (l: any) => typeof l?.ticker === 'string' && sanitizeTicker(l.ticker) === null,
      )
    : (typeof raw?.ticker === 'string' && sanitizeTicker(raw.ticker) === null);

  const explanation = (() => {
    const base = typeof raw?.explanation === 'string' ? raw.explanation : '';
    if (anyTickerWasStopword) {
      return (base ? base + ' ' : '') +
        `(a ticker was not recognized as a stock symbol — please specify one)`;
    }
    return base;
  })();

  return {
    portfolio_id: typeof raw?.portfolio_id === 'string' ? raw.portfolio_id : null,
    portfolio_name: typeof raw?.portfolio_name === 'string' ? raw.portfolio_name : null,
    legs,
    is_historical: isHistorical,
    confidence,
    needs_confirmation: Boolean(raw?.needs_confirmation) || anyTickerWasStopword,
    explanation,
    original_command: command,
    preview_qty: null,
    market_context: '',
    // Legacy back-compat fields (mirror primary leg):
    action: primary.action,
    direction: primary.direction,
    ticker: primary.ticker || null,
    qty: primary.qty,
    price_type: primary.price_type,
    limit_price: primary.limit_price,
    stop_loss_pct: primary.stop_loss_pct,
    trade_date: primary.trade_date,
    time_of_day: primary.time_of_day,
    notional: primary.notional,
    ticker_suggestion: null,
    price_unavailable_reason: null,
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

  // Self-critique: for the primary ticker, ask the larger model
  // "did the user mean this?" Only fires for single-ticker commands
  // (multi-leg mixed-verb commands are unambiguous per-leg and the
  // critique prompt doesn't generalize cleanly).
  const primaryTicker = parsed.legs[0]?.ticker;
  if (parsed.confidence < 0.8 && primaryTicker) {
    const critSystem = `You are a trade-command disambiguator. Answer with a single JSON object: {"answer": "yes" or "no", "reason": "..."}.`;
    const critPrompt = `Did the user mean ticker ${primaryTicker} for command: "${command}"? Consider context: action verb, asset class, position size. Answer concisely.`;
    const crit = await callLLM(critSystem, critPrompt, GEMINI_FALLBACK_URL, LLM_CRITIQUE_TIMEOUT_MS);
    if (crit && typeof crit.answer === 'string') {
      if (crit.answer.toLowerCase() === 'no') {
        parsed.needs_confirmation = true;
        parsed.explanation = (parsed.explanation || '') +
          ` (self-critique: ticker ${primaryTicker} may be wrong — ${crit.reason || 'low confidence'})`;
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

// CORS handling is in _shared/cors.ts. Functions deployed with
// `--no-verify-jwt` have the gateway forward OPTIONS into the body
// and strip the gateway's own CORS headers, so we set them here on
// every response (preflight + actual).

serve(async (req: Request) => {
  // Short-circuit CORS preflight. The Supabase gateway would normally
  // do this, but with --no-verify-jwt it forwards OPTIONS into the
  // function body — and the body has no Authorization header on a
  // preflight, so the auth check below would 401 and the browser
  // would block the request (no Access-Control-Allow-Origin).
  if (req.method === 'OPTIONS') {
    return handleOptions(req);
  }

  // Optional Origin allowlist (ALLOWED_ORIGINS env var). Single explicit
  // config point if you want to lock things down at the function layer
  // too.
  const originErr = checkOrigin(req);
  if (originErr) return originErr;

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
        // Defensive: re-apply sanitization to the cached result.
        // The cache may contain entries written by an older
        // function version that didn't strip stopword tickers from
        // the LLM's output. Re-sanitizing here ensures the cache
        // doesn't outlive the validation rules.
        const cachedLegs = Array.isArray(cached.legs) ? cached.legs : [];
        const sanitizedLegs: ParsedLeg[] = cachedLegs
          .map((l: any) => {
            const tk = sanitizeTicker(l?.ticker);
            if (!tk) return null;
            return {
              action: l?.action ?? 'BUY',
              direction: l?.direction ?? 'LONG',
              ticker: tk,
              qty: l?.qty ?? null,
              notional: l?.notional ?? null,
              // notional_basis was added later than most other fields;
              // default to USD when reading older cache entries.
              notional_basis: (l?.notional_basis ?? 'USD') as NotionalBasis,
              notional_pct: l?.notional_pct ?? null,
              notional_fraction: l?.notional_fraction ?? null,
              price_type: l?.price_type ?? 'MARKET',
              limit_price: l?.limit_price ?? null,
              stop_loss_pct: l?.stop_loss_pct ?? null,
              trade_date: l?.trade_date ?? null,
              time_of_day: l?.time_of_day ?? null,
              market_price: l?.market_price ?? null,
              resolved_price: l?.resolved_price ?? null,
              price_unavailable_reason: l?.price_unavailable_reason ?? null,
              ticker_suggestion: l?.ticker_suggestion ?? null,
              company_name: l?.company_name ?? null,
              sector: l?.sector ?? null,
              from_cache: l?.from_cache ?? null,
            } as ParsedLeg;
          })
          .filter((l: any): l is ParsedLeg => l !== null);
        const primaryLeg = sanitizedLegs[0];
        // Same historical-price guard as the live path: if any cached
        // leg has a past trade_date but no resolved/limit price, force
        // needs_confirmation so the UI doesn't let the user Execute.
        const todayForGuard = new Date().toISOString().slice(0, 10);
        const cachedAnyHistMissingPrice = sanitizedLegs.some(
          (l) =>
            l.trade_date != null &&
            l.trade_date < todayForGuard &&
            l.resolved_price == null &&
            l.limit_price == null,
        );
        return jsonResponse({
          success: true,
          data: {
            ...cached,
            legs: sanitizedLegs,
            // Back-compat flat fields mirror the primary leg.
            ticker: primaryLeg?.ticker ?? null,
            action: primaryLeg?.action ?? cached.action,
            direction: primaryLeg?.direction ?? cached.direction,
            qty: primaryLeg?.qty ?? null,
            price_type: primaryLeg?.price_type ?? 'MARKET',
            limit_price: primaryLeg?.limit_price ?? null,
            stop_loss_pct: primaryLeg?.stop_loss_pct ?? null,
            trade_date: primaryLeg?.trade_date ?? null,
            time_of_day: primaryLeg?.time_of_day ?? null,
            notional: primaryLeg?.notional ?? null,
            // If the LLM's primary ticker was a stopword, the cache
            // entry was written before we had a chance to set
            // needs_confirmation. Force it on so the user is prompted.
            needs_confirmation:
              Boolean(cached.needs_confirmation) ||
              cachedAnyHistMissingPrice ||
              (sanitizedLegs.length === 0),
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

      const detectedDate = detectDate(command);
      const detectedTimeOfDay = detectTimeOfDay(command);
      const todayIso = new Date().toISOString().slice(0, 10);
      const detectedIsHistorical =
        detectedDate != null && detectedDate < todayIso;

      // Detect tickers up front so the LLM prompt can include a
      // (text-only) market-data hint. We do NOT pre-fetch quotes
      // here — the post-LLM legResults below is the authoritative
      // source and reuses the same fetch helpers. Pre-fetching
      // doubled the per-request latency and risked timing out the
      // gateway's 60s budget on slow Bloomberg relays.
      const preResolved = resolveAllTickers(command);
      const tickerHint = preResolved.length === 0
        ? 'No ticker detected in command. If the user wrote a company name, map it; if a symbol, uppercase it. If unclear, produce an empty legs array and set needs_confirmation=true. NEVER invent a similar-looking real ticker (e.g. do not output SPCE when the user wrote SPCX).'
        : `Tickers detected by regex (will fetch real prices after LLM): ${preResolved.map((r) => r.ticker).join(', ')}. The system handles ticker typo correction via Levenshtein; you should echo the ticker as written. If the regex detected a ticker the user did NOT actually write, omit it.`;

      const sessionContext = buildSessionContext();
      const customInstructions = await loadSystemInstructions();

      // Build a richer system prompt that includes the user's
      // portfolio list (small string, no big cost). The market
      // context stays in the user message.
      const systemPromptWithPortfolios =
        buildSystemPrompt(customInstructions) + `\n\nAvailable portfolios: ${portfolioList}`;

      const parsed = await parseCommand(
        command,
        tickerHint,
        sessionContext,
        systemPromptWithPortfolios,
      );

      // =================================================================
      // Leg builder.
      //
      // The new shape is legs-canonical. The LLM emits one entry per
      // ticker with its own action, qty/notional, price_type, date, and
      // time_of_day. We:
      //   1. Take the LLM's legs (in order) as the primary source.
      //   2. Append any tickers the regex detected that the LLM
      //      missed (rare; the LLM usually wins).
      //   3. For each leg, derive the per-leg action/date/time_of_day
      //      using the LLM's value first, then the local inferLeg*
      //      scan, then the global detectDate/detectTimeOfDay
      //      fallback. This makes "Buy AAPL yesterday, short TSLA
      //      last week" work even if the LLM only echoed the global
      //      date.
      //   4. Cross-check the LLM-supplied ticker against the regex
      //      resolution: if the user wrote SPCX and the LLM returned
      //      SPCE, the regex is authoritative (the LLM is
      //      hallucinating). Replace the ticker and flag the leg.
      //   5. Fetch market data for every leg in parallel (live or
      //      historical based on the per-leg date).
      // =================================================================
      const regexResolved = resolveAllTickers(command);
      const regexByTicker = new Map<string, ResolvedTicker>();
      for (const r of regexResolved) regexByTicker.set(r.ticker, r);

      // LLM-supplied tickers in declared order. Use them to detect
      // a "ticker swap" (LLM invented a different ticker than the
      // user wrote).
      const llmTickers: string[] = (parsed.legs || [])
        .map((l) => (l.ticker || '').toUpperCase())
        .filter(Boolean);
      const regexTickerSet = new Set(regexByTicker.keys());

      // If the LLM's legs overlap with the regex set, trust the
      // regex's ordering (it matches the order in the command). If
      // the LLM's legs are completely disjoint (the LLM invented
      // tickers), keep the LLM's order but flag for confirmation.
      const tickerOrder: string[] = [];
      const seenT = new Set<string>();
      // Pass 1: regex tickers (in command order), but ONLY if the
      // LLM agreed on at least one of them (avoids masking the
      // LLM-only case where it correctly mapped a company name).
      const llmAndRegexOverlap = llmTickers.some((t) => regexTickerSet.has(t));
      if (llmAndRegexOverlap) {
        for (const r of regexResolved) {
          if (!seenT.has(r.ticker)) { tickerOrder.push(r.ticker); seenT.add(r.ticker); }
        }
      }
      // Pass 2: LLM legs in declared order, skipping anything
      // already in tickerOrder and flagging tickers the regex DID
      // NOT detect as potential hallucinations.
      const llmHallucinations = new Set<string>();
      for (const l of parsed.legs || []) {
        const t = (l.ticker || '').toUpperCase();
        if (!t || seenT.has(t)) continue;
        // LLM-only ticker. Allow it (e.g. company name -> LLM mapped
        // to a real ticker), but record a flag so the leg builder
        // can warn the user.
        if (regexTickerSet.size > 0 && !regexByTicker.has(t)) {
          llmHallucinations.add(t);
        }
        tickerOrder.push(t);
        seenT.add(t);
      }
      // Pass 3: any remaining regex tickers the LLM didn't mention.
      for (const r of regexResolved) {
        if (!seenT.has(r.ticker)) { tickerOrder.push(r.ticker); seenT.add(r.ticker); }
      }

      // Build the input legs.
      const legInputs: ParsedLeg[] = tickerOrder.map((t) => {
        const llmLeg = (parsed.legs || []).find(
          (l) => (l.ticker || '').toUpperCase() === t,
        );
        // Per-leg action resolution:
        //   1. LLM-supplied leg.action (the canonical source).
        //   2. Server inference (inferLegAction).
        //   3. LLM's primary leg's action (last-resort fallback).
        const llmAction = llmLeg?.action ?? null;
        const inferred = inferLegAction(command, t);
        const action = (llmAction ?? inferred ?? parsed.legs[0]?.action ?? 'BUY') as LegAction;
        // Per-leg date resolution:
        //   1. LLM-supplied leg.trade_date.
        //   2. Server inference (inferLegDateTime -> per-ticker chunk).
        //   3. Global detectedDate (applies to whole command).
        // The first two allow "Buy AAPL yesterday, short TSLA last
        // week" to produce two different dates. The third is the
        // catch-all for "buy 100 AAPL and 50 MSFT 3 days ago".
        const inferredDate = inferLegDateTime(command, t);
        const tradeDate = llmLeg?.trade_date ?? inferredDate.trade_date ?? detectedDate;
        // Per-leg time_of_day: same priority order.
        const llmTod = llmLeg?.time_of_day ?? null;
        const inferredTod = inferredDate.time_of_day;
        const tod = llmTod ?? inferredTod ?? detectedTimeOfDay;
        return {
          action,
          direction: deriveDirectionFromAction(action),
          ticker: t,
          qty: llmLeg?.qty ?? (tickerOrder.length === 1 ? parsed.qty : null),
          notional: llmLeg?.notional ?? (tickerOrder.length === 1 ? parsed.notional : null),
          // Per-leg sizing basis. Priority: LLM's per-leg basis -> LLM's
          // primary leg's basis -> USD. For multi-leg percentage/fraction
          // commands ("half on X, half on Y"), each ticker is its own leg
          // but the LLM is expected to emit the same basis/fraction on
          // each (it's the system's job to sum them at execute time and
          // check <= 100%).
          notional_basis: llmLeg?.notional_basis ?? parsed.legs[0]?.notional_basis ?? 'USD',
          notional_pct: llmLeg?.notional_pct ?? parsed.legs[0]?.notional_pct ?? null,
          notional_fraction: llmLeg?.notional_fraction ?? parsed.legs[0]?.notional_fraction ?? null,
          price_type: llmLeg?.price_type ?? parsed.price_type,
          limit_price: llmLeg?.limit_price ?? null,
          stop_loss_pct: llmLeg?.stop_loss_pct ?? parsed.stop_loss_pct,
          trade_date: tradeDate,
          time_of_day: tod,
          market_price: null,
          resolved_price: null,
          preview_qty: null,
          price_unavailable_reason: null,
          ticker_suggestion: null,
          company_name: null,
          sector: null,
          from_cache: null,
        };
      });

      // If the LLM's ticker differs from the regex (and the user
      // appears to have used the regex form), prefer the regex
      // ticker. The LLM might have picked a different but similar
      // real ticker (the SPCX->SPCE class of bug) — replacing it
      // with the regex's value brings the LLM's reasoning back in
      // line with what the user actually typed.
      for (const leg of legInputs) {
        if (llmHallucinations.has(leg.ticker)) {
          // The LLM introduced a ticker the regex didn't see. We
          // can't be sure — could be a legit company-name mapping —
          // so we keep the ticker but flag the leg.
          leg.price_unavailable_reason =
            `ticker "${leg.ticker}" was inferred by the AI but not detected in the original text; please confirm`;
          leg.ticker_suggestion = null;
        }
      }

      // Fetch market data per leg (parallel). Each leg uses its
      // own trade_date for historical lookups; missing historical
      // data falls back to live.
      const legResults: Array<ParsedLeg & {
        market_change_pct: number | null;
        market_context: string;
      }> = await Promise.all(legInputs.map(async (leg) => {
        if (!leg.ticker || STOPWORDS.has(leg.ticker)) {
          return {
            ...leg,
            market_change_pct: null,
            market_context: 'Ticker is a stopword / price-type keyword; not a stock symbol.',
            price_unavailable_reason: leg.price_unavailable_reason
              ?? 'ticker is a stopword, not a stock symbol',
          };
        }
        const isHistoricalLeg =
          leg.trade_date != null && leg.trade_date < todayIso;
        let quote: MarketQuote | null = null;
        let histPrice: number | null = null;
        let histDate: string | null = null;
        let reason: string | null = leg.price_unavailable_reason;
        if (isHistoricalLeg) {
          const hist = await fetchHistoricalPrice(leg.ticker, leg.trade_date!, userAuth);
          if (hist) {
            histPrice = hist.close_price;
            histDate = hist.date;
            quote = {
              ticker: leg.ticker,
              current_price: hist.close_price,
              previous_close: null,
              change_pct: null,
              day_high: null,
              day_low: null,
              company_name: null,
              sector: null,
              last_updated: new Date().toISOString(),
              from_cache: false,
            };
            reason = null;
          } else {
            // No historical price — do NOT silently fall back to the
            // live quote. That would record today's price against a
            // past `executed_at`, which is a backdating bug. Surface
            // the reason and leave `quote` null so the user has to
            // enter a limit price to execute.
            reason = `no historical close for ${leg.ticker} on ${leg.trade_date}; ` +
              `enter a limit price or pick a different date`;
          }
        } else {
          const live = await ensureFreshQuote(leg.ticker, userAuth);
          quote = live.quote;
          reason = live.unavailable_reason;
        }

        // Fuzzy ticker correction: only when the user's ticker is
        // unknown to Bloomberg. We never auto-correct a valid ticker.
        let suggestion: string | null = null;
        if (!quote) {
          suggestion = suggestTickerCorrection(leg.ticker);
        }

        const displayPrice = histPrice ?? quote?.current_price ?? null;
        const ctx = quote
          ? (histPrice
              ? `Market data for ${leg.ticker} as of ${histDate}: close=$${histPrice.toFixed(2)}, source=bloomberg historical.`
              : formatMarketContext(quote, leg.ticker))
          : `Market data for ${leg.ticker}: unavailable${reason ? ` (${reason})` : ''}.`;

        // Per-leg preview_qty: only meaningful for notional-based legs
        // (the user spoke in USD, not shares). Compute it here so the
        // UI can populate the qty box immediately. Authoritative qty
        // is recomputed at execute time by executeTrade().
        let legPreviewQty: number | null = null;
        if (
          displayPrice != null &&
          displayPrice > 0 &&
          leg.notional != null &&
          leg.notional > 0
        ) {
          legPreviewQty = Math.floor(leg.notional / displayPrice);
        }

        return {
          ...leg,
          market_price: displayPrice,
          market_change_pct: quote?.change_pct ?? null,
          market_context: ctx,
          resolved_price: displayPrice,
          preview_qty: legPreviewQty,
          from_cache: quote?.from_cache ?? null,
          price_unavailable_reason: reason,
          ticker_suggestion: suggestion,
          company_name: quote?.company_name ?? null,
          sector: quote?.sector ?? null,
        };
      }));

      // Build the canonical response. legs[] is ALWAYS populated
      // (>= 1 element). The legacy flat fields mirror the primary
      // (first) leg for back-compat with the existing frontend.
      const primary = legResults[0];
      const isMulti = legResults.length > 1;
      const isHistorical = legResults.some(
        (l) => l.trade_date != null && l.trade_date < todayIso,
      );
      // Historical leg without a resolved close: force
      // needs_confirmation so the UI prompts the user to enter a
      // limit price (or pick a different date) before Execute is
      // allowed. Without this, the user could click straight
      // through and we'd record today's price against a past date.
      const anyHistoricalMissingPrice = legResults.some(
        (l) =>
          l.trade_date != null &&
          l.trade_date < todayIso &&
          l.resolved_price == null &&
          l.limit_price == null,
      );
      const finalParsed: ParsedCommand = {
        ...parsed,
        legs: legResults,
        is_historical: isHistorical,
        needs_confirmation: parsed.needs_confirmation || anyHistoricalMissingPrice,
        // Legacy back-compat fields (mirror primary leg):
        action: primary.action,
        direction: primary.direction,
        ticker: primary.ticker || null,
        qty: primary.qty,
        price_type: primary.price_type,
        limit_price: primary.limit_price,
        stop_loss_pct: primary.stop_loss_pct,
        trade_date: primary.trade_date,
        time_of_day: primary.time_of_day,
        notional: primary.notional,
        ticker_suggestion: primary.ticker_suggestion,
        price_unavailable_reason: primary.price_unavailable_reason,
      };

      // Informational preview only — the system, not the LLM, owns
      // the authoritative qty. Aggregated across all notional-based
      // legs (each leg has its own preview_qty; the top-level preview
      // is the sum so the chat-bubble explanation stays meaningful for
      // multi-leg notional commands).
      let previewQty: number | null = null;
      for (const l of legResults) {
        if (l.preview_qty != null) {
          previewQty = (previewQty ?? 0) + l.preview_qty;
        }
      }
      finalParsed.preview_qty = previewQty;
      if (previewQty != null && previewQty > 0 && isMulti) {
        finalParsed.explanation = (finalParsed.explanation || '') +
          ` (preview: ~${previewQty.toLocaleString()} total sh; resolved at execute time)`;
      } else if (previewQty != null && previewQty > 0) {
        const resolvedPrice = primary.resolved_price ?? primary.market_price ?? null;
        if (resolvedPrice != null && resolvedPrice > 0) {
          finalParsed.explanation = (finalParsed.explanation || '') +
            ` (preview: ~${previewQty.toLocaleString()} sh @ $${resolvedPrice.toFixed(2)}; resolved at execute time)`;
        }
      }
      // Multi-leg summary line.
      if (isMulti) {
        const actionLabel: Record<LegAction, string> = {
          BUY: 'Buy', SELL: 'Sell', CLOSE: 'Close', SHORT: 'Short', COVER: 'Cover',
        };
        const legSummary = legResults
          .map((l) => {
            const verb = actionLabel[l.action];
            const size = l.qty != null
              ? ` ${l.qty}`
              : l.notional != null
                ? ` $${l.notional.toLocaleString()}`
                : l.notional_basis === 'PCT_PORTFOLIO' || l.notional_basis === 'PCT_CASH'
                  ? ` ${l.notional_pct ?? 0}%${l.notional_basis === 'PCT_CASH' ? ' of cash' : ''}`
                  : l.notional_basis === 'FRACTION_PORTFOLIO' || l.notional_basis === 'FRACTION_CASH'
                    ? ` ${formatFraction(l.notional_fraction ?? 0)}${l.notional_basis === 'FRACTION_CASH' ? ' of cash' : ''}`
                    : '';
            const date = l.trade_date ? ` (${l.trade_date})` : '';
            return `${verb}${size} ${l.ticker}${date}`;
          })
          .join(' + ');
        finalParsed.explanation =
          `${finalParsed.explanation || `Multi-leg trade`} (${legResults.length} legs: ${legSummary})`;
      } else {
        // Single-leg explanation, with date if any.
        const actionLabel: Record<LegAction, string> = {
          BUY: 'Buy', SELL: 'Sell', CLOSE: 'Close', SHORT: 'Short', COVER: 'Cover',
        };
        const verb = actionLabel[primary.action];
        const size = primary.qty != null
          ? ` ${primary.qty}`
          : primary.notional != null
            ? ` $${primary.notional.toLocaleString()}`
            : primary.notional_basis === 'PCT_PORTFOLIO' || primary.notional_basis === 'PCT_CASH'
              ? ` ${primary.notional_pct ?? 0}%${primary.notional_basis === 'PCT_CASH' ? ' of cash' : ''}`
              : primary.notional_basis === 'FRACTION_PORTFOLIO' || primary.notional_basis === 'FRACTION_CASH'
                ? ` ${formatFraction(primary.notional_fraction ?? 0)}${primary.notional_basis === 'FRACTION_CASH' ? ' of cash' : ''}`
                : '';
        const dateSuffix = primary.trade_date ? ` on ${primary.trade_date}` : '';
        const todSuffix = primary.time_of_day ? ` at ${primary.time_of_day}` : '';
        finalParsed.explanation = finalParsed.explanation ||
          `${verb}${size} ${primary.ticker}${dateSuffix}${todSuffix}`;
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

      // Final guard: re-sanitize every leg's ticker one last time.
      // No stopword can ever reach the browser as a ticker.
      const responseLegs = finalParsed.legs
        .filter((l) => l.ticker && !STOPWORDS.has(l.ticker.toUpperCase()))
        .map((l) => ({ ...l, ticker: l.ticker.toUpperCase() }));
      const responseTicker = responseLegs[0]?.ticker ?? null;

      // Convenience flat fields for the frontend's market-price
      // header (it still reads these directly).
      const displayPrice = primary.market_price ?? null;
      const marketContext = primary.market_context ?? '';

      return jsonResponse({
        success: true,
        data: {
          ...finalParsed,
          legs: responseLegs,
          ticker: responseTicker,
          action: responseLegs[0]?.action ?? finalParsed.action,
          direction: responseLegs[0]?.direction ?? finalParsed.direction,
          qty: responseLegs[0]?.qty ?? null,
          price_type: responseLegs[0]?.price_type ?? 'MARKET',
          limit_price: responseLegs[0]?.limit_price ?? null,
          stop_loss_pct: responseLegs[0]?.stop_loss_pct ?? null,
          trade_date: responseLegs[0]?.trade_date ?? null,
          time_of_day: responseLegs[0]?.time_of_day ?? null,
          notional: responseLegs[0]?.notional ?? null,
          // Per-leg sizing basis (mirror primary leg for the legacy
          // flat-field reads the frontend still does).
          notional_basis: responseLegs[0]?.notional_basis ?? 'USD',
          notional_pct: responseLegs[0]?.notional_pct ?? null,
          notional_fraction: responseLegs[0]?.notional_fraction ?? null,
          market_price: displayPrice,
          market_change_pct: primary.market_change_pct ?? null,
          market_context: marketContext,
          resolved_price: responseLegs[0]?.resolved_price ?? null,
          from_cache: primary.from_cache ?? null,
        },
      });
    }

    // Fast quote lookup. The frontend hits this on every blur of a
    // leg's ticker/qty input so the user gets a near-instant refresh
    // (sub-300ms typical). It runs the SAME price resolution pipeline
    // as /parse's per-leg path, but skips the LLM call entirely.
    //
    // Response shape mirrors a single ParsedLeg so the frontend can
    // splice it into `parsed.legs[idx]` without a translation layer.
    if (req.method === 'POST' && route === 'quote') {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ success: false, error: 'Body must be JSON' }, 400);
      }
      const ticker = (body?.ticker ?? '').toString().toUpperCase().trim();
      if (!ticker) {
        return jsonResponse(
          { success: false, error: '`ticker` (string) is required' },
          400,
        );
      }
      // Reject stopword tickers up front — same guard as the parse
      // path, keeps the UI's "red box for unrecognised" signal honest.
      if (STOPWORDS.has(ticker)) {
        return jsonResponse({
          success: true,
          data: {
            ticker,
            market_price: null,
            market_change_pct: null,
            resolved_price: null,
            preview_qty: null,
            price_unavailable_reason: `"${ticker}" is a reserved word, not a ticker`,
            ticker_suggestion: null,
            company_name: null,
            from_cache: null,
          },
        });
      }
      // Step 1: Levenshtein correction. If the user typed "APPL"
      // and AAPL is a known ticker, surface the suggestion so the
      // UI can offer a "Did you mean AAPL?" affordance without
      // ever calling the LLM.
      const tickerSuggestion = suggestTickerCorrection(ticker);
      // If we have a clear correction, swap the ticker in for the
      // price lookup. The original (with the suggestion attached)
      // is still returned so the UI can ask the user first.
      const lookupTicker = tickerSuggestion ?? ticker;
      // Step 2: resolve a live/fresh quote. This is the only
      // potentially slow call (~50-200ms on cache hit, up to ~1s if
      // we have to hit the bloomberg relay). No LLM involved.
      const { quote, unavailable_reason } = await ensureFreshQuote(
        lookupTicker,
        userAuth,
      );
      // If we had to apply a Levenshtein correction AND the lookup
      // succeeded, the suggestion is no longer "did you mean?" — it's
      // "we auto-corrected". We still keep it on the response so the
      // UI can show a green confirmation chip if it wants to.
      return jsonResponse({
        success: true,
        data: {
          ticker,
          ticker_suggestion: tickerSuggestion,
          market_price: quote?.current_price ?? null,
          market_change_pct: quote?.change_pct ?? null,
          resolved_price: quote?.current_price ?? null,
          price_unavailable_reason: unavailable_reason,
          company_name: quote?.company_name ?? null,
          from_cache: quote?.from_cache ?? null,
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
