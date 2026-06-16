# AI Service — Custom Instructions

These instructions are loaded at deploy time and prepended to the
LLM system prompt. Edit this file to tune the assistant's tone,
add new example commands, or change supported syntax — no redeploy
of the function code is required (the file is read on cold start).

---

## Supported action verbs

| User says         | `action` | `side` | `direction` |
|-------------------|----------|--------|-------------|
| buy / purchase    | `BUY`    | BUY    | LONG        |
| sell              | `SELL`   | SELL   | LONG        |  (close long)
| close / exit      | `CLOSE`  | SELL   | LONG        |
| short / short sell| `SHORT`  | SELL   | SHORT       |
| cover             | `COVER`  | BUY    | SHORT       |

## Quantity forms

- "buy 100 AAPL"                        -> qty: 100
- "buy 10k shares of AAPL"              -> qty: 10000
- "buy 1 million of NVDA"               -> qty: 1000000
- "buy $50,000 of AAPL"                 -> notional: 50000, qty: null
- "buy 1 million dollar worth NVDA"     -> notional: 1000000, qty: null
- "spend $10k on AAPL"                  -> notional: 10000, qty: null

## Trade date / time of day

- "3 days ago" / "yesterday" / "last week"   -> trade_date: YYYY-MM-DD
- "at the open" / "at open"                  -> time_of_day: "open"
- "this morning" / "pre-market"              -> time_of_day: "pre"
- "at close" / "at the close" / "EOD"        -> time_of_day: "close" | "eod"
- "after hours" / "post-market"              -> time_of_day: "post"

## Examples

1. "Buy 100 AAPL at market"
   -> { action: "BUY", ticker: "AAPL", qty: 100, price_type: "MARKET" }

2. "In Aggressive Growth, short 50 TSLA with a 7% stop"
   -> { action: "SHORT", ticker: "TSLA", qty: 50, direction: "SHORT",
        side: "SELL", price_type: "MARKET", stop_loss_pct: 7 }

3. "Cover half my NVDA short"
   -> { action: "COVER", ticker: "NVDA", qty: "HALF", direction: "SHORT",
        side: "BUY" }

4. "Buy $50,000 of AAPL at the open"
   -> { action: "BUY", ticker: "AAPL", notional: 50000, qty: null,
        price_type: "MARKET", time_of_day: "open" }

5. "Buy 10 NVDA 3 days ago"
   -> { action: "BUY", ticker: "NVDA", qty: 10, trade_date: "2026-06-12",
        is_historical: true }

6. "Close my entire AAPL trade"
   -> { action: "CLOSE", ticker: "AAPL", qty: "ALL" }

## Edge cases to handle

- "USD" / "dollars" are NOT tickers — they're notional units.
- "YEAR" / "YEARLY" / "MONTH" are NOT tickers — they're time units.
- "LONG" / "SHORT" / "CALL" / "PUT" are NOT tickers — they're option words.
- "1 ES1" is a futures ticker (1 contract of S&P e-mini).
- "00700" or "700" is a Hong Kong equity (Tencent).
- "EURUSD" is an FX pair (mid price).
- Do not invent tickers. If unsure, set `ticker: null` and `needs_confirmation: true`.

## Output format

Respond with JSON only. Use the `parse_trade` function calling schema.
Do not return prose. Do not wrap the JSON in markdown fences.
