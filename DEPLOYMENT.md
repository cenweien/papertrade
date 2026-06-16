# PaperTrade Deployment Guide

This guide covers deploying the **Bloomberg-backed** market-data infrastructure
(institutional-grade US stock prices via the firm's Bloomberg SAPI/B-PIPE
connection) to Supabase, Vercel, and a Bloomberg-enabled host on the firm LAN.

## Architecture

```
┌─────────────────┐    ┌─────────────────────┐    ┌────────────────────────┐
│   Vercel (FE)   │    │ Supabase Edge       │    │ bloomberg-service      │
│   React + Vite  │───▶│  market-data (Deno) │───▶│ Python (FastAPI) on    │
│                 │    │  - auth check       │    │ firm LAN/B-PIPE host   │
│  useLivePrices  │    │  - cache-first      │    │ uses xbbg_sapi/blpapi  │
│  60s auto-refresh    │  - 5min cache       │    │                        │
└─────────────────┘    │   ┌─────────┐       │    │   ┌──────────────┐     │
        │              │   │stock_   │       │    │   │ xbbg_sapi    │     │
        │              │   │prices   │       │    │   │   bdp()/bdh()│     │
        ▼              │   │(Supabase)│       │    │   └──────┬───────┘     │
┌─────────────────┐    │   └────▲────┘       │    │          │             │
│   Vercel (FE)   │    └────────┼─────────────┘    │          ▼             │
│   AI Chat       │             │                  │   Bloomberg SAPI        │
│                 │             │                  │   10.103.1.46:8194      │
│  callAI(parse)  │    ┌────────┴─────────┐        └────────────────────────┘
└────────┬────────┘    │ Supabase Edge   │
         │             │  ai-service     │
         └────────────▶│  (Deno)         │
                       │  reads stock_   │
                       │  prices cache   │
                       └─────────────────┘
```

The Python scheduler (separate process on the LAN host) refreshes
`tickers_in_use()` every 5 minutes so cache rows stay fresh even when
nobody is viewing them in a browser.

## Prerequisites

- Supabase CLI installed: `npm install -g supabase`
- Supabase project already created (your existing `papertrade` project)
- Vercel CLI (optional, for direct deploys): `npm install -g vercel`
- Python 3.8+ on the B-PIPE-enabled host
- Bloomberg SAPI/B-PIPE network access from the B-PIPE host (firm IP
  whitelisted at Bloomberg)
- The firm's `xbbg_sapi-1.0.0-py3-none-any.whl` (provided by your mentor)
- Bloomberg's `blpapi` C++ library installed on the host (per the firm's
  standard image)

## 1. Apply the database migration

The `stock_prices` cache table and helper functions are in
`supabase/migrations/002_market_data.sql`. (No schema change for the
Bloomberg migration — the table is data-source agnostic.)

Additional migrations shipped with the v2 features:

- `004_shorting.sql` — adds `trades.direction` (`LONG` / `SHORT`) and
  a non-negativity check on `positions.avg_price`. Required for the
  SHORT/COVER verbs in the AI chat and the portfolio page.
- `005_instrument_universe.sql` — renames `stock_prices` to
  `instrument_prices` and adds `asset_class`, `bbg_symbol`,
  `contract_size`, `currency`, `expiry_date` columns. Required for
  futures, FX, ETF, and HK-equity support.

The current cache table is **`instrument_prices`** (the old name was
renamed by migration 005). The market-data Edge Function and the
Python scheduler both write to the new name; the Python scheduler
also honours a `CACHE_TABLE` env var if you need to override.

### Option A — Supabase CLI (recommended)
```bash
supabase db push
```

### Option B — Manual (Supabase dashboard)
1. Open https://app.supabase.com/project/_/sql
2. Paste the entire contents of `supabase/migrations/002_market_data.sql`
3. Click **Run**

You should see: `Success. No rows returned`

## 2. Deploy the bloomberg-service Python app

This service runs on a firm-LAN host with Bloomberg B-PIPE access. It is the
**only** component that talks to Bloomberg directly.

```bash
# 1. Get the code on the host
git clone https://github.com/cenweien/papertrade.git
cd papertrade/bloomberg-service

# 2. Create a venv and install deps
python -m venv .venv
source .venv/bin/activate        # Linux/Mac
# .venv\Scripts\Activate.ps1     # Windows PowerShell
pip install -r requirements.txt
pip install ../xbbg_sapi-1.0.0-py3-none-any.whl

# 3. Configure
cp .env.example .env
# Edit .env and fill in:
#   - RELAY_API_KEY (long random string — same as BLOOMBERG_RELAY_KEY below)
#   - SUPABASE_SERVICE_KEY (your SERVICE_KEY from Supabase)
#   - BBG_HOST / BBG_PORT / BBG_UUID / BBG_USER_IP (if overriding defaults)
```

### Run as a long-lived service

Pick one of the following deployment styles for your firm:

**systemd** (recommended on a Linux VM):
```bash
# /etc/systemd/system/bloomberg-relay.service
[Unit]
Description=Bloomberg Relay (FastAPI)
After=network.target

[Service]
WorkingDirectory=/opt/papertrade/bloomberg-service
EnvironmentFile=/opt/papertrade/bloomberg-service/.env
ExecStart=/opt/papertrade/bloomberg-service/.venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000
Restart=on-failure
User=papertrade

[Install]
WantedBy=multi-user.target
```

```bash
# /etc/systemd/system/bloomberg-scheduler.service
[Unit]
Description=Bloomberg Scheduler (5-min cache refresh)
After=network.target

[Service]
WorkingDirectory=/opt/papertrade/bloomberg-service
EnvironmentFile=/opt/papertrade/bloomberg-service/.env
ExecStart=/opt/papertrade/bloomberg-service/.venv/bin/python scheduler.py
Restart=on-failure
User=papertrade

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bloomberg-relay bloomberg-scheduler
sudo systemctl status bloomberg-relay bloomberg-scheduler
```

**Docker** — see `bloomberg-service/README.md` for a sample Dockerfile.

**Plain foreground** (for local dev only):
```bash
# Terminal 1
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
# Terminal 2
python scheduler.py
```

### Expose the relay to Supabase Edge Functions

The Supabase Edge Function needs to reach this service. Three options:

1. **Public HTTPS** — give the host a public IP or domain, terminate TLS
2. **Cloudflare Tunnel** — `cloudflared tunnel create bloomberg-relay` (recommended)
3. **Whitelist Supabase outbound IPs** — if your firm firewalls egress

Note the resulting URL — you'll need it in step 3 (`BLOOMBERG_RELAY_URL`).

## 3. Set Supabase Edge Function secrets

```bash
# URL of the bloomberg-service Python app (from step 2)
supabase secrets set BLOOMBERG_RELAY_URL=https://your-bloomberg-relay.example.com

# Must match RELAY_API_KEY in bloomberg-service/.env
supabase secrets set BLOOMBERG_RELAY_KEY=your_random_secret_here

# Supabase Secret key (Settings → API → Secret keys) — used for
# reading/writing the stock_prices cache. NEVER put this in an HTTP
# Authorization header (it has full DB read/write and bypasses RLS).
supabase secrets set SERVICE_KEY=sb_secret_your_secret_key_here

# LLM key for ai-service
supabase secrets set GEMINI_API_KEY=your_llm_key_here

# Low-privilege shared secret for service-to-service HTTP calls
# (ai-service -> market-data). Separate from SERVICE_KEY on purpose:
# a leak of INTERNAL_API_KEY only identifies a caller as "another
# edge function"; it grants no DB privileges. Must be set to the
# SAME value on both functions.
supabase secrets set INTERNAL_API_KEY=$(openssl rand -hex 32)
```

> **Remove the old `FINNHUB_API_KEY` secret** if it's still set:
> ```bash
> supabase secrets unset FINNHUB_API_KEY
> ```

Verify with:
```bash
supabase secrets list
```

You should see (at least): `BLOOMBERG_RELAY_URL`, `BLOOMBERG_RELAY_KEY`,
`SERVICE_KEY`, `INTERNAL_API_KEY`, `GEMINI_API_KEY`, plus the
Supabase-managed `SUPABASE_*` keys.

## 4. Deploy the Edge Functions

> **Use `--no-verify-jwt` for both functions.** The app uses anonymous
> auth, which the Supabase gateway rejects with
> `UNAUTHORIZED_LEGACY_JWT` unless JWT verification is disabled at the
> gateway. (See SETUP.md → Troubleshooting if you forget this flag.)

```bash
# Deploy market-data first so it's ready to accept the shared
# auth helper (which accepts SERVICE_KEY for service-to-service
# calls from ai-service):
supabase functions deploy market-data --no-verify-jwt
supabase functions deploy ai-service --no-verify-jwt
```

You can monitor logs in the dashboard:
https://app.supabase.com/project/_/functions

## 5. Test the deployment

### Quick curl test

```bash
# Get your project URL and a user access token first
# (easiest: open the app, log in, then check localStorage for the access_token)

curl.exe "https://cygsvvhdkpnqxfuoqkyq.supabase.co/functions/v1/market-data/quote?ticker=AAPL" \
  -H "Authorization: Bearer YOUR_USER_ACCESS_TOKEN" \
  -H "apikey: sb_publishable_DEmO3nuhH74dasbsFAdvbQ_wvDz5zBz"
```

You should get back something like:
```json
{
  "success": true,
  "data": {
    "ticker": "AAPL",
    "current_price": 187.32,
    "previous_close": 185.50,
    "change_pct": 0.98,
    ...
  },
  "from_cache": false
}
```

### Verify the service-to-service auth path (ai-service → market-data)

Both `market-data` and `ai-service` use the shared
`supabase/functions/_shared/auth.ts` helper, which accepts a Supabase
user JWT **OR** the `INTERNAL_API_KEY` Bearer (for service-to-service
calls). The `SERVICE_KEY` (the DB service-role key) is **never** an
acceptable HTTP bearer — it has full DB read/write and must stay
inside `createClient()`. If the two functions' `INTERNAL_API_KEY`
secrets don't match, `ai-service` will get HTTP 401 when it calls
`market-data/refresh` or `/historical`, and `stock_prices` will only
ever grow from the 3 hard-coded hot stocks in `HotStocksPage`.

```bash
# 1. Hit market-data/refresh with INTERNAL_API_KEY directly. This is
#    exactly what ai-service does internally for non-cached tickers.
#    Should return 200 with a populated "data" object:
INTERNAL_API_KEY="..."   # from Supabase dashboard → Edge Functions → Secrets
curl -X POST "https://cygsvvhdkpnqxfuoqkyq.supabase.co/functions/v1/market-data/refresh?ticker=GOOGL" \
  -H "Authorization: Bearer $INTERNAL_API_KEY"

# 2. Confirm a 4th row appeared in stock_prices (3 hot stocks + GOOGL):
psql "$DATABASE_URL" -c "SELECT ticker, current_price, last_updated FROM stock_prices ORDER BY ticker;"
```

If step 1 returns 401 with body `{"success":false,"error":"Malformed token"}`,
the `INTERNAL_API_KEY` on `ai-service` and `market-data` is
mismatched, or the shared `auth.ts` helper was not actually imported
by both functions. (In newer Supabase CLIs, `supabase functions env
list ai-service` will show the secret; the dashboard is the source of
truth.)

### Verify the Python service is reachable from Supabase

Check the `market-data` function logs. If you see
`Bloomberg relay error: 502` or similar, the Edge Function cannot reach
your Python service — usually a firewall/tunnel issue.

### Test in the app

1. Open your deployed Vercel app
2. Log in
3. Go to the AI Chat page
4. Type: `Buy 100 AAPL at market`
5. You should see the parsed command panel with a **Live Market** price badge
   (now sourced from Bloomberg via the relay)
6. Go to a portfolio detail page — you should see live prices, day change %,
   and the "Live prices from Finnhub" indicator (label is hardcoded; the
   data is actually from Bloomberg)

## 6. Scheduler is automatic

The `scheduler.py` process you started in step 2 runs every 5 minutes
(`REFRESH_INTERVAL`) and:

- Calls `tickers_in_use()` to find tickers the user is actively holding
- Calls `bdp()` to fetch the latest quote for each
- Upserts into `stock_prices` so the ai-service prompt and the
  frontend's `useLivePrices` hook see fresh prices

Every 1 hour (`CLEANUP_INTERVAL`), it deletes cache rows for tickers the
user is no longer holding, keeping the table small.

You don't need a separate Supabase scheduled function for this — the
Python service owns the refresh loop.

## 7. Vercel environment variables

Make sure your Vercel project has:
- `VITE_SUPABASE_URL` = `https://cygsvvhdkpnqxfuoqkyq.supabase.co`
- `VITE_SUPABASE_ANON_KEY` = `sb_publishable_DEmO3nuhH74dasbsFAdvbQ_wvDz5zBz`

Set these in: Vercel Dashboard → Project → Settings → Environment Variables

You do NOT need to set `BLOOMBERG_RELAY_URL` / `BLOOMBERG_RELAY_KEY` in
Vercel — those are server-side secrets on the Supabase function only.

## 8. Redeploy to Vercel

```bash
git add .
git commit -m "feat: switch price feed from Finnhub to Bloomberg relay"
git push origin main
```

Vercel will auto-redeploy in ~1 minute.

Or with the Vercel CLI:
```bash
npx vercel --prod
```

## Troubleshooting

### "Failed to fetch" when using AI
- Make sure both functions are deployed: `supabase functions list`
- Check the `ai-service` logs — if it says "market-data returned 401",
  your `SERVICE_KEY` is wrong or missing
- Verify `BLOOMBERG_RELAY_URL` and `BLOOMBERG_RELAY_KEY` are set:
  `supabase secrets list`

### Prices show as "stored" (not live)
- The market-data function failed to reach the Bloomberg relay
  (Edge Function logs will say `Bloomberg relay error: ...`)
- Check the Python service is running: `systemctl status bloomberg-relay`
- Check the Python service can reach the B-PIPE host (`10.103.1.46:8194`):
  `curl -v telnet://10.103.1.46:8194` from the B-PIPE host
- Your firm's IP may need to be whitelisted at Bloomberg — talk to IT
- The ticker may not exist in Bloomberg's namespace (e.g., delisted)

### "Invalid or expired session" on /market-data
- Your access token has expired — re-log in to the app
- The function expects a user JWT in the Authorization header

### "Ticker search is not yet implemented" (HTTP 501)
- Expected — the Bloomberg `bds()` interface for company search isn't
  wired up yet. Extend `bloomberg-service/app.py:search()` to enable it.

### CORS errors in browser console
- The market-data function uses the same CORS config as ai-service
  (see `supabase/functions/_shared/cors.ts`) — should be fine
- If you see CORS issues, check that the function was actually redeployed
  with the latest `cors.ts` shared file

### bloomberg-service won't start: "Bloomberg connect() failed"
- Check `BBG_HOST` and `BBG_PORT` are correct (default 10.103.1.46:8194)
- Verify network connectivity to the B-PIPE server from the host
- Confirm the `blpapi` native library is installed
  (`python -c "import blpapi; print(blpapi.__version__)"`)
- If using a custom UUID, check it's valid and not revoked

## Security notes

- `xbbg_sapi` ships with hardcoded firm credentials in `core.py` (the
  `ALL_CREDENTIALS` list at lines 40-55). The wheel and its extracted
  source are gitignored — do not commit them.
- Setting `BBG_HOST`, `BBG_UUID`, `BBG_USER_IP` env vars overrides the
  hardcoded defaults, so the deployed service doesn't have to rely on
  the wheel's built-in credentials.
- `BLOOMBERG_RELAY_KEY` / `RELAY_API_KEY` should be a long random string.
  Use the same value in both places; rotate periodically.
- The `SERVICE_KEY` is the same secret used by the Edge Functions — it
  has full read/write access to your database. Treat it like a root
  password.
- `INTERNAL_API_KEY` is a separate, low-privilege shared secret used
  only for service-to-service HTTP calls between Edge Functions. Set
  the same value on both `market-data` and `ai-service`. Unlike
  `SERVICE_KEY`, a leak of `INTERNAL_API_KEY` only identifies a
  caller as "another edge function"; it grants no DB privileges.
- `--no-verify-jwt` is currently used because the project's
  anonymous-auth tokens are rejected by the gateway with
  `UNAUTHORIZED_LEGACY_JWT`. This means JWTs are NOT signature-checked
  at the edge; the helper in `supabase/functions/_shared/auth.ts`
  re-verifies them with `supabase.auth.getUser(jwt)` (and falls back
  to a soft payload decode for legacy anonymous tokens). New
  deployments should migrate to the new anonymous sign-in flow and
  drop `--no-verify-jwt` so the gateway enforces signatures.

## v2 features (shorting, instruments, AI quality, SPA routing)

The following workstreams are live after applying migrations 004
and 005. All changes are backwards compatible — old trades default
to `direction = 'LONG'` and old cache rows default to
`asset_class = 'EQUITY'`.

### Quick deploy

```bash
# 1. Apply the new migrations
psql "$SUPABASE_DB_URL" -f supabase/migrations/004_shorting.sql
psql "$SUPABASE_DB_URL" -f supabase/migrations/005_instrument_universe.sql

# 2. Redeploy the Edge Functions
supabase functions deploy market-data --no-verify-jwt
supabase functions deploy ai-service --no-verify-jwt

# 3. (Optional) Set a different Gemini model tier
supabase secrets set GEMINI_LITE_MODEL=gemini-2.5-flash-lite
supabase secrets set GEMINI_FALLBACK_MODEL=gemini-2.5-flash

# 4. Vercel picks up the new vercel.json + frontend build on push
cd frontend && npm run build
```

### What's new

- **SPA 404 fix** — `vercel.json` at the repo root rewrites all
  unmatched paths to `/index.html`, so deep links like
  `/portfolio/<uuid>` and `/ai` render the SPA instead of 404'ing.
- **Shorting** — `BUY`/`SELL` is now `BUY`/`SELL` x `LONG`/`SHORT`.
  The AI chat understands "short 50 NVDA" and "cover my TSLA
  short"; the portfolio page renders Long/Short badges and signed
  qty (`-100` for short, `+100` for long).
- **More instruments** — US equity, ETF (SPY), futures (ES1, CLZ25),
  FX (EURUSD), and HK equity (700, 00700) all round-trip through the
  cache. The bloomberg-service auto-detects asset class from the
  ticker shape; the new `/resolve` endpoint exposes the resolved
  BBG symbol + asset class. `/search?q=es` returns matches via
  Bloomberg's `bds()`.
- **Notional at execute time** — "Buy $50k of AAPL" parses with
  `notional: 50000, qty: null, preview_qty: ~123`. The system, not
  the LLM, turns the dollar amount into a share count at click
  time using the freshest cached price, so the live price can move
  between parse and execute without surprising the user.
- **AI quality** — Gemini function calling (strict schema), 4s
  timeout, self-critique step at low confidence, in-memory LRU
  cache for repeated commands, and `SYSTEM_INSTRUCTIONS.md` for
  user-editable tone/examples without redeploying.
