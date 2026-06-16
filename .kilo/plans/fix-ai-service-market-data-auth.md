# Why the AI function never populates `stock_prices` for non-hot-stock tickers

## TL;DR

The AI function **is** calling `market-data/refresh` for any ticker the user types
that isn't already in the cache. But `market-data` is **rejecting the call with
HTTP 401** at its auth check, because the AI function forwards the
`SERVICE_KEY` (`sb_secret_…`, an opaque string) as a Bearer token and
`market-data`'s auth helper only accepts 3-part JWTs. The 401 is logged on the
server and the failure surfaces to the AI as `price_unavailable_reason` — the
frontend quietly degrades. `stock_prices` only ever grows when `HotStocksPage`
calls `market-data/quotes` directly, because *that* path uses a real user JWT.

The user's symptom is correct; the user's hypothesis ("AI never calls market-
data") is one layer off. It does call it — the call gets bounced.

## How I traced it

1. `frontend/src/lib/supabase.ts:22-42` — `callAI` posts the user session
   JWT to `/functions/v1/ai-service/parse`. ✅
2. `supabase/functions/ai-service/index.ts:1102-1115` — function decodes the
   JWT, accepts the request, continues. ✅
3. `ai-service/index.ts:1155` — `resolveTicker("buy 100 GOOGL")` returns
   `{ ticker: "GOOGL", … }`. ✅
4. `ai-service/index.ts:1199` — `ensureFreshQuote("GOOGL")` is called. ✅
5. `ai-service/index.ts:353` — `fetchMarketPrice` returns `null` (GOOGL not
   in cache). ✅
6. `ai-service/index.ts:364-372` — falls through to:
   ```ts
   const url = `${supabaseUrl}/functions/v1/market-data/refresh?ticker=GOOGL`;
   const res = await fetch(url, {
     method: 'POST',
     headers: { 'Authorization': `Bearer ${serviceKey}` },   // ← sb_secret_…
     ...
   });
   ```
   The request is made. ✅
7. `supabase/functions/market-data/index.ts:93-118` — `getUserFromRequest`
   runs:
   ```ts
   const token = authHeader.replace('Bearer ', '');  // = "sb_secret_…"
   const parts = token.split('.');                    // length === 1
   if (parts.length !== 3) throw new Error('not a JWT');
   ```
   `sb_secret_…` has no dots → `throw` → caught → returns
   `{ user: null, error: 'Malformed token' }`. ❌
8. `market-data/index.ts:288-289` — `if (authError || !user) return
   errorResponse(authError, 401);` → **401, no fetch, no cache write**. ❌
9. `ai-service/index.ts:386-396` — `ensureFreshQuote` swallows the 401:
   ```ts
   if (!res.ok) {
     const reason = `market-data/refresh returned ${res.status}: …`;
     console.error(`ensureFreshQuote(${ticker}): ${reason}`);
     return { quote: null, unavailable_reason: reason };
   }
   ```
   The user only sees `price_unavailable_reason` in the response (or the AI's
   explanation). `stock_prices` is never touched.

## Why HotStocksPage works

`frontend/src/services/marketData.ts:61-68, 96-116` — `getAuthHeader()` reads
`session.access_token`, which is a real 3-part JWT with a `sub` claim. That
JWT is sent to `market-data/quotes` and passes the same auth check. So AAPL,
TSLA, NVDA — the three hard-coded hot stocks (`HotStocksPage.tsx:20-24`) —
are the only tickers that ever get into `stock_prices`. Hence "3 rows only
ever".

The same bug also breaks the historical-price path
(`ai-service/index.ts:289-320`, `fetchHistoricalPrice` — same SERVICE_KEY
bearer, same 401) and any future cross-function call.

## Fix

The auth helper used by `market-data` was written assuming "the only callers
are browsers sending user JWTs." That's no longer true — `ai-service` is a
perfectly valid service-to-service caller. The right fix is to teach the auth
helper to recognize `SERVICE_KEY` as a valid service principal.

### Recommended change

Create `supabase/functions/_shared/auth.ts` exporting a single
`getUserFromRequest(req)` that:

1. Reads the `Authorization` header. Missing → `{ user: null, error: '…' }`.
2. Strips `Bearer `.
3. **If the token exactly equals `Deno.env.get('SERVICE_KEY')`, return
   `{ user: { id: 'service', email: null }, error: null }`.**
4. Otherwise run the existing 3-part-JWT decode with `sub` check.
5. Otherwise → `{ user: null, error: 'Malformed token' }`.

Then replace `getUserFromRequest` in both `market-data/index.ts` (line 93)
and `ai-service/index.ts` (line 177, the local `decodeAuthHeader`) with
imports of the shared helper. This:

- Fixes the immediate bug (market-data accepts SERVICE_KEY).
- Prevents the same bug from breaking the next service-to-service call
  (e.g. a future function calling `ai-service` directly).
- Keeps the existing user-JWT path byte-for-byte identical, so
  `HotStocksPage` keeps working.

### Why this design (vs. alternatives)

- **Forward the user JWT through to market-data** (change `ai-service` to send
  the user's `Authorization` header instead of `SERVICE_KEY`). Works, but
  couples the inner call's identity to the user, hides the fact that it's
  an internal call, and makes future service-to-service calls (cron, other
  functions) need a user session to fake.
- **Have `ai-service` skip `market-data` and call the bloomberg relay
  directly.** Works but duplicates the relay URL/key/timeout/upsert logic
  that's already in `market-data`. Future code rot.
- **Add an `X-Service-Call: <shared-secret>` header** to bypass auth. Adds
  yet another secret. Same trust model as the SERVICE_KEY match, more
  ceremony.

The SERVICE_KEY match is the minimum change, matches what the rest of the
Supabase ecosystem does for service principals, and is the only one that
also future-proofs `ai-service` itself for inbound service calls.

### Edge cases to handle in the shared helper

- Empty/missing SERVICE_KEY env var on the function: the service-call
  short-circuit must be skipped (it'd reject every Bearer). The JWT path
  should still work for browser traffic.
- The token `sb_secret_…` is not constant-time comparable to a long env
  string in JS, but for a single env-var read at request time the
  timing-attack surface is negligible. Still, a `crypto.subtle.timingSafeEqual`
  style guard is a nice-to-have, not a blocker.
- The comment on `ai-service/index.ts:22-24` ("matches market-data's
  approach") should be updated to point at the shared helper.

## Files to change

| File | Change |
|---|---|
| `supabase/functions/_shared/auth.ts` (new) | `getUserFromRequest(req)` with SERVICE_KEY short-circuit + JWT fallback. |
| `supabase/functions/market-data/index.ts:93-118` | Replace local `getUserFromRequest` with `import { getUserFromRequest } from '../_shared/auth.ts'`. |
| `supabase/functions/ai-service/index.ts:177-192` | Replace local `decodeAuthHeader` with import (or keep the local function as a thin wrapper that calls the shared one — depends on whether we want to preserve its narrower return type `{ userId, email } \| null`). Update the file-header comment block. |
| `DEPLOYMENT.md` line 222 (SETUP.md line 219 has the same `UNAUTHORIZED_LEGACY_JWT` section) | Add a note that service-to-service calls (e.g. `ai-service` → `market-data`) require the SERVICE_KEY to be the same secret in both functions' env, and that the shared auth helper handles this. |
| `supabase/functions/_shared/db.ts` | No change — the `supabaseAdmin` client uses SERVICE_KEY to bypass RLS, which is correct for the function's own DB writes. The bug was in the *HTTP* auth between functions, not the DB client. |

## Validation plan

### Verification curl to add to `DEPLOYMENT.md`

Add this section right after the existing "Quick curl test" (around line 209):

```bash
### Verify the service-to-service auth path (ai-service → market-data)

# Both functions use the SAME SERVICE_KEY secret. If they don't match,
# ai-service will get HTTP 401 when calling market-data/refresh, and
# only the three hot stocks will ever appear in stock_prices.

# 1. Confirm both functions have the secret set:
supabase secrets list --project-ref cygsvvhdkpnqxfuoqkyq
# (read it on each function via `supabase functions env list ai-service`
#  in newer CLI versions; the dashboard is the source of truth.)

# 2. Hit market-data/refresh with the SERVICE_KEY directly. This is
#    exactly what ai-service does internally. Should return 200:
SERVICE_KEY="sb_secret_..."   # from Supabase dashboard → API → Secret keys
curl -X POST "https://cygsvvhdkpnqxfuoqkyq.supabase.co/functions/v1/market-data/refresh?ticker=GOOGL" \
  -H "Authorization: Bearer $SERVICE_KEY"

# 3. Confirm a 4th row appeared in stock_prices (3 hot stocks + GOOGL):
psql "$DATABASE_URL" -c "SELECT ticker, current_price, last_updated FROM stock_prices ORDER BY ticker;"
```

If step 2 returns 401 with body `{"success":false,"error":"Malformed token"}`,
the SERVICE_KEY on `ai-service` and `market-data` is mismatched, or the
shared `auth.ts` helper was not actually imported by both functions.

### End-to-end checks (post-deploy)

1. **Confirm the function logs no longer show 401s.**
   `supabase functions logs ai-service --tail` → grep for
   `market-data/refresh returned 401`. Should be empty.
2. **Confirm `stock_prices` grows for non-hot tickers.**
   Type `buy 100 GOOGL` in the AI chat. Within 5s, `stock_prices` should
   have a 4th row for GOOGL.
3. **Confirm the AI gets a price.**
   AIChatPage should show a `Live Market` price badge in the parsed
   panel, and the `price_unavailable_reason` field in the response
   should be `null`.
4. **Regression: hot stocks still work.**
   Refresh the Hot Stocks page. AAPL/TSLA/NVDA still load. (The
   user-JWT path is untouched.)
5. **Regression: historical dates still work.**
   Type `buy 100 AAPL on 2026-06-01`. Should resolve to the close
   price for that date and parse correctly.

## Rollback

If the shared helper introduces a regression, revert by:

1. `git revert` the change to `_shared/auth.ts` and the two import
   sites.
2. `supabase functions deploy market-data --no-verify-jwt` and
   `supabase functions deploy ai-service --no-verify-jwt`.
3. Old behaviour returns (buggy but known). The two functions retain
   their original local auth helpers.

The fix is intentionally small and isolated so rollback is a single
`supabase functions deploy` away.
