# Bloomberg Relay Service

A small FastAPI service that wraps the firm's `xbbg_sapi` package and exposes
HTTP endpoints for the Supabase `market-data` Edge Function to call. It also
runs a 5-minute scheduler that keeps the `stock_prices` cache fresh in
Supabase by calling `tickers_in_use()` and `bdp()`.

```
React (Vercel)  ──▶  Supabase Edge Function: market-data (Deno)
                                       │
                                       ▼  (LAN / tunnel)
                            This service (FastAPI / xbbg_sapi)
                                       │
                                       ▼
                              Bloomberg SAPI/B-PIPE
```

## Why it exists

`xbbg_sapi` (and the underlying `blpapi` C++ library) cannot run in
Supabase Edge Functions — Edge Functions are Deno-based and cannot load
native C++ libraries, and B-PIPE requires a network connection from a
firm-whitelisted IP. This service runs on a host that satisfies both
requirements, and exposes a tiny HTTP API that mirrors what the old
Finnhub-based `market-data` function used to do internally.

The frontend (`useLivePrices`, `AIChatPage`) does not need to change.

## Endpoints

| Method | Path                     | Purpose                          |
|--------|--------------------------|----------------------------------|
| GET    | `/healthz`               | Liveness probe (no Bloomberg)    |
| GET    | `/quote?ticker=AAPL`     | Current quote for one ticker     |
| GET    | `/quotes?tickers=...`    | Batch quotes (up to 50)          |
| POST   | `/refresh?ticker=AAPL`   | Force-refresh one ticker         |
| GET    | `/search?q=apple`        | Ticker search (501 for now)      |

All endpoints except `/healthz` require the `X-API-Key` header to match
the `RELAY_API_KEY` env var.

## Local development

```powershell
# 1. Create a venv
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# 2. Install dependencies + the firm-provided wheel
pip install -r requirements.txt
pip install ..\xbbg_sapi-1.0.0-py3-none-any.whl

# 3. Configure
cp .env.example .env
# Edit .env: set RELAY_API_KEY and SUPABASE_SERVICE_KEY at minimum

# 4. Run the API
uvicorn app:app --host 0.0.0.0 --port 8000 --reload

# 5. In another terminal, run the scheduler
python scheduler.py
```

## Smoke test

Once the API is running:

```bash
# Health
curl http://localhost:8000/healthz

# Quote
curl "http://localhost:8000/quote?ticker=AAPL" -H "X-API-Key: your_key"

# Batch
curl "http://localhost:8000/quotes?tickers=AAPL,TSLA,NVDA" -H "X-API-Key: your_key"
```

## Deployment (production)

This service must run on a host that:
1. Has Bloomberg B-PIPE network access (firm IP whitelisted at Bloomberg)
2. Has the `blpapi` native C++ library installed (per firm's instructions)
3. Is reachable from the Supabase Edge Function's outbound network
   (typically via Cloudflare Tunnel, an internal VPN, or a public IP)

Suggested deployment:
- **systemd** unit on a firm VM, or
- **Docker** container orchestrated by the firm's standard platform, or
- **pm2 / supervisor** on a long-running dev box

A minimal `systemd` unit:

```ini
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

And one for the scheduler:

```ini
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

## How it talks to Supabase

The Supabase `market-data` Edge Function calls this service like:

```
GET https://your-bloomberg-relay.example.com/quote?ticker=AAPL
X-API-Key: <RELAY_API_KEY>
```

Configure that URL on Supabase:

```bash
supabase secrets set BLOOMBERG_RELAY_URL=https://your-bloomberg-relay.example.com
supabase secrets set BLOOMBERG_RELAY_KEY=your_random_secret
```

The Edge Function still owns the `stock_prices` cache writes — it reads
the response from this service and upserts it into Supabase, exactly
the same way it used to upsert Finnhub responses. This keeps a single
source of truth for the cache and means the Python service doesn't
need its own Supabase write access for the price-serving path.

(The scheduler does need write access because it pre-populates the
cache in the background for tickers the user holds but isn't
currently viewing.)

## Security notes

- `xbbg_sapi` ships with hardcoded firm credentials in
  `core.py` (DEFAULT_HOST, ALL_CREDENTIALS, etc.). Setting `BBG_HOST`,
  `BBG_UUID`, `BBG_USER_IP` env vars overrides the defaults so we
  don't have to rely on them.
- The wheel and the extracted `xbbg_sapi_extracted/` directory are
  gitignored. Do not commit them.
- `RELAY_API_KEY` should be a long random string, ideally rotated
  periodically. The same value lives in `supabase secrets list` under
  `BLOOMBERG_RELAY_KEY`.
- The `SERVICE_KEY`/`SUPABASE_SERVICE_KEY` is the same secret used by
  the Edge Functions — it has full read/write access to your database.
  Treat it like a root password.
