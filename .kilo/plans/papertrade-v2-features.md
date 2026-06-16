# Plan: Shorting, More Instruments, Notional Fix, SPA 404, AI Quality

Five workstreams for the papertrade app. Order chosen so each item unblocks the next where possible.

---

## 1. SPA 404 on hard reload (smallest, do first)

**Root cause:** No `vercel.json` rewrites. The app is a Vite SPA whose build output is served as static files; on a deep link like `/portfolio/abc-123` Vercel tries to serve a file at that path and 404s. `index.html` only lives at `/`.

**Change:** Add `vercel.json` at the repo root (Vercel reads it regardless of where `frontend/` is — the existing `.vercel/project.json` confirms the project root is the repo root).

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }],
  "buildCommand": "cd frontend && npm install && npm run build",
  "outputDirectory": "frontend/dist",
  "framework": "vite"
}
```

**Verify:** `vercel deploy --prod` (or trigger via the dashboard), then hard-reload `/portfolio/<some-uuid>` and `/ai`. Both should render the SPA.

No code changes; no DB migration.

---

## 2. Shorting (SHORT/COVER verbs)

### 2a. Schema migration `004_shorting.sql`

```sql
-- trades: add direction column
ALTER TABLE trades
  ADD COLUMN direction TEXT NOT NULL DEFAULT 'LONG'
    CHECK (direction IN ('LONG', 'SHORT'));

-- positions: allow negative qty (no DEFAULT change needed; the column
-- is NUMERIC(18,4) and Postgres already permits negatives). Existing
-- rows stay positive; new SHORT opens go negative.
-- Add an explicit check that avg_price stays non-negative (entry price
-- is always positive regardless of direction).
ALTER TABLE positions
  ADD CONSTRAINT positions_avg_price_nonneg CHECK (avg_price >= 0);

-- Indexes: same as before; no new index needed since direction isn't
-- a common filter.
```

**Note on netting:** With one row per `(portfolio, ticker)`, a long and a short in the same ticker net into a single signed `qty` (paper-trading simplification; fine for this app). Document in the trade notes when a trade is SHORT/COVER so the user can see the direction in history.

### 2b. Trade model in `frontend/src/types/database.types.ts`

- `Trade.direction: 'LONG' | 'SHORT'`
- `Position.qty` is `number` (no sign change in the type — negatives just work)

### 2c. `frontend/src/services/db.ts` — `executeTrade()`

Accept a new optional `direction` field. Update the position math and validation:

| User action | `side` | `direction` | Cash flow | Position update |
|---|---|---|---|---|
| BUY (open long) | BUY | LONG | −qty×price | add qty |
| SELL (close long) | SELL | LONG | +qty×price | subtract qty (toward 0) |
| SHORT (open short) | SELL | SHORT | +qty×price (proceeds) | subtract qty (qty becomes negative) |
| COVER (close short) | BUY | SHORT | −qty×price (cost to buy back) | add qty (toward 0) |

Validation changes:
- **SELL + LONG**: still requires existing long position (`pos.qty >= qty`).
- **SELL + SHORT** (open short): no existing position required; skip cash check (we receive cash). Skip margin for paper trading.
- **BUY + SHORT** (cover): requires existing short (`-pos.qty >= qty`).

Rename internal helper to `updatePositionAfterTrade(portfolioId, ticker, side, direction, qty, price)`. Cash delta becomes `side === 'BUY' ? -total : +total` regardless of direction (cash flow is per side, not per direction).

### 2d. AI grammar — `supabase/functions/ai-service/index.ts`

- Extend `ParsedCommand.action` union to `'BUY' | 'SELL' | 'CLOSE' | 'SHORT' | 'COVER'`.
- Add `direction: 'LONG' | 'SHORT'` to `ParsedCommand` (defaults to 'LONG').
- Update regex: `parseShareCount` etc. recognise "short" as an action verb, "cover" as the close verb.
- Add to the system prompt: an explicit table of action ↔ side/direction mapping so the LLM doesn't have to guess.
- Update `validateAndNormalize` to coerce unknown actions and to fill `direction` from `action` when the LLM omits it (SHORT→SHORT, COVER→SHORT, everything else→LONG).
- `AIChatPage.handleExecute` maps `action` → `(side, direction)`:
  - BUY → (BUY, LONG)
  - SELL → (SELL, LONG) (close long)
  - CLOSE → (SELL, LONG) (current behaviour, unchanged)
  - SHORT → (SELL, SHORT)
  - COVER → (BUY, SHORT)
- Surface direction in the parsed panel ("Short 100 NVDA at $450" / "Cover 100 NVDA at $430").

### 2e. Frontend displays

- `DashboardPage` / `PortfolioDetailPage` position table: add a `Direction` column (Long/Short badge, color-coded) and a `Qty` column that shows signed numbers with explicit `+` / `−`.
- Trades list: include the direction badge.

---

## 3. More financial instruments (US equity, ETFs, futures, FX, HK stocks)

### 3a. Schema migration `005_instrument_universe.sql`

```sql
-- Rename stock_prices to instrument_prices and add asset_class.
-- Using rename + recreate to add the new column on a tiny table.
ALTER TABLE stock_prices RENAME TO instrument_prices;

ALTER TABLE instrument_prices
  ADD COLUMN asset_class TEXT NOT NULL DEFAULT 'EQUITY'
    CHECK (asset_class IN ('EQUITY', 'ETF', 'FUTURE', 'FX', 'BOND', 'OPTION', 'INDEX', 'CRYPTO', 'MUTUAL_FUND')),
  ADD COLUMN bbg_symbol TEXT,
  ADD COLUMN contract_size NUMERIC(18,6),  -- e.g. ES = 50, CL = 1000, HK 700 = 100
  ADD COLUMN currency TEXT,                -- for FX
  ADD COLUMN expiry_date DATE;             -- for futures/options

-- backfill: assume existing rows are US equity with contract_size 1
UPDATE instrument_prices
   SET contract_size = 1
 WHERE contract_size IS NULL;

-- trades/positions: store the user-facing ticker (e.g. "ES1", "EURUSD",
-- "00700"). The BBG symbol is resolved at quote time. No column change
-- needed; TEXT already accepts any string.
```

Update `frontend/src/types/database.types.ts`: rename the `StockPrice` interface to `InstrumentPrice` and add the new fields.

### 3b. `bloomberg-service/ticker_map.py` — instrument resolution

Rewrite the suffix routing to be asset-class-aware:

```python
# New signature: returns (bbg_symbol, asset_class, contract_size, currency, expiry_date)
# Auto-detection by ticker shape:
#   - 3-5 uppercase letters/digits/dots  -> " US Equity" or " ETF"  (try both via search)
#   - digit+letter e.g. "ES1", "CLZ25"   -> " Index" (futures, generic)
#   - 6 uppercase letters (EURUSD)      -> " Curncy" (FX)
#   - 1-5 digits (HK stocks)            -> " HK Equity" (zero-pad to 4, then suffix)
#   - already contains a space          -> return as-is
# Explicit override: caller can pass asset_class to force a suffix.

def resolve_instrument(ticker: str, asset_class: str | None = None) -> InstrumentRef
```

Expose as a new endpoint `GET /resolve?ticker=ES1` returning `{ bbg_symbol, asset_class, contract_size, currency, expiry_date }`. The market-data edge function calls this on cache-miss before hitting `bdp()`. The resolved fields are written into the new `instrument_prices` columns alongside the quote.

### 3c. `bloomberg-service/app.py` — field-map for non-equities

- Futures: `PX_LAST` works, but `FUT_CUR_GENERIC` / `FUT_NOTICE_FIRST` give metadata. `CONTRACT_SIZE` is per-symbol (ES=50, CL=1000, GC=100, NQ=20, etc.). Look up `FUT_CONT_SIZE` in the metadata response; persist to `contract_size`.
- FX: `PX_LAST` is the mid; bid/ask via `PX_BID`/`PX_ASK`. `CRNCY` is the base/quote pair. No contract size (notional 1 unit of base ccy).
- HK stocks: standard equity fields. Ensure the `LIMIT_UP`/`LIMIT_DOWN` price filters aren't blocking quotes (HK has daily limits but Bloomberg still returns `PX_LAST`).

Add an `asset_class` query param to `/quote` so the caller can hint which suffix to use; the bloomberg service can then look up the metadata in one call.

### 3d. `supabase/functions/market-data/index.ts`

- Loosen the ticker validation regex from `/^[A-Z0-9.\-]{1,10}$/` to `/^[A-Z0-9.\-\s]{1,20}$/` to accept user-friendly forms like "BRK.B" (already allowed) and to be permissive about format.
- The user-facing ticker (AAPL, ES1, EURUSD, 700) is the cache key. The bbg symbol is computed by the Python relay and stored alongside.
- On quote, write the asset_class + metadata returned by the relay back into `instrument_prices`.

### 3e. `frontend/src/pages/HotStocksPage.tsx` and AI chat

- Add an asset-class badge on each quote card (color-coded).
- For non-equities, show `Qty × contract_size` in the "Will execute" line (e.g. "10 ES1 contracts × 50 = 500 shares equivalent"). For FX, show "in notional units of base currency".
- Hot Stocks page: add a filter dropdown (All / Equity / ETF / Future / FX / HK).

### 3f. `bloomberg-service/search` — already a 501 stub

Implement a thin `bds("COMPANY","SEARCH")` wrapper that the new `GET /market-data/search?q=es+futures` calls. This lets the AI chat and the Hot Stocks page autocomplete across asset classes. Limited to the four supported classes for v1 (equity/ETF/future/FX/HK); expand later.

---

## 4. Notional resolution + AI quality (combined rewrite of ai-service)

The user's report: 10s parse times, "USD"/"YEAR" being mis-detected as tickers, "buy $X of Y" still failing. The fix is a tighter pipeline: **deterministic pre-parse → minimal LLM intent-extract → strict JSON validation → system-side math**.

### 4a. Tighten the regex pass

In `ai-service/index.ts`:

- Expand the stopword set in `resolveTicker()` to include:
  ```
  USD, JPY, EUR, GBP, CHF, CAD, AUD, NZD,           // currencies when used as words
  HKD, SGD, CNY, CNH, KRW, INR,                     // more
  YEAR, YEARS, MONTH, MONTHS, WEEK, WEEKS, DAY, DAYS,
  QUARTER, Q1, Q2, Q3, Q4,                          // time units often misread
  LONG, SHORT, CALL, PUT,                           // option words
  ITM, OTM, ATM,
  ```
  (These are already in part of the list; making the list explicit and larger.)
- The stopword check needs to look at the immediate context: "buy USD" → USD is a notional unit, not a ticker; "USDJPY" → that IS a ticker. Add a heuristic: if the candidate is preceded/followed by "of" or is a 3-letter code in the currency list, treat as a notional hint and skip.
- Cache parsed commands in a small in-memory LRU keyed by `(user_id, command)` for 60s — many users retype the same command.

### 4b. LLM call: make it smaller and faster

Current LLM call uses `temperature: 0.1, maxOutputTokens: 400, responseMimeType: application/json` and a giant system prompt with rules. Changes:

- **Use Gemini function calling** instead of `responseMimeType: 'application/json'`. Define a single function `parse_trade` with a strict schema matching `ParsedCommand`. The LLM is forced to call the function (or return null), which gives the strongest schema guarantees and is faster than generating freeform JSON.
- **Drop the market-context preamble** from the system prompt for the LLM; instead pass it as a user-message prefix only when a ticker was resolved. This shrinks the prompt from ~3k tokens to ~1k.
- **Reduce timeout** from 10s to 4s. If it takes >4s the LLM is hallucinating; fall back to the regex.
- **Add a self-critique step** only when `confidence < 0.8`: re-prompt the LLM with "Did you mean ticker X given the portfolio context? Answer yes/no." (cheap, usually instant).
- Move the model default to `gemini-2.5-flash-lite` (or the latest nano/flash-lite tier) for the first pass; fall back to `gemini-2.5-flash` for self-critique. Both already supported by env var.

### 4c. Notional → qty resolution moves to execution time

User's preferred path. Changes:

- `ai-service`: stop calling `Math.floor(notional / resolvedPrice)`. Return `{ ...parsed, notional, qty: null, _preview_qty: <informational only> }` so the UI can show "~$123 worth" without it being authoritative.
- The `trade` field stays `notional` (already typed) for the LLM output. The frontend stores it.
- `db.ts.executeTrade()` gets a new shape:
  ```ts
  input: { portfolio_id, ticker, side, direction, qty?, notional?, price?, stop_price?, notes?, executed_at? }
  ```
  Resolution priority at execute time: explicit `qty` wins → else `notional / freshPrice` → else error. The "fresh price" is the latest cached `current_price` from `instrument_prices` (same priority chain the LLM uses today).
- `AIChatPage.handleExecute`: pass `parsed.notional` and `parsed.qty` through to `executeTrade` instead of pre-resolving.
- Remove the `finalParsed.qty` mutation in ai-service; the qty preview moves to a separate `preview_qty` field used only in the parsed-panel UI.

This means the system, not the AI, owns the share-count math. If the live price moves between parse and execute, the system re-resolves with the latest price.

### 4d. Streaming response (perceived latency)

Replace the `Parse` button click → wait → result with:
- Click → immediately show the parsed panel with all deterministic fields filled (ticker from regex, qty/share-count from regex, notional from regex, action from regex, confidence=0.7).
- If any field is null/ambiguous, fire the LLM call in the background and patch the panel when it returns.

This makes the user feel the response is instant even when the LLM takes 2-3s.

### 4e. Custom instructions file

Add `supabase/functions/ai-service/SYSTEM_INSTRUCTIONS.md` (or `.txt`) — a small file (≤ 200 lines) that the prompt builder prepends. Loaded at deploy time and cached in memory. Lets the user tune tone, supported examples, and edge cases without redeploying the function. The file is included in the system prompt after the schema definition but before the rules.

Default content: a curated set of 10-15 example commands with their expected JSON output, so the LLM can few-shot rather than guess.

---

## 5. Integration / verification

Per workstream:

1. **404** — Vercel preview deploy, hard-reload `/ai`, `/comparison`, `/portfolio/<uuid>`. Pass = no 404.
2. **Shorting** — SQL migration applied. New portfolio, place "Short 100 NVDA", verify `positions.qty = -100` and `trades.direction = 'SHORT'`. Place "Cover 50 NVDA", verify `positions.qty = -50`. PnL shows a positive number when NVDA drops. RLS still gates per-user.
3. **Instruments** — Quote `ES1`, `EURUSD`, `700` (or `00700`). Each round-trips through cache with the correct asset_class. Trade 1 ES1 contract; the position row records 1 contract with `contract_size = 50` so the dashboard can show "equivalent 50 shares". HK ticker `00700` resolves to `700 HK Equity`.
4. **Notional** — "Buy $50k of AAPL" parses with `notional: 50000, qty: null, _preview_qty: ~123`; the panel shows "≈123 sh @ $407.10 (preview)"; on Execute, the system resolves to the live cached price and inserts the right qty.
5. **AI quality** — Average parse latency (post-fix) < 2.5s p95. Bad-ticker false-positives ("USD", "YEAR") go to zero in the stopword smoke test. The LLM is no longer asked to do math.

### Migration runbook

```bash
# Migrations
psql $SUPABASE_DB_URL -f supabase/migrations/004_shorting.sql
psql $SUPABASE_DB_URL -f supabase/migrations/005_instrument_universe.sql

# Edge functions
supabase functions deploy ai-service --no-verify-jwt
supabase functions deploy market-data --no-verify-jwt

# Frontend
cd frontend && npm run build
# Vercel picks up the new vercel.json + build on next deploy
```

### Files touched (summary)

| File | Workstream |
|---|---|
| `vercel.json` (new) | 1 |
| `supabase/migrations/004_shorting.sql` (new) | 2 |
| `supabase/migrations/005_instrument_universe.sql` (new) | 3 |
| `frontend/src/types/database.types.ts` | 2, 3 |
| `frontend/src/services/db.ts` | 2, 4 |
| `frontend/src/pages/AIChatPage.tsx` | 2, 4 |
| `frontend/src/pages/DashboardPage.tsx`, `PortfolioDetailPage.tsx` | 2, 3 (display) |
| `frontend/src/pages/HotStocksPage.tsx` | 3 (asset class filter) |
| `supabase/functions/ai-service/index.ts` | 2, 4 (rewrite) |
| `supabase/functions/ai-service/SYSTEM_INSTRUCTIONS.md` (new) | 4 |
| `supabase/functions/market-data/index.ts` | 3 (regex, asset class pass-through) |
| `bloomberg-service/ticker_map.py` | 3 (resolve_instrument) |
| `bloomberg-service/app.py` | 3 (field map per asset class) |
| `bloomberg-service/search.py` (new or in app.py) | 3 (`/search` impl) |
| `DEPLOYMENT.md` / `SETUP.md` | 1, 3 (note the new endpoint and migration) |

### Open questions for the user before implementation

- For HK stocks specifically, do you want the user to type "00700" or "700"? Both should work; I default to accepting either and stripping leading zeros inside.
- For futures, should qty be in contracts (1 ES contract = 50 × S&P) or in notional? The current "1 contract" model is simpler and matches how Bloomberg reports them. Confirm.
- The custom instructions file: do you want it as a separate file the user can edit, or hard-coded into the function? I'd default to file-based with a default committed.

### Out of scope for this plan (explicitly)

- Margin / leverage (paper trading treats shorts as cash-secured for simplicity)
- Options chains and bond math (separate plan; bigger lift)
- Migrating historical trades/positions to use the new direction column (default 'LONG' on existing rows, so old data is fine)
- Renaming the `stock_prices` references in `market-data/index.ts` URL routes (we keep `/quote?ticker=...` for backwards compat; the new table is just renamed internally)
