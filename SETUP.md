# SETUP.md — Daily startup for the Bloomberg relay

This file is the "Monday morning" reference for getting the
Bloomberg-backed price feed running on the dev PC. The whole
chain (Vercel → Supabase → Cloudflare → local Python relay →
Bloomberg) takes about 60 seconds to bring up once you've done
it a few times.

## TL;DR (the only section you need once you've done this twice)

Open **3 PowerShell windows** in this order. Each window has one job.

**Window 1 — your main shell** (used for everything else: git, supabase CLI, curl tests, etc.):
```powershell
cd "c:\Users\dcen\OneDrive - NINE MASTS CAPITAL LIMITED\papertrade"
```

**Window 2 — uvicorn (the Python relay)**:
```powershell
cd "c:\Users\dcen\OneDrive - NINE MASTS CAPITAL LIMITED\papertrade\bloomberg-service"
..\.venv-bb\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000
```

**Window 3 — cloudflared (the public tunnel)**:
```powershell
& "$env:USERPROFILE\cloudflared.exe" tunnel --url http://localhost:8000
```

Wait ~5 seconds for window 3 to print a `https://...trycloudflare.com` URL.

**Then in window 1**:
```powershell
# (Substitute the actual URL window 3 just printed)
supabase secrets set BLOOMBERG_RELAY_URL=https://random-words-1234.trycloudflare.com
```

Done. Open the Vercel app. The Hot Stocks page (and every other page that uses prices) now shows live Bloomberg data.

---

## What's running where (and why)

| Window | Process | Purpose |
|---|---|---|
| 1 | (your main shell) | supabase CLI, git, curl tests. Not a service, just a workspace. |
| 2 | `uvicorn app:app` | The Python/FastAPI relay. Holds the persistent B-PIPE session with Bloomberg. |
| 3 | `cloudflared tunnel --url ...` | Bridges Vercel (public internet) to your local port 8000. |

The dev PC is the only machine in this stack that can talk to Bloomberg (your IP is whitelisted at B-PIPE). The two background processes (uvicorn + cloudflared) are the magic — without them, no prices.

---

## The startup sequence (step-by-step)

### Step 0 — make sure you have the prerequisites
- [ ] `blpapi` is installed in `.venv-bb` (check: `..\.venv-bb\Scripts\python.exe -c "import blpapi; print(blpapi.__version__)"` should print a version, e.g. `3.26.4.2`)
- [ ] `xbbg_sapi` is installed in `.venv-bb` (check: `..\.venv-bb\Scripts\python.exe -c "import xbbg_sapi; print(xbbg_sapi.__version__)"` should print `1.0.0`)
- [ ] `cloudflared.exe` exists at `$env:USERPROFILE\cloudflared.exe` (the standalone .exe, not via MSI)
- [ ] `bloomberg-service\.env` is filled in (RELAY_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, FINNHUB_API_KEY=N/A)

If any of those are missing, see [TROUBLESHOOTING](#troubleshooting) below or look at `DEPLOYMENT.md`.

### Step 1 — start the relay (Window 2)

```powershell
cd "c:\Users\dcen\OneDrive - NINE MASTS CAPITAL LIMITED\papertrade\bloomberg-service"
..\.venv-bb\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000
```

You should see:
```
INFO:     Started server process [...]
INFO:     Waiting for application startup.
Connecting to Bloomberg SAPI at 10.103.1.46:8194 ...
Bloomberg session ready.                  ← key line — this confirms B-PIPE works
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8000
```

If you see `Bloomberg connect() failed` instead, your dev PC's IP isn't in the wheel's whitelist. See troubleshooting.

### Step 2 — start the tunnel (Window 3)

```powershell
& "$env:USERPROFILE\cloudflared.exe" tunnel --url http://localhost:8000
```

After ~5 seconds, you should see:
```
Your quick Tunnel has been created! Visit it at:
https://random-words-1234.trycloudflare.com
+--------------------------------------------------------------------------------------------+
```

**Copy that URL.** It's your new public hostname for the relay.

### Step 3 — update Supabase (Window 1)

```powershell
supabase secrets set BLOOMBERG_RELAY_URL=https://random-words-1234.trycloudflare.com
```

(Substitute the actual URL from step 2.)

This tells Supabase's `market-data` Edge Function to call the new URL when it needs a price.

### Step 4 — verify end-to-end

In window 1:
```powershell
# 1. Local relay responds
curl http://localhost:8000/healthz
# Expect: {"status":"ok","ts":"..."}

# 2. Tunnel is reachable from outside
curl https://random-words-1234.trycloudflare.com/healthz
# Expect: {"status":"ok","ts":"..."}

# 3. End-to-end via Supabase
# Get a JWT from the Vercel app's DevTools (see BLOOMBERG_MIGRATION_PLAN.md or DEPLOYMENT.md)
# Then:
curl.exe "https://cygsvvhdkpnqxfuoqkyq.supabase.co/functions/v1/market-data/quote?ticker=AAPL" `
  -H "Authorization: Bearer eyJ..." `
  -H "apikey: sb_publishable_DEmO3nuhH74dasbsFAdvbQ_wvDz5zBz"
# Expect: JSON with current_price for AAPL
```

If all three pass, the chain is live. Open `https://your-app.vercel.app/hot` to see the Hot Stocks page.

---

## If the Cloudflare URL changed

The `--url` flag gives you a **fresh random URL every time** you start cloudflared. So:
- Every reboot → new URL → need to re-set `BLOOMBERG_RELAY_URL`
- Every Ctrl-C of window 3 → new URL on next start → need to re-set

The recovery is one command. In window 1:
```powershell
# 1. Look at window 3 — it printed the new URL
# 2. Re-set the Supabase secret with it
supabase secrets set BLOOMBERG_RELAY_URL=https://the-new-url.trycloudflare.com
```

That's it. The frontend code doesn't need to change. The Edge Function doesn't need to be redeployed. Just the one secret.

---

## Stop everything (clean shutdown)

When you're done for the day:

1. **Window 2** → press `Ctrl-C` (uvicorn shuts down, B-PIPE session closes)
2. **Window 3** → press `Ctrl-C` (cloudflared tunnel closes)
3. **Window 1** → close the window (or just stop using it)

The dev PC can be powered off or sleep after that. Next time you start, follow the sequence above.

---

## Optional: also run the cache pre-populator

The relay caches prices in Supabase's `stock_prices` table (5-min TTL). The on-demand path (Step 1's relay) refreshes them as needed. But if you want the cache to stay fresh for tickers nobody is currently viewing, run the scheduler too.

**Window 4 (optional) — scheduler.py**:
```powershell
cd "c:\Users\dcen\OneDrive - NINE MASTS CAPITAL LIMITED\papertrade\bloomberg-service"
..\.venv-bb\Scripts\python.exe scheduler.py
```

This will:
- Every 5 min: call `tickers_in_use()` in Supabase → for each ticker, fetch fresh price → upsert into `stock_prices`
- Every 1 hr: delete cache rows for tickers no longer held (keeps the table small)

Without it, prices only update when something explicitly requests them. With it, prices stay fresh in the background.

---

## Troubleshooting

### "Bloomberg connect() failed at startup"
Your dev PC's IP isn't in the wheel's `ALL_CREDENTIALS` list. Either:
- Run on a different machine that IS in the whitelist
- Ask IT/your mentor to add your dev PC's IP to Bloomberg's whitelist

### "ModuleNotFoundError: No module named 'xbbg_sapi'" or 'blpapi'
You're using the wrong venv. The relay needs the `.venv-bb` venv (which has the firm wheel + blpapi), NOT `bloomberg-service/.venv` (which is just for general deps).

Run **the full path** to the .venv-bb Python:
```powershell
"c:\Users\dcen\OneDrive - NINE MASTS CAPITAL LIMITED\papertrade\.venv-bb\Scripts\python.exe" -m uvicorn app:app --host 0.0.0.0 --port 8000
```
(Working directory should be `bloomberg-service/`.)

### "Address already in use" / port 8000 conflict
A previous uvicorn is still running. Kill it:
```powershell
# Find the process
Get-Process python | Where-Object { $_.MainWindowTitle -eq "" }
# Or just:
Get-NetTCPConnection -LocalPort 8000
# Then kill the PID it returns
Stop-Process -Id <pid> -Force
```

### cloudflared prints a different URL every time
That's by design (ephemeral quick tunnel). Just re-set `BLOOMBERG_RELAY_URL` in Supabase. See "If the Cloudflare URL changed" above.

### cloudflared can't find the executable
Make sure `cloudflared.exe` is in your user folder:
```powershell
Test-Path "$env:USERPROFILE\cloudflared.exe"
# Expect: True
```

If `False`, re-download:
```powershell
Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "$env:USERPROFILE\cloudflared.exe"
```

### End-to-end returns `{"code":"UNAUTHORIZED_LEGACY_JWT"}`
The Edge Function is rejecting the JWT. Re-deploy with the gateway-level JWT check disabled:
```powershell
supabase functions deploy market-data --no-verify-jwt
supabase functions deploy ai-service --no-verify-jwt
```

(This was set up once. If you're seeing this on a fresh deploy, you forgot the `--no-verify-jwt` flag.)

### `stock_prices` only ever has 3 rows (the hot stocks), and the AI chat shows "price unavailable"
The shared `supabase/functions/_shared/auth.ts` helper handles this
case, but only if the `INTERNAL_API_KEY` env var is set to the
**same** value in both `ai-service` and `market-data`. If they
differ, `ai-service` gets HTTP 401 from `market-data/refresh` and
silently fails to populate the cache. (The old docs called this
`SERVICE_KEY`; the new name reflects that this secret is **not** the
DB service-role key — that one stays inside `createClient()` and
never appears in any HTTP header.)

Smoke test the inner path directly (PowerShell):
```powershell
$env:INTERNAL_API_KEY = "..."   # from Supabase dashboard → Edge Functions → Secrets
Invoke-WebRequest -Method POST `
  -Uri "https://cygsvvhdkpnqxfuoqkyq.supabase.co/functions/v1/market-data/refresh?ticker=GOOGL" `
  -Headers @{ Authorization = "Bearer $env:INTERNAL_API_KEY" }
```
- **200 + populated data** → auth path works; check `ai-service` logs
  for the actual fetch failure.
- **401 `{"error":"Malformed token"}`** → INTERNAL_API_KEY mismatch,
  or the shared helper import didn't take. Re-check that
  `_shared/auth.ts` is imported by **both** functions and re-deploy.

(For the bash/curl variant, see
[DEPLOYMENT.md → Verify the service-to-service auth path](./DEPLOYMENT.md#verify-the-service-to-service-auth-path-ai-service--market-data).)

### End-to-end returns `{"code":"UNAUTHORIZED_LEGACY_JWT"}` even after redeploy
Means the token expired. JWTs last 1 hour. Re-grab from DevTools:
```js
copy(JSON.parse(Object.keys(localStorage).find(k => k.includes('sb-') && k.includes('auth')) ? localStorage[Object.keys(localStorage).find(k => k.includes('sb-') && k.includes('auth'))] : '{}')?.access_token)
```

### Supabase secret not updating
Sometimes `supabase secrets set` has a slight delay. Wait 5 seconds and try the curl again.

---

## Path layout (where things live on this PC)

```
papertrade/
├── .venv-bb/                                    ← Python venv (has xbbg_sapi + blpapi)
│   └── Scripts/python.exe
│
├── bloomberg-service/                           ← The Python relay
│   ├── app.py                                   ← FastAPI service
│   ├── scheduler.py                             ← Optional cache pre-populator
│   ├── ticker_map.py                            ← AAPL → AAPL US Equity
│   ├── .env                                     ← RELAY_API_KEY, SUPABASE_*, etc.
│   ├── .env.example                             ← Template
│   └── venv/                                    ← (Different venv, NOT for the relay)
│
├── supabase/
│   └── functions/
│       ├── market-data/index.ts                 ← Edge Function (proxy to relay)
│       └── ai-service/index.ts                  ← Edge Function (LLM parsing)
│
└── frontend/                                    ← The React app (deploys to Vercel)
    └── src/pages/HotStocksPage.tsx             ← The new Hot Stocks page
```

And outside the repo, but important:
```
C:\Users\dcen\cloudflared.exe                    ← The standalone tunnel binary
C:\Users\dcen\.supabase\access-token            ← Auto-created by `supabase login`
```

---

## Production upgrade (for reference, not part of daily routine)

When the firm is ready to make this "production-grade":

1. **Buy a domain** (~$10/yr) and add it to Cloudflare
2. **Create a named Cloudflare Tunnel** (stable URL, no more manual reseed):
   ```
   cloudflared tunnel login
   cloudflared tunnel create bloomberg-relay
   cloudflared tunnel route dns bloomberg-relay bloomberg-relay.your-firm.com
   cloudflared service install
   ```
3. **Move the relay to a real server** (firm VM with whitelisted IP, runs 24/7)
4. **Set up NSSM** for crash recovery on the relay

The current setup is fine for a paper-trading demo. Production needs the above. See `BLOOMBERG_MIGRATION_PLAN.md` for the full design.

---

## Market-derived Sharpe / VaR (the new pipeline)

The Risk page's Sharpe / VaR / CVaR / Sortino now come from a **reconstructed market return series**, not from the portfolio's own daily snapshots. This means the metrics are meaningful from day 1 of holding — before any `daily_snapshots` rows exist.

### Data flow

```
frontend (Risk page / PortfolioDetail)
   ↓ getHistorySeriesLastDays([tickers], 365)
Supabase edge function: market-data/historical-series
   ↓ 1. read cache   2. on miss, call relay   3. upsert cache
bloomberg-service Python relay: /history-series
   ↓ bdh(tickers, [PX_LAST], start, end)
Bloomberg B-PIPE
```

### Pieces added

| File | Purpose |
|---|---|
| `supabase/migrations/009_instrument_price_history.sql` | New cache table (ticker, trade_date, close) + indexes + RLS |
| `supabase/functions/market-data/index.ts` | New `/historical-series` route — reads cache, backfills gaps |
| `bloomberg-service/app.py` | New `/history-series` endpoint — multi-ticker bdh wrapper |
| `bloomberg-service/scheduler.py` | New `backfill_history()` tick (default 1h) — keeps the cache warm for tickers_in_use() |
| `frontend/src/services/marketHistory.ts` | Frontend `getHistorySeries()` / `getHistorySeriesLastDays()` |
| `frontend/src/services/riskMetrics.ts` | New `buildMarketPortfolioReturns()`; Sharpe/VaR/CVaR/Sortino prefer the market-derived series (≥20 obs) and fall back to snapshots |
| `frontend/src/pages/RiskPage.tsx`, `PortfolioDetailPage.tsx` | Fetch the new series and pass it through |

### Important semantics

- **Path-dependent stats stay snapshot-driven**: max drawdown, current drawdown, days in drawdown, peak equity, recovery days, worst day. Those describe *this portfolio's* realised path and have no meaning when reconstructed from market data.
- **Distribution stats go market-derived**: Sharpe, Sortino, historical VaR 95%, CVaR 95%. Those describe the *risk of the current position mix* over the lookback window.
- The market-derived series assumes the user has held the current mix for the whole window. This is a standard simplification; the alternative (a time-varying mix) is impossible to estimate without daily trade-replay across years of history.
- Failure mode: if `historical-series` errors out, `riskMetrics` returns `null` for those metrics — the page renders the same "N/A" states as before, not a crash.
- Drawdown chart, equity chart, position L/S chart and the daily-returns histogram continue to use `daily_snapshots` (the realised path).
- Tunables: `HISTORY_INTERVAL` (default 1h), `HISTORY_LOOKBACK_DAYS` (default 365), `HISTORY_TABLE` (default `instrument_price_history`) — all env vars on the scheduler.

### Deploying the migration

Three new migrations need to be applied once before the new code paths are usable:

| Migration | Purpose |
|---|---|
| `supabase/migrations/008_snapshot_update_policy.sql` | UPDATE RLS policy on `daily_snapshots` (made idempotent; may have been applied previously via SQL Editor) |
| `supabase/migrations/010_snapshot_delete_policy.sql` | DELETE RLS policy on `daily_snapshots` (new — adds missing DELETE grant) |
| `supabase/migrations/009_instrument_price_history.sql` | New `instrument_price_history` cache table + indexes + RLS |

```powershell
supabase db push
```

If any fail with `42710 policy already exists` or `42P07 relation already exists`, the migration body is already on the remote — run `supabase migration repair --status applied <version>` to sync the CLI tracking table, then re-push.

(or apply the files manually via the Supabase SQL Editor if your project doesn't use the CLI migrations workflow.)
