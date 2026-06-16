# AI Parsing System — Make It Intelligent

Three core fixes for `supabase/functions/ai-service/index.ts` and the data
flow that feeds it. All edits land directly in the main checkout.

---

## Goal

Make `/functions/v1/ai-service/parse` understand commands that the current
parser flattens or drops:

1. **Auto-fetch missing data** — when the user mentions a ticker not in the
   `stock_prices` cache, refresh from Bloomberg before parsing instead of
   handing the LLM "unavailable".
2. **Real temporal awareness** — current time, market session, intraday
   phrases ("at the open", "this morning", "pre-market"), and the trade
   must actually be timestamped at the historical date the user named.
3. **Notional quantity** — "$50k of AAPL", "1 million of NVDA worth $200",
   "$25,000 worth" → resolve to a share count server-side using the live
   price we already have in hand.

---

## Files Touched

| File | Why |
|---|---|
| `supabase/functions/ai-service/index.ts` | The bulk of the work — new helpers, prompt rewrite, response shaping. |
| `supabase/migrations/003_trade_executed_at.sql` | Add nullable `executed_at` column to `trades`. |
| `frontend/src/services/db.ts` | `executeTrade` accepts and writes `executed_at`. |
| `frontend/src/pages/AIChatPage.tsx` | Pass `trade_date` through to `executeTrade`. |

`supabase/functions/market-data/index.ts` already exposes `POST /refresh`
(`supabase/functions/market-data/index.ts:377`); we call it, no changes
needed there.

---

## Issue 1 — Auto-refresh on cache miss

### Current problem
`fetchMarketPrice` (`supabase/functions/ai-service/index.ts:252`) does a
plain `SELECT * FROM stock_prices WHERE ticker = ...`. Miss = empty
context, no fallback. The market-data function already has a
`refreshOne` helper that hits the Bloomberg relay and writes the cache
(`supabase/functions/market-data/index.ts:245`), but ai-service never
calls it.

### Change
Add a new helper `ensureFreshQuote(ticker)` in `ai-service/index.ts` that
does the cache → refresh → re-read dance, then replace the existing
`fetchMarketPrice(resolved.ticker)` call in the `/parse` handler
(`ai-service/index.ts:729`) with it.

```ts
async function ensureFreshQuote(ticker: string): Promise<MarketQuote | null> {
  const cached = await fetchMarketPrice(ticker);
  if (cached) return cached;
  // Cache miss: ask market-data to refresh from Bloomberg.
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SERVICE_KEY');
  if (!supabaseUrl || !serviceKey) return null;
  const res = await fetch(
    `${supabaseUrl}/functions/v1/market-data/refresh?ticker=${encodeURIComponent(ticker)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${serviceKey}` } },
  );
  if (!res.ok) return null;
  return await fetchMarketPrice(ticker); // re-read the now-warmed cache
}
```

Behaviour notes:
- 8 s timeout via `AbortController` (same pattern as `fetchHistoricalPrice`).
- Non-blocking on failure: we return null and the parser falls back to
  the "unavailable" branch it already has.
- Both the live and the historical branch in `/parse` call this; the
  historical branch still wins when the date is in the past.

---

## Issue 2 — Temporal awareness

### 2a. Inject market-session context into the LLM prompt
The system prompt (`buildSystemPrompt` at `ai-service/index.ts:460`) has
no idea what time it is or whether the market is open. Replace the
hardcoded `marketContext` line with a server-computed session block:

```
Market session
  now_utc: 2026-06-12 03:18:15Z
  user_local: 2026-06-12 11:18 (Asia/Singapore, UTC+8)
  session: closed          (US regular hours 13:30–20:00 UTC; pre 09:00–13:30; post 20:00–00:00)
  last_close_us: 2026-06-11
  next_open_us: 2026-06-12 13:30 UTC
```

Add `buildSessionContext()` and concatenate it into the prompt above the
existing `marketContext` line. This lets the LLM resolve phrases like
"this morning" correctly against the user's local clock and lets it
flag temporal impossibilities ("buy AAPL at open" before pre-market).

### 2b. Intraday time-of-day parsing
Extend `detectDate` (`ai-service/index.ts:402`) to return a richer
object: `{ date: YYYY-MM-DD, session: 'pre'|'open'|'regular'|'close'|'post'|'eod'|null }`.
Add a separate `detectTimeOfDay(command)` that returns the session token
for phrases:
- "at the open" / "at open" → `open`
- "this morning" / "pre-market" / "premarket" → `pre`
- "at close" / "at the close" / "end of day" / "EOD" → `close`
- "after hours" / "after-hours" / "post-market" / "postmarket" → `post`
- bare "now" / "today" / no modifier → `null` (regular session default)

Add a `time_of_day` field to `ParsedCommand` and the JSON schema so the
LLM can echo it. Normalize/validate in `validateAndNormalize`.

### 2c. Persist historical trade_date to the DB
The `trades` table currently always records `trade_timestamp = NOW()`
(`frontend/src/services/db.ts:206`). A "buy NVDA 3 days ago" today creates
a trade with *today's* timestamp and a 3-day-old price — wrong.

**New migration** `supabase/migrations/003_trade_executed_at.sql`:
```sql
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;
-- Backfill: any existing row gets its created_at as a best-effort value.
UPDATE trades SET executed_at = trade_timestamp WHERE executed_at IS NULL;
-- For new rows, the app sets this explicitly.
```

(We do **not** repurpose `trade_timestamp` because that's a generated
semantic — "when did this trade conceptually happen?". The new column
preserves that distinction: `trade_timestamp` stays the conceptual
moment, `executed_at` is the row-write moment.)

**`executeTrade` change** (`frontend/src/services/db.ts:160`): accept an
optional `executed_at?: string` and pass it into the insert. Default to
`new Date().toISOString()` when absent (current behaviour).

**`AIChatPage` change** (`frontend/src/pages/AIChatPage.tsx:132`): if
`parsed.trade_date` is set, send `executed_at: ${parsed.trade_date}T00:00:00Z`
(combined with `parsed.time_of_day` if you want the intraday precision —
e.g. `${date}T13:30:00Z` for `open`, `${date}T20:00:00Z` for `close`).
Otherwise omit.

### 2d. Why we need both date + session awareness
With (2a) + (2b) the LLM can disambiguate:
- "buy AAPL at the open" before 09:00 ET → pre-market, queue for 09:30
- "sell TSLA at close" after 16:00 ET → post-close, warn user
- "bought NVDA 3 days ago" → executed_at = 3 days ago, price = that
  day's EOD close

The UI side will get a clearer "Will execute at $X on YYYY-MM-DD (open)"
chip in the parsed-command card.

---

## Issue 3 — Notional quantity with auto-resolution

### 3a. New field in the JSON schema
Add `notional: number | null` to `ParsedCommand` and to the JSON schema
in `buildSystemPrompt`. The LLM emits a notional (USD) when the user
spoke in dollars ("buy $50k of AAPL", "$25,000 worth of NVDA", "1
million of NVDA worth $200") and we resolve it to a share count on the
server using the price we already fetched.

### 3b. New system-prompt rules
Append to `buildSystemPrompt`:

```
Quantity resolution
  - "buy 100 AAPL" / "buy 100 shares of AAPL"     -> qty: 100
  - "buy 10k of AAPL" / "buy 10K shares"           -> qty: 10000
  - "buy 1 million of NVDA"                        -> qty: 1000000
  - "buy $50,000 of AAPL" / "buy 50k worth of AAPL" -> notional: 50000, qty: null
  - "buy 1 million of NVDA worth $200"             -> notional: 200000000, qty: null
  K/M/B/million/billion are case-insensitive suffixes.
  "shares" / "stock" / "of TICKER" are no-ops.
  When the user gives BOTH a share count and a notional, prefer the
  share count and ignore the notional.
```

The few-shot examples anchor the behaviour for Gemini at temperature 0.1.

### 3c. Server-side resolution
In `parseCommand`'s caller (the `/parse` handler), after the LLM
returns, do:

```ts
if (parsed.notional != null && parsed.qty == null && resolvedPrice != null) {
  const resolvedQty = Math.floor(parsed.notional / resolvedPrice);
  parsed.qty = resolvedQty;
  parsed.explanation =
    `${parsed.explanation} (computed ${resolvedQty} sh from $${parsed.notional.toLocaleString()} ÷ $${resolvedPrice.toFixed(2)})`;
}
```

`resolvedPrice` is already computed in the handler (`ai-service/index.ts:756`),
priority: user limit → historical close → live quote.

### 3d. Why not also fix the regex fallback?
`simpleParse` (`ai-service/index.ts:503`) would benefit from a "k/m/
million/billion/$X" tokenizer, but with the LLM path upgraded the
fallback is rarely hit. Leave the regex as a safety net and only upgrade
it if a manual test in issue 3 reproduces on the regex path.

### 3e. Frontend
`AIChatPage` already handles `parsed.qty` as a number; the only change
is the explanation string getting longer. No new type fields needed
beyond the new `notional?` (optional, only shown in the explanation).

---

## Implementation Order

1. **Migration first** — `003_trade_executed_at.sql`. Run in Supabase
   SQL editor (matches the existing manual-deploy pattern in
   `supabase/migrations/001_initial_schema.sql`).
2. **`executeTrade` accepts `executed_at`** — db.ts.
3. **`AIChatPage` passes `executed_at`** — AIChatPage.tsx.
4. **`ai-service/index.ts` refactor** (the big one):
   - new `ensureFreshQuote()` helper
   - new `buildSessionContext()` helper
   - new `detectTimeOfDay()` helper
   - extend `detectDate` to return `{ date, session }`
   - extend `ParsedCommand` with `notional`, `time_of_day`
   - extend `buildSystemPrompt` with the temporal + quantity rules
   - extend `validateAndNormalize` to coerce `notional` + `time_of_day`
   - in the `/parse` handler: replace `fetchMarketPrice` with
     `ensureFreshQuote`, use `buildSessionContext` in the prompt, run
     the notional→qty resolution block before returning.
5. **Deploy**:
   - `supabase functions deploy ai-service`
   - Vercel auto-rebuild on push.
6. **Smoke test**: `Buy 1 million of NVDA`, `Buy $50k of AAPL`, `Buy
   10 NVDA 3 days ago`, `Buy AAPL at the open`, `Buy AAPL at close`.

---

## Risk / Edge Cases

- **Bloomberg relay down**: `ensureFreshQuote` returns null, the
  handler falls through to the existing "unavailable" branch — no
  worse than today, and the user gets a clear "no market data" message
  instead of a silent zero.
- **Notional ÷ price rounds down**: `Math.floor` is correct for share
  counts (you can't buy fractional shares at most brokers). For
  fractional-share brokers we'd add a flag; out of scope here.
- **"1 million of NVDA worth $200"**: that's $200 total, not per
  share. The prompt makes this explicit so the LLM emits
  `notional: 200`.
- **"buy at close yesterday"**: with the new session context, the
  LLM can correctly identify yesterday's date and pick the
  `time_of_day: close` slot. The price is yesterday's EOD close
  (already supported by `/historical`).
- **`executed_at` backfill**: the migration backfills from
  `trade_timestamp` for existing rows, so nothing looks broken in
  production after deploy.
- **Cache stampede**: if two users both type "buy NVDA" while the
  cache is cold, two `refresh` calls fire. The market-data function
  already has a 100 ms politeness delay in its batch path; the
  single-refresh path is fine for a 1–2 RPS demo.

---

## Out of Scope (deferred)

- Intraday price endpoints from the relay (only EOD is available
  today via `bdh`; would need `bdp` intraday fields or a new
  `/intraday` route).
- Fractional shares / crypto.
- Multi-leg orders ("buy AAPL calls", "NVDA spread").
- A "backtest this command against 2024" mode.
