# Diagnosis Plan — AI service not calling market-data on market orders

## Symptom

User types a market order (e.g. `Buy 10 MU at market`) in the AI chat
page. Trade form fills in, but **no request is logged on the
bloomberg-service uvicorn terminal** — the AI does not trigger a quote
fetch for tickers that aren't already in `stock_prices`. Hot Stocks
*does* hit market-data (and therefore uvicorn) because the frontend
calls `getQuotes` directly from `useLivePrices`.

`ensureFreshQuote()` (`supabase/functions/ai-service/index.ts:350`) is
supposed to bridge this gap. The plan below figures out *which link in
the chain is broken* before touching any code.

---

## Request flow we expect (and where it can break)

```
User → frontend callAI('parse')       ← step A
  → POST /functions/v1/ai-service/parse
  → resolveTicker(command)            ← step B
  → ensureFreshQuote(ticker)          ← step C
  → POST /functions/v1/market-data/refresh
  → bloomberg-service /quote          ← step D (uvicorn logs here)
```

Each step has a small number of failure modes. We eliminate them in
order, cheapest first.

---

## Step 1 — Verify ai-service has the auto-refresh code at all

The auto-refresh-on-miss logic was added as part of the
"ai-parsing-intelligence" plan. If the deployed function is older than
that change, no refresh call will ever be made, regardless of input.

**Check**: open the Supabase dashboard → Edge Functions → `ai-service`
→ source view, and grep for `ensureFreshQuote` or `/market-data/refresh`.

**Expected**: both should be present. If they're missing, the fix is
`supabase functions deploy ai-service` from this checkout. Move on to
step 2 if present.

---

## Step 2 — Verify the `parse` route is being hit at all

If the AI never even reaches `ensureFreshQuote`, it could be failing
earlier — auth, body parse, regex match, or LLM call.

**Check** (in Supabase dashboard → Edge Functions → `ai-service` →
Logs, filter on the last attempt):

1. Look for a log line like `ai-service unhandled error` — that means
   the request reached the function and threw.
2. If the request hits the function and returns 200, look for any
   `console.error`/`console.warn` lines emitted by `ensureFreshQuote`
   (`ensureFreshQuote(MU): ...`).
3. Note: if you see **zero** log lines for the request, the request
   never reached the function (network/CDN/cors issue, not an
   ai-service bug).

Report back: error string if any, or "no logs at all for this call".

---

## Step 3 — Verify `resolveTicker` finds `MU`

This is a soft failure mode: the function is reached, but
`resolved` is `null` and we silently fall into the
`priceUnavailableReason = 'no ticker detected in command'` branch
(`ai-service/index.ts:1205`). The LLM then gets told no ticker was
detected, may hallucinate one, or returns a parse with `ticker: null`.

**Check**: with ai-service logs visible, type the exact command
`Buy 10 MU at market` and look for any of these in the logs:

- A warning from `Historical fetch failed` — would only appear if the
  date detector thought "BUY 10 MU AT MARKET" was a date.
- A log line from `ensureFreshQuote(MU): ...` — proves the ticker was
  resolved and the function tried to refresh.
- Nothing related to `MU` at all — confirms the ticker wasn't resolved.

**Alternative check** (no logs needed): run this locally in any Deno
REPL or as a one-off test in the repo:

```ts
import { resolveTicker } from './supabase/functions/ai-service/index.ts';
console.log(resolveTicker('Buy 10 MU at market'));
```

Expected output: `{ ticker: 'MU', matchedTerm: 'MU' }`. If you get
`null`, the issue is in the resolver (likely the stopword set or the
`{1,5}` length limit — `MU` is 2 chars, so it shouldn't be that).

**Report back**: what `resolveTicker` returns, and whether the
ai-service log shows any mention of `MU`.

---

## Step 4 — Verify the inner POST to `market-data/refresh` actually fires

If step 3 found the ticker, `ensureFreshQuote` is called. It hits
`POST /functions/v1/market-data/refresh?ticker=MU` with a
`SERVICE_KEY` bearer. This call can fail in two ways that wouldn't log
to uvicorn:

1. **DNS / SUPABASE_URL**: `Deno.env.get('SUPABASE_URL')` returns the
   *internal* project URL (`https://<ref>.supabase.co`). If it's
   `http://localhost:54321` (local dev default), the function
   container can't reach it.
2. **SERVICE_KEY missing or wrong**: returns 401 from market-data,
   `ensureFreshQuote` catches it and logs
   `market-data/refresh returned 401: ...`.

**Check**: in the ai-service logs for the failing request, look for
`ensureFreshQuote(MU): market-data/refresh ...`. The status code and
the body slice are both printed.

- If you see `network error`: the function tried to fetch and got
  ECONNREFUSED / DNS failure → SUPABASE_URL is wrong, or the function
  is deployed in a region that can't reach the gateway.
- If you see `returned 401`: SERVICE_KEY is missing or doesn't match
  the project's `service_role` key.
- If you see `returned 502` / `504`: market-data itself couldn't
  reach the bloomberg relay (separate issue, separate diagnosis).
- If you see `returned 200` followed by `refresh succeeded but cache
  still empty`: bloomberg returned no data for `MU` (legitimate
  "ticker unknown to Bloomberg" case).
- If you see **nothing at all** from `ensureFreshQuote(MU):`:
  `resolved` was null (go back to step 3).

**Report back**: the exact log line (or its absence) for the failing
request.

---

## Step 5 — Verify the env vars are set on the deployed function

If steps 1–4 pointed at a config issue, confirm directly:

```bash
supabase functions list   # get the function ID
supabase functions env get ai-service   # lists all env vars
```

We need to see:
- `SUPABASE_URL` (auto-injected, but verify the value is the public
  project URL, not `localhost`)
- `SERVICE_KEY` (must be set; the project's `service_role` JWT)
- `BLOOMBERG_RELAY_URL` (not needed for this flow, but useful to
  confirm market-data has it set too)

**Report back**: the output of `supabase functions env get ai-service`
(redact the key, just confirm presence + the first 20 chars of
`SUPABASE_URL`).

---

## Step 6 — Direct repro with curl

If logs are inconclusive, hit ai-service directly and see what comes
back. This isolates the browser/CDN from the function.

```powershell
# Get a real anon JWT first (the one in browser localStorage works).
$jwt = "PASTE_REAL_ACCESS_TOKEN_HERE"
$body = @{ command = "Buy 10 MU at market" } | ConvertTo-Json -Compress

curl.exe -X POST `
  "https://cygsvvhdkpnqxfuoqkyq.supabase.co/functions/v1/ai-service/parse" `
  -H "Authorization: Bearer $jwt" `
  -H "apikey: sb_publishable_DEmO3nuhH74dasbsFAdvbQ_wvDz5zBz" `
  -H "Content-Type: application/json" `
  -d $body
```

The response will include `market_price`, `from_cache`, and
`price_unavailable_reason`. If `price_unavailable_reason` is non-null,
it tells us exactly why. While this is running, watch the uvicorn
terminal.

**Report back**: the full response JSON (redact JWT).

---

## Expected outcomes

Each step above narrows the diagnosis to one of:

| Symptom | Root cause | Fix |
|---|---|---|
| Step 1: code missing | ai-service not redeployed after the auto-refresh change | `supabase functions deploy ai-service` |
| Step 1: code present, but step 2: no log lines | request never reached function (CORS, network, bad anon key) | check frontend env / supabase URL |
| Step 3: `resolveTicker` returns `null` | resolver bug for 2-letter tickers (e.g. MU, GE) | investigate the `{1,5}` regex + stopword list |
| Step 4: 401 from market-data | `SERVICE_KEY` missing or wrong | `supabase secrets set SERVICE_KEY=...` |
| Step 4: network error | `SUPABASE_URL` is `localhost` or unreachable in this env | set to the public project URL |
| Step 4: 200 but cache empty | Bloomberg has no data for `MU` (ticker delisted? wrong exchange code?) | verify ticker on Bloomberg terminal |
| Step 4: nothing from `ensureFreshQuote(MU):` | `resolved` was null | back to step 3 |

Stop and report findings as soon as one of the above is identified —
no need to run every step if an earlier one is conclusive.

---

## Out of scope for diagnosis (deferred to a follow-up plan)

- Implementing Gemini function-calling so the LLM can decide to
  fetch mid-response (vs. server-side prefetch).
- Adding a cache stampede lock for the refresh path.
- Streaming the parsed response so the user sees the live price as
  soon as `ensureFreshQuote` returns, not after the LLM finishes.
