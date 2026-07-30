# LOCAL_SETUP.md — Run PaperTrade on a fresh machine

This is the "fresh machine" runbook. It assumes the receiver has **no Supabase
project, no Vercel deploy, no Cloudflare account, no JWT juggling** — just the
code, a Python interpreter, and Node.

For the original production/Vercel/Cloudflare path (the one this whole repo
was built around), see `SETUP.md`. The two paths share the same Python relay
and the same `xbbg_sapi` Bloomberg wheel.

## TL;DR

Three terminals, ~10 minutes:

```powershell
# Terminal 1 — bootstrap the Python relay (one-time per machine)
cd "c:\path\to\papertrade"
powershell -ExecutionPolicy Bypass -File bloomberg-service\scripts\setup-venv-bb.ps1

# Terminal 2 — start the relay (every time you start working)
cd "c:\path\to\papertrade\bloomberg-service"
..\.venv-bb\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000

# Terminal 3 — start the frontend (every time)
cd "c:\path\to\papertrade\frontend"
cp .env.example .env.local      # first time only
npm install                      # first time only
npm run dev
```

Open http://localhost:5173. You land on the dashboard without logging in.

---

## What's different from production

| Piece | Production (SETUP.md) | Local (this file) |
|---|---|---|
| Auth | Supabase `signInAnonymously` | Auto-bypass (`VITE_AUTH_MODE=mock`) |
| Prices | Vercel → Cloudflare tunnel → Python relay → Bloomberg | Browser → Python relay → Bloomberg |
| AI chat | Supabase Edge Function (OpenAI proxy) | Disabled (no AI key in mock mode) |
| Portfolios/trades | Persisted in Supabase | Best-effort; pages render empty if Supabase env not set |
| Cache table `stock_prices` | Populated by scheduler | Not populated (skip the scheduler in local mode) |

No external accounts needed. No JWTs. No `supabase secrets set`. The
`xbbg_sapi` Bloomberg wheel and the `.venv-bb` Python venv are checked into
the repo (in the wheel case, the file is) so the receiver inherits a working
Bloomberg pipeline.

---

## Prerequisites

- **Windows** (this script is PowerShell; for macOS/Linux use the same
  commands with a `bash`-flavoured rewrite).
- **Python 3.11+** on PATH (`python --version` should print 3.11 or newer).
- **Node 20+** on PATH (`node --version`).
- **Bloomberg B-PIPE access** with your dev PC's IP whitelisted. Same as
  the firm's existing setup — the wheel + the IP whitelist are unchanged.
  If you're on the same network as the original dev PC, you should already
  be in.
- The **private `xbbg_sapi` wheel** at the repo root
  (`xbbg_sapi-1.0.0-py3-none-any.whl`).

---

## Step 1 — Bootstrap the Python relay

Run this once per machine. It creates `.venv-bb/`, installs Bloomberg's
`blpapi` plus the firm-private `xbbg_sapi` wheel, and seeds
`bloomberg-service/.env` with a random `RELAY_API_KEY`.

```powershell
cd "c:\path\to\papertrade"
powershell -ExecutionPolicy Bypass -File bloomberg-service\scripts\setup-venv-bb.ps1
```

What this does, line by line:

1. Locates the wheel — hard-fails with a clear error if it's missing.
2. Creates `.venv-bb/` (Python venv) at the repo root.
3. `pip install`s `blpapi`, `fastapi`, `uvicorn`, `pandas`, `pydantic`,
   `python-dotenv`, `requests`, then the wheel itself.
4. Imports both `blpapi` and `xbbg_sapi` to confirm they loaded.
5. Copies `bloomberg-service/.env.example` → `.env` and generates a
   random 64-hex-char `RELAY_API_KEY`. (If `.env` already exists, leaves
   it alone.)

Re-running is safe. To force a clean rebuild, `Remove-Item .venv-bb -Recurse`
first.

---

## Step 2 — Start the relay

Open a new PowerShell and run:

```powershell
cd "c:\path\to\papertrade\bloomberg-service"
..\.venv-bb\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000
```

You should see:

```
INFO:     Started server process [...]
INFO:     Waiting for application startup.
Connecting to Bloomberg SAPI at 10.103.1.46:8194 ...
Bloomberg session ready.                  ← key line — confirms B-PIPE works
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8000
```

If your Bloomberg endpoint differs (firm-specific), edit
`bloomberg-service/.env` and set `BBG_HOST` / `BBG_PORT` / `BBG_UUID` /
`BBG_USER_IP` before running.

If you see "ModuleNotFoundError: No module named 'blpapi'" or
"'xbbg_sapi'" — your `PATH` is finding a different `python.exe`. Use the
full venv path (`..\.venv-bb\Scripts\python.exe -m uvicorn …`).

If you see "Bloomberg connect() failed" — your dev PC's IP isn't in the
firm's B-PIPE whitelist. Same fix as the production runbook: ask IT to
add it.

---

## Step 3 — Configure the frontend

```powershell
cd "c:\path\to\papertrade\frontend"
cp .env.example .env.local      # first time only
npm install                      # first time only
```

The shipped `frontend/.env.example` defaults to local mode:

```
VITE_AUTH_MODE=mock
VITE_DATA_MODE=direct
VITE_RELAY_URL=http://localhost:8000
VITE_RELAY_API_KEY=
```

`VITE_RELAY_API_KEY` is intentionally empty: the relay is started with
`AUTH_DISABLED=true` (the `.env.example` default) so no X-API-Key header
is required. If you set a key in `bloomberg-service\.env`, paste the same
value here to send it on every request.

If you want persistence (portfolios, trades, snapshots), fill in the
Supabase section of `.env.example` and copy the values from your
Supabase project's API settings:

```
VITE_AUTH_MODE=
VITE_DATA_MODE=
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

With `VITE_AUTH_MODE=` and `VITE_DATA_MODE=` blank (or unset), the app
behaves exactly like the deployed Vercel build.

---

## Step 4 — Start the frontend

```powershell
npm run dev
```

Open http://localhost:5173.

| Page | Works in local mode? |
|---|---|
| Dashboard | Renders the sidebar + an empty-state (no Supabase, no portfolios yet) |
| Hot Stocks | Yes — prices come straight from `bloomberg-service/quote` |
| Portfolio Detail | Loads if you have portfolios in your own Supabase; empty otherwise |
| AI Chat | The LLM call requires Supabase; without it, the page renders but the chat returns an error |
| Comparison | Loads if you have portfolios in your own Supabase |
| Risk | Sharpe/VaR from the **market** series work (uses the relay); portfolio-derived metrics need Supabase data |

---

## Optional: skip the auth page

`VITE_AUTH_MODE=mock` makes the app auto-sign in as a stub user. You'll
land on the dashboard without ever seeing the login button. To toggle the
login page back on, set `VITE_AUTH_MODE=` (empty) in `.env.local` and fill
in the Supabase credentials.

---

## Optional: run the cache pre-populator

The Python relay returns live prices on demand (good for demos). To keep a
warm cache for tickers nobody is currently viewing — useful only if you've
wired up your own Supabase project — run `scheduler.py` in a fourth
terminal:

```powershell
cd "c:\path\to\papertrade\bloomberg-service"
..\.venv-bb\Scripts\python.exe scheduler.py
```

Requires `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and `INTERNAL_API_KEY` in
`.env`. Without those the scheduler silently fails to write to the cache.
Skip it for local-only mode.

---

## Troubleshooting

### "Bloomberg connect() failed at startup"
Your IP isn't in the firm's B-PIPE whitelist. Ask the team that owns the
Bloomberg wheel to add it, or run on a machine that IS whitelisted.

### "Address already in use" / port 8000 conflict
A previous uvicorn is still running:
```powershell
Get-NetTCPConnection -LocalPort 8000 | Select-Object OwningProcess
Stop-Process -Id <pid> -Force
```

### Frontend shows "Supabase not configured" yellow box
You're not in mock mode and `.env.local` doesn't have Supabase creds.
Either set them, or add `VITE_AUTH_MODE=mock` to opt into the local path.

### Hot Stocks page says "price unavailable" for everything
The relay isn't reachable from your browser. Make sure terminal 2 is
still running and `http://localhost:8000/healthz` returns
`{"status":"ok",...}`.

### Powershell 5.1 complains about `Split-Path -LiteralPath` with spaces
Known .NET quirk — the setup script uses positional `-Path` so it works
around it. If you hit this elsewhere, wrap the path in double quotes.

### `.venv-bb\Scripts\python.exe` is missing
Re-run the setup script. If you still don't have one, you probably
deleted `.venv-bb` without un-junctioning it. Remove the junction and
re-create as a real directory.

---

## What ships in the repo (and why)

| File | Purpose |
|---|---|
| `xbbg_sapi-1.0.0-py3-none-any.whl` | Firm-private Bloomberg wrapper, versioned. |
| `bloomberg-service/scripts/setup-venv-bb.ps1` | Bootstrap script described above. |
| `bloomberg-service/.env.example` | Template — copy to `.env`. Defaults to AUTH_DISABLED=true for local mode. |
| `frontend/.env.example` | Template — copy to `frontend/.env.local`. Defaults to mock auth + direct relay. |
| `frontend/src/lib/mockAuth.ts` | Stub session used when `VITE_AUTH_MODE=mock`. |
| `frontend/src/lib/supabase.ts` | Now import-safe; returns a clear-error proxy when env vars are missing. |
| `frontend/src/services/marketData.direct.ts` | Browser → relay client for `VITE_DATA_MODE=direct`. |
| `frontend/src/services/marketData.types.ts` | Shared response types so the two transports stay in sync. |
| `frontend/src/services/marketData.ts` / `marketHistory.ts` | Now branch on `VITE_DATA_MODE` and delegate. |
| `frontend/src/App.tsx` / `Layout.tsx` / `LoginPage.tsx` | Bypass auth + sign-out when `VITE_AUTH_MODE=mock`. |
| `bloomberg-service/app.py` | Warns (instead of crashes) when started with no API key — local-only is the default. |

Nothing is removed. Every change is additive and gated behind env vars that
default to "off" in production.

---

## When you're done for the day

- Terminal running uvicorn → `Ctrl-C`
- Terminal running `npm run dev` → `Ctrl-C`
- The `frontend/.env.local` / `bloomberg-service/.env` files persist between sessions.
- Next time: terminals 2 and 3 again. The DB warm-up is instantaneous.
