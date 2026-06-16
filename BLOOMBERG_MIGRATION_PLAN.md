# Bloomberg Migration Plan — `xbbg_sapi` Integration

> Goal: replace the Finnhub-based price feed in `market-data` with Bloomberg SAPI data, while preserving the existing `stock_prices` cache table and frontend API contract so **no frontend code changes** are needed.

---

## ✅ Implementation status (as of code freeze)

| Step | Status | Notes |
|---|---|---|
| 1. Update `.gitignore` | ✅ done | Added `xbbg_sapi_extracted/`, `xbbg_sapi-*.whl`, `.venv*`, `bloomberg-service/.venv/`, etc. |
| 2. Scaffold `bloomberg-service/` | ✅ done | 6 files: `app.py`, `scheduler.py`, `ticker_map.py`, `requirements.txt`, `.env.example`, `README.md` |
| 3. Rewrite `market-data/index.ts` | ✅ done | Removed `fetchFinnhubQuote`/`fetchFinnhubProfile`; added `fetchBloombergQuote` that calls the Python service. Same routes, same JSON shape, no frontend changes. `/search` returns 501 (not yet implemented for Bloomberg). |
| 4. Update `market-data/.env.example` | ✅ done | Removed `FINNHUB_API_KEY`; added `BLOOMBERG_RELAY_URL` and `BLOOMBERG_RELAY_KEY` |
| 4b. Update `ai-service/.env.example` | ✅ done | Removed the Finnhub comment block (no longer relevant) |
| 5. Rewrite `DEPLOYMENT.md` | ✅ done | New architecture diagram, new `bloomberg-service` deploy section, updated secrets/troubleshooting for Bloomberg |
| 6. Update `BLOOMBERG_MIGRATION_PLAN.md` | ✅ done | This status block |
| 7. Deploy (Supabase + LAN host) | ⏳ pending | Run by the user after mentor answers open questions |

**Frontend changes required:** zero. `frontend/src/services/marketData.ts`, `AIChatPage.tsx`, `useLivePrices` all continue to call `${supabaseUrl}/functions/v1/market-data/...` exactly as before.

---
## ⚠️ Security flag (read this first)

The wheel ships **hardcoded firm credentials** in `xbbg_sapi/core.py`:

```python
# Lines 30-37 (defaults)
DEFAULT_HOST = '10.103.1.46'      # internal B-PIPE host
DEFAULT_PORT = 8194
DEFAULT_UUID = 15280056
DEFAULT_USER_IP = '10.221.13.141'

# Lines 40-55 (ALL_CREDENTIALS — 14 hardcoded (UUID, IP) pairs)
ALL_CREDENTIALS = [
    (31181410, '10.221.13.189'),
    (15280056, '10.221.13.141'),
    ...
]
```

**These are on disk and (if `xbbg_sapi/` is in the repo) will end up in git history.** Before doing anything else:

1. **Add `xbbg_sapi_extracted/` to `.gitignore`** (it isn't yet — I can see it in `git status`).
2. **Confirm with your mentor** whether those credentials are safe to commit, or whether the wheel should be installed only via the `.whl` (so the source never lands in git).
3. **Plan to override** `DEFAULT_HOST`, `DEFAULT_UUID`, `DEFAULT_USER_IP` via env vars (`BBG_HOST`, `BBG_UUID`, `BBG_USER_IP`) so we don't rely on the hardcoded values.

---

## Architecture (proposed)

```
┌─────────────────────────────────────────────────────────────────┐
│  Bloomberg-enabled host (your dev machine or firm VM)           │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ bloomberg_service.py  (Python, FastAPI)                   │  │
│  │  - on startup: from xbbg_sapi import bdp, connect        │  │
│  │  - GET  /quote?ticker=AAPL  →  Bloomberg bdp             │  │
│  │  - GET  /quotes?tickers=...   →  batched bdp             │  │
│  │  - POST /refresh?ticker=...  →  force refresh            │  │
│  │  - GET  /search?q=apple        →  bds/beqs               │  │
│  │  - cron loop every 5 min: tickers_in_use() → upsert       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Bloomberg SAPI/B-PIPE  (10.103.1.46:8194)                      │
└────────────────────────┬────────────────────────────────────────┘
                         │  HTTPS (LAN or tunnel)
                         ▼
              Supabase Edge Function (Deno)
              `market-data`  →  RELAY only (no Python)
              - auth check
              - calls bloomberg_service.py
              - reads/writes stock_prices table
              - returns same JSON shape as today
                         │
                         ▼
                  `stock_prices` table
                  (unchanged schema)
                         │
                         ▼
              ai-service (Deno) reads cache
              Frontend (useLivePrices) polls every 60s
```

**No frontend changes** — `frontend/src/services/marketData.ts` and `AIChatPage.tsx` continue to call `${supabaseUrl}/functions/v1/market-data/...` exactly as today.

---

## File changes

### New files to create

| Path | Purpose |
|---|---|
| `bloomberg-service/app.py` | FastAPI service exposing the price endpoints |
| `bloomberg-service/ticker_map.py` | Ticker → Bloomberg symbol suffix helper (e.g. `AAPL` → `AAPL US Equity`) |
| `bloomberg-service/scheduler.py` | 5-min cron loop calling `tickers_in_use()` + `bdp()` and upserting `stock_prices` |
| `bloomberg-service/requirements.txt` | `fastapi`, `uvicorn`, `xbbg_sapi`, `supabase`, `pandas` |
| `bloomberg-service/.env.example` | `BBG_HOST=10.103.1.46`, `BBG_PORT=8194`, `BBG_UUID=...`, `BBG_USER_IP=...`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` |
| `bloomberg-service/README.md` | Local dev + deployment instructions |
| `supabase/migrations/003_bloomberg_field_map.sql` | Optional: comment on `stock_prices.last_updated` index if needed |

### Files to modify

| Path | Change |
|---|---|
| `supabase/functions/market-data/index.ts` | Replace `fetchFinnhubQuote()` with `fetchBloombergQuote()` that calls the Python service. Keep the cache-first / refresh-on-stale logic. Keep all route shapes identical. |
| `supabase/functions/market-data/.env.example` | Remove `FINNHUB_API_KEY`. Add `BLOOMBERG_RELAY_URL` and `BLOOMBERG_RELAY_KEY` (if Python service has its own auth). |
| `supabase/functions/ai-service/.env.example` | Remove the line "`FINNHUB_API_KEY` — only needed if you also run market-data locally" comment, since it's no longer accurate. |
| `DEPLOYMENT.md` | New section: deploy bloomberg-service, new secrets, removal of `FINNHUB_API_KEY`. |
| `.gitignore` | Add `xbbg_sapi_extracted/`, `bloomberg-service/.venv/`, `bloomberg-service/__pycache__/`. |

### Files NOT to touch

- `frontend/src/services/marketData.ts` ✅
- `frontend/src/pages/AIChatPage.tsx` ✅
- `frontend/src/pages/PortfolioDetailPage.tsx` ✅
- `supabase/functions/ai-service/index.ts` ✅ (already reads `stock_prices` cache; the data source is transparent to it)
- `supabase/functions/_shared/*` ✅
- `supabase/migrations/002_market_data.sql` ✅

---

## `bloomberg-service/app.py` (sketch)

```python
"""
Bloomberg Relay Service
Wraps xbbg_sapi with a FastAPI HTTP interface so the existing Supabase
`market-data` Edge Function can call it instead of Finnhub.
"""
import os
from typing import Optional
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel
import pandas as pd
from xbbg_sapi import bdp, connect, bds

app = FastAPI(title="Bloomberg Relay")

# --- Config from env (overrides hardcoded defaults in xbbg_sapi) ---
BBG_HOST = os.environ.get("BBG_HOST", "10.103.1.46")
BBG_PORT = int(os.environ.get("BBG_PORT", "8194"))
BBG_UUID = os.environ.get("BBG_UUID")  # optional
BBG_USER_IP = os.environ.get("BBG_USER_IP")  # optional

# --- Ticker -> Bloomberg symbol mapping ---
# Strip the exchange suffix in the input, append the standard one.
# (For now, hardcode US; expand later.)
EXCHANGE_SUFFIX = " US Equity"

def to_bbg_symbol(ticker: str) -> str:
    t = ticker.strip().upper()
    if " " in t:  # already has a suffix
        return t
    return t + EXCHANGE_SUFFIX

# --- Connect to Bloomberg at startup ---
@app.on_event("startup")
def startup():
    connect(host=BBG_HOST, port=BBG_PORT, uuid=BBG_UUID, userIP=BBG_USER_IP)

# --- Response model (matches existing CachedPrice in market-data) ---
class Quote(BaseModel):
    ticker: str
    current_price: float
    previous_close: Optional[float] = None
    change_pct: Optional[float] = None
    day_high: Optional[float] = None
    day_low: Optional[float] = None
    day_open: Optional[float] = None
    volume: Optional[int] = None
    company_name: Optional[str] = None
    sector: Optional[str] = None
    last_updated: str

# --- Endpoints mirroring the old market-data API ---

@app.get("/quote", response_model=Quote)
def quote(ticker: str = Query(..., min_length=1, max_length=10)):
    sym = to_bbg_symbol(ticker)
    try:
        # bdp returns a DataFrame; rows=tickers, columns=fields
        df = bdp([sym], ["PX_LAST", "PX_OPEN", "PX_HIGH", "PX_LOW",
                          "PX_PREVIOUS_CLOSE", "VOLUME",
                          "CHG_PCT_1D"])
        if df.empty:
            raise HTTPException(404, f"No data for {sym}")
        row = df.iloc[0]
        return Quote(
            ticker=ticker.upper(),
            current_price=float(row["PX_LAST"]),
            previous_close=float(row.get("PX_PREVIOUS_CLOSE") or 0) or None,
            change_pct=float(row.get("CHG_PCT_1D") or 0) or None,
            day_high=float(row.get("PX_HIGH") or 0) or None,
            day_low=float(row.get("PX_LOW") or 0) or None,
            day_open=float(row.get("PX_OPEN") or 0) or None,
            volume=int(row.get("VOLUME") or 0) or None,
            last_updated=pd.Timestamp.utcnow().isoformat(),
        )
    except Exception as e:
        raise HTTPException(502, f"Bloomberg error: {e}")

@app.get("/quotes")
def quotes(tickers: str = Query(...)):
    syms = [to_bbg_symbol(t) for t in tickers.split(",")]
    raw = [s.split(" ")[0] for s in syms]  # original tickers
    df = bdp(syms, ["PX_LAST", "PX_PREVIOUS_CLOSE", "CHG_PCT_1D"])
    out = {}
    for i, t in enumerate(raw):
        if i in df.index:
            row = df.loc[syms[i]]
            out[t] = {
                "ticker": t,
                "current_price": float(row["PX_LAST"]),
                "previous_close": row.get("PX_PREVIOUS_CLOSE"),
                "change_pct": row.get("CHG_PCT_1D"),
            }
    return out

@app.get("/search")
def search(q: str = Query(..., min_length=1)):
    """Lightweight wrapper — xbbg_sapi's beqs may need a real BQL screen."""
    # Use Bloomberg's bulk reference data for company search
    # (Implementation depends on the firm's beqs configuration.)
    raise HTTPException(501, "search not yet implemented for Bloomberg")
```

---

## `bloomberg-service/scheduler.py` (sketch)

```python
"""
5-minute refresh loop. Only refreshes tickers the user is actively using
to stay within Supabase free-tier write limits.
"""
import os
import time
import logging
from datetime import datetime
from supabase import create_client
from xbbg_sapi import bdp, connect

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("bbg-scheduler")

# Connect
connect(
    host=os.environ.get("BBG_HOST", "10.103.1.46"),
    port=int(os.environ.get("BBG_PORT", "8194")),
)

# Supabase service client (for writing to stock_prices)
supabase = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_KEY"],
)

REFRESH_INTERVAL = 5 * 60  # 5 minutes
CLEANUP_INTERVAL = 60 * 60  # 1 hour
FIELDS = ["PX_LAST", "PX_OPEN", "PX_HIGH", "PX_LOW",
          "PX_PREVIOUS_CLOSE", "VOLUME", "CHG_PCT_1D"]

def refresh_once():
    # Get tickers in active use (function already exists in DB)
    res = supabase.rpc("tickers_in_use").execute()
    tickers = res.data or []
    if not tickers:
        log.info("No active tickers; skipping refresh")
        return
    log.info(f"Refreshing {len(tickers)} tickers: {tickers}")

    # Build Bloomberg symbols
    syms = [t + " US Equity" for t in tickers]
    try:
        df = bdp(syms, FIELDS)
    except Exception as e:
        log.error(f"bdp() failed: {e}")
        return

    # Upsert into stock_prices
    rows = []
    for sym, t in zip(syms, tickers):
        if sym in df.index:
            row = df.loc[sym]
            rows.append({
                "ticker": t,
                "current_price": float(row["PX_LAST"]),
                "previous_close": float(row.get("PX_PREVIOUS_CLOSE") or 0) or None,
                "change_pct": float(row.get("CHG_PCT_1D") or 0) or None,
                "day_high": float(row.get("PX_HIGH") or 0) or None,
                "day_low": float(row.get("PX_LOW") or 0) or None,
                "day_open": float(row.get("PX_OPEN") or 0) or None,
                "volume": int(row.get("VOLUME") or 0) or None,
                "last_updated": datetime.utcnow().isoformat(),
            })
    if rows:
        supabase.table("stock_prices").upsert(rows).execute()
        log.info(f"Updated {len(rows)} rows in stock_prices")

def cleanup_stale():
    # Remove rows for tickers no longer held
    res = supabase.rpc("tickers_in_use").execute()
    active = set(t.upper() for t in (res.data or []))
    if not active:
        return
    # Get all cached tickers
    all_cached = supabase.table("stock_prices").select("ticker").execute()
    stale = [r["ticker"] for r in (all_cached.data or [])
             if r["ticker"] not in active]
    if stale:
        supabase.table("stock_prices").delete().in_("ticker", stale).execute()
        log.info(f"Cleaned up {len(stale)} stale rows")

if __name__ == "__main__":
    last_cleanup = 0
    while True:
        try:
            refresh_once()
            if time.time() - last_cleanup > CLEANUP_INTERVAL:
                cleanup_stale()
                last_cleanup = time.time()
        except Exception as e:
            log.exception("Refresh cycle failed")
        time.sleep(REFRESH_INTERVAL)
```

---

## `market-data/index.ts` — what changes

Replace the Finnhub calls with HTTP calls to the Python service. **The route shapes and JSON responses stay identical** so callers don't notice.

```typescript
// OLD
const FINNHUB_BASE = 'https://finnhub.io/api/v1';
async function fetchFinnhubQuote(ticker, apiKey) { ... }

// NEW
const BLOOMBERG_RELAY_URL = Deno.env.get('BLOOMBERG_RELAY_URL')!;
const BLOOMBERG_RELAY_KEY = Deno.env.get('BLOOMBERG_RELAY_KEY') ?? '';

async function fetchBloombergQuote(ticker: string) {
  const res = await fetch(
    `${BLOOMBERG_RELAY_URL}/quote?ticker=${encodeURIComponent(ticker)}`,
    { headers: { 'X-API-Key': BLOOMBERG_RELAY_KEY } },
  );
  if (!res.ok) throw new Error(`Bloomberg relay ${res.status}`);
  return await res.json();  // already in our CachedPrice shape
}
```

Everything else in `market-data/index.ts` (cache-first logic, `readCache`, `writeCache`, route handlers, the `X-Stale` fallback) stays the same.

---

## Secrets & env vars

### Supabase Edge Function secrets (run `supabase secrets set …`)

| Old | New |
|---|---|
| `FINNHUB_API_KEY` | **Remove** |
| — | `BLOOMBERG_RELAY_URL` (e.g. `http://10.0.0.5:8000` if on LAN, or a tunnel URL) |
| — | `BLOOMBERG_RELAY_KEY` (a shared secret between Edge Function and Python service, if you add auth) |

### Python service env (`.env` or systemd unit)

```
BBG_HOST=10.103.1.46
BBG_PORT=8194
BBG_UUID=<optional, override hardcoded default>
BBG_USER_IP=<optional, override hardcoded default>
SUPABASE_URL=https://cygsvvhdkpnqxfuoqkyq.supabase.co
SUPABASE_SERVICE_KEY=<service_role or secret key>
```

---

## Free-tier impact (revisited)

The 5-min cron for `tickers_in_use()` writes **~14K rows/day** for 50 tickers (well under the 500K Edge Function invocation limit, and a non-issue for DB storage). The Edge Function relay is now a simple passthrough — even lower cost than the current Finnhub path. **No free-tier concern.**

---

## Deployment steps (when you're ready to implement)

1. **Pre-flight** — confirm with mentor that the hardcoded `ALL_CREDENTIALS` in `core.py` are safe to keep, or override via env vars.
2. **Update `.gitignore`** to exclude `xbbg_sapi_extracted/`.
3. **Add `bloomberg-service/`** with `app.py`, `scheduler.py`, `requirements.txt`, `.env.example`, `README.md`.
4. **Edit `market-data/index.ts`** to call the Python relay.
5. **Update `market-data/.env.example`** and `DEPLOYMENT.md`.
6. **Run `supabase secrets unset FINNHUB_API_KEY`** and add the new secrets.
7. **Run `supabase functions deploy market-data`** to push the changes.
8. **Install `bloomberg-service`** on the B-PIPE host:
   ```bash
   cd bloomberg-service
   python -m venv .venv
   source .venv/bin/activate  # or .venv\Scripts\Activate.ps1 on Windows
   pip install -r requirements.txt
   pip install ../xbbg_sapi-1.0.0-py3-none-any.whl
   uvicorn app:app --host 0.0.0.0 --port 8000   # API
   python scheduler.py                          # cron loop (in another terminal or systemd)
   ```
9. **Smoke test** — call `market-data/quote?ticker=AAPL` from the app; should return real Bloomberg data within ~2s.
10. **Verify** that `ai-service` still works (no changes there, but the `market_price` field should now be sourced from Bloomberg).

---

## Open questions for your mentor

1. Are the hardcoded `ALL_CREDENTIALS` (UUIDs + IPs in `core.py:40-55`) safe to leave in the wheel as distributed, or should we plan to use only env-var-supplied credentials?
2. Is the B-PIPE host `10.103.1.46:8194` reachable from where the Python service will run, or do you need a different host/port?
3. Bloomberg symbol convention: is `AAPL US Equity` the right suffix for our use case, or do you prefer another exchange (e.g. `AAPL UW Equity` for CUSIP-only)?
4. Do you want a `bdh()` historical data path (for charts) or just the current `bdp()` quote path?
5. Field set: do you want OHLC + volume + name + sector from day 1, or just `PX_LAST` to start?
