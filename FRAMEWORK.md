# PaperTrade — Framework & Features

> A paper-trading playground that lets you test trading strategies in a
> realistic multi-asset environment using **institutional-grade Bloomberg
> market data** through a chat-style natural language interface.

---

## 1. What it is

PaperTrade is a full-stack web app for simulating trades across US
equities, ETFs, futures, FX, and HK equities. The unique selling point
is the data feed: instead of the usual retail-grade API (Finnhub, etc.),
prices come straight from **Bloomberg SAPI / B-PIPE** through an
on-premise relay running on a firm-whitelisted host.

You can drive trades by clicking through the UI, or — more interestingly
— by typing plain-English commands like `"short 50 NVDA at market"` or
`"buy $50k of AAPL"` into an AI chat box, which uses Google's Gemini
to parse the command, fetch a live price, and present a confirmation
card before executing.

The whole stack is designed to be cheap (Supabase free tier) and to
have **no breaking change** between the data source swap
(Finnhub → Bloomberg) — the Supabase Edge Function preserves the
existing JSON contract so the frontend never noticed.

---

## 2. System architecture

```
┌─────────────────┐    ┌─────────────────────┐    ┌────────────────────────┐
│   Vercel (FE)   │    │ Supabase Edge       │    │ bloomberg-service      │
│   React + Vite  │───▶│  market-data (Deno) │───▶│ Python (FastAPI) on    │
│                 │    │  - auth check       │    │ firm LAN / B-PIPE host │
│  useLivePrices  │    │  - cache-first      │    │ uses xbbg_sapi/blpapi  │
│  60s auto-refresh   │  - 5 min cache TTL  │    │                        │
└─────────────────┘    │   ┌──────────────┐  │    │   ┌──────────────┐     │
        │              │   │ instrument_  │  │    │   │ xbbg_sapi    │     │
        │              │   │ prices       │  │    │   │  bdp()/bdh() │     │
        ▼              │   │ (Supabase)   │  │    │   └──────┬───────┘     │
┌─────────────────┐    │   └────▲─────────┘  │    │          ▼             │
│   Vercel (FE)   │    └────────┼─────────────┘    │   Bloomberg SAPI        │
│   AI Chat       │             │                  │   10.103.1.46:8194      │
│                 │             │                  └────────────────────────┘
│  callAI(parse)  │    ┌────────┴─────────┐
└────────┬────────┘    │ Supabase Edge   │
         │             │  ai-service     │
         └────────────▶│  (Deno)         │
                       │  reads cache    │
                       └─────────────────┘
```

The Python `scheduler.py` is a separate long-lived process that, every
5 minutes, asks Supabase "which tickers is anyone actually holding?",
fetches fresh prices from Bloomberg, and writes them into the cache
table so prices stay warm even when nobody is viewing them.

### Why a Python relay?

`xbbg_sapi` (and the underlying `blpapi` C++ library) **cannot** run in
Supabase Edge Functions — Edge Functions are Deno-based and cannot
load native C++ libraries, and B-PIPE requires a network connection
from a firm-whitelisted IP. So a small Python service runs on a
Bloomberg-enabled host and exposes a thin HTTP API that mirrors what
the old Finnhub-based Edge Function used to do internally.

---

## 3. Tech stack

### Frontend (`frontend/`)
- **React 18** + **TypeScript** + **Vite**
- **Tailwind CSS** for styling
- **react-router-dom v6** for SPA routing
- **@supabase/supabase-js v2** for auth and DB
- **recharts** for portfolio charts
- **zustand** for client state
- **react-hook-form** for form handling
- **lucide-react** for icons
- **axios** for HTTP
- **date-fns** for dates

### Supabase backend (`supabase/`)
- **Postgres** with Row Level Security (RLS)
- **Edge Functions (Deno)** — `market-data` and `ai-service`
- **Anonymous sign-in** auth
- **Cloudflare Tunnel** (in dev) exposes the local Bloomberg relay to
  the Edge Function

### Market data relay (`bloomberg-service/`)
- **Python 3.8+** + **FastAPI** + **uvicorn**
- **xbbg_sapi** + **blpapi** (Bloomberg SAPI/B-PIPE)
- **supabase-py** for cache writes from the scheduler
- **pandas** for dataframe wrangling

### AI layer
- **Google Gemini** (`gemini-2.5-flash` / `gemini-2.5-flash-lite`)
- Function-calling mode with strict JSON schema
- 4-second timeout, self-critique step at low confidence,
  in-memory LRU cache for repeated commands
- User-editable `SYSTEM_INSTRUCTIONS.md` for tone/examples

### Tooling & ops
- **Vercel** hosting for the frontend (auto-redeploy on push)
- **Supabase CLI** for function deploys + secret management
- **systemd** unit files for production-style deployment of the relay
- **pre-commit** hooks (`.pre-commit-config.yaml`)
- **Chroma + Ollama** indexing (`indexing/`) for offline semantic
  search of the repo
- **Custom doc viewer** (`doc/`) for browsing project documentation

---

## 4. Repository layout

```
papertrade/
├── frontend/                        # React + Vite SPA (deploys to Vercel)
│   ├── src/
│   │   ├── App.tsx                  # Router + auth gate
│   │   ├── components/Layout.tsx    # Top-nav + shell
│   │   ├── pages/
│   │   │   ├── LoginPage.tsx
│   │   │   ├── DashboardPage.tsx    # Portfolio list / create / archive
│   │   │   ├── PortfolioDetailPage.tsx  # Positions, P&L, charts
│   │   │   ├── AIChatPage.tsx       # Natural-language trade entry
│   │   │   ├── HotStocksPage.tsx    # Live multi-asset dashboard
│   │   │   └── ComparisonPage.tsx   # Side-by-side portfolio compare
│   │   ├── services/
│   │   │   ├── db.ts                # Portfolio / trade CRUD
│   │   │   └── marketData.ts        # useLivePrices + refreshQuote
│   │   └── lib/supabase.ts          # callAI() + Supabase client
│   └── vercel.json                  # SPA rewrite fix
│
├── supabase/
│   ├── functions/
│   │   ├── _shared/                 # CORS, auth, shared helpers
│   │   ├── market-data/             # Price proxy + cache
│   │   └── ai-service/              # LLM command parser
│   └── migrations/
│       ├── 001_initial_schema.sql   # Users, portfolios, positions, trades
│       ├── 002_market_data.sql      # instrument_prices table + tickers_in_use()
│       ├── 003_trade_executed_at.sql
│       ├── 004_shorting.sql         # direction (LONG/SHORT)
│       └── 005_instrument_universe.sql  # asset_class, bbg_symbol, etc.
│
├── bloomberg-service/               # Python FastAPI relay
│   ├── app.py                       # /quote, /quotes, /refresh, /search, /healthz
│   ├── scheduler.py                 # 5-min cache pre-populator
│   ├── ticker_map.py                # AAPL → "AAPL US Equity"
│   ├── requirements.txt
│   ├── .env.example
│   └── README.md
│
├── indexing/                        # Chroma + Ollama offline indexer
│   ├── build_index.py
│   ├── query_index.py
│   ├── requirements.txt
│   └── README.md
│
├── doc/                             # Static HTML doc viewer
│   ├── doc-style.css
│   ├── doc-script.js
│   └── doc-filelist.js
│
├── .venv-bb/                        # Python venv (blpapi + xbbg_sapi)
├── .venv-index/                     # Python venv (Chroma + requests)
├── xbbg_sapi-1.0.0-*.whl            # Firm wheel (gitignored)
├── xbbg_sapi_extracted/             # Extracted wheel source (gitignored)
├── .chroma/                         # Persisted vector index (gitignored)
│
├── SETUP.md                         # Daily startup playbook (Bloom relay)
├── DEPLOYMENT.md                    # Production deploy guide
├── BLOOMBERG_MIGRATION_PLAN.md      # Migration history (Finnhub → BBG)
└── FRAMEWORK.md                     # ← you are here
```

---

## 5. Features

### 5.1 Multi-portfolio management
- Create, clone, archive, reset, and delete **paper portfolios** with
  configurable initial capital.
- Each portfolio tracks its own positions, P&L, and trade history.
- Anonymous Supabase auth — no email required, every device is a new
  user.
- Dashboard view shows all portfolios with quick stats and a
  position-count badge.

### 5.2 Multi-asset trading
- Supports **US equity**, **ETF** (e.g. `SPY`), **futures**
  (e.g. `ES1`, `CLZ25`), **FX** (e.g. `EURUSD`), and **HK equity**
  (e.g. `700`, `00700`).
- The `bloomberg-service` auto-detects asset class from the ticker
  shape and resolves the canonical Bloomberg symbol
  (`AAPL` → `AAPL US Equity`, `700` → `700 HK Equity`, `ES1` → `ES1
  Comdty`, `EURUSD` → `EURUSD Curncy`).
- `instrument_prices` cache (renamed from `stock_prices` in migration
  005) holds `asset_class`, `bbg_symbol`, `contract_size`, `currency`,
  and `expiry_date` columns for the full instrument universe.

### 5.3 Long and short positions (migration 004)
- `trades.direction` is now `LONG` / `SHORT`; old rows default to `LONG`.
- New actions in the AI chat: `SHORT` and `COVER`.
- The portfolio page renders Long/Short badges and **signed quantities**
  (`-100` for a short position, `+100` for a long).
- A non-negativity check on `positions.avg_price` ensures data sanity.

### 5.4 Live Bloomberg prices
- The frontend's `useLivePrices` hook polls
  `market-data/quote?ticker=…` every **60 seconds** for visible
  positions.
- The Edge Function checks the `instrument_prices` cache first; if
  fresh (<5 min), returns it. Otherwise, calls the Python relay
  → `xbbg_sapi.bdp()` → writes result back to the cache and returns
  it. `from_cache: true/false` flag in the response.
- The frontend gets `current_price`, `previous_close`, `change_pct`,
  `day_high`, `day_low`, `day_open`, `volume`, and `last_updated`.

### 5.5 Natural-language AI chat
- Type commands like:
  - `"Buy 100 AAPL at market"`
  - `"Short 50 NVDA, stop loss 5%"`
  - `"Cover my TSLA short"`
  - `"Buy $50k of AAPL"` (notional — qty is resolved at click time)
  - `"What did AAPL close at yesterday?"` (historical)
  - `"Buy 100 AAPL at the open"`
- Returns a parsed command card with action, direction, qty/notional,
  confidence, and a **Live Market** price badge (sourced from
  Bloomberg via the relay).
- A confirmation click executes the trade. Errors are returned
  gracefully with explanatory messages.

### 5.6 Notional-based orders
- "Buy $50k of AAPL" parses with `notional: 50000, qty: null,
  preview_qty: ~123`. The system, not the LLM, turns the dollar
  amount into a share count at click time using the freshest cached
  price. This way the live price can move between parse and execute
  without surprising the user.

### 5.7 Historical-date support
- "3 days ago", "yesterday", "on 2026-06-01" all return the close
  price from that date and flag `is_historical: true`.
- Uses Bloomberg `bdh()` (historical data) via the relay.

### 5.8 Intraday time-of-day
- "at the open", "this morning", "at close" all parse into a
  `time_of_day` field (`pre`/`open`/`regular`/`close`/`post`/`eod`).

### 5.9 Hot Stocks page
- Big, visual, immediately useful landing screen.
- Shows a curated set of tickers across asset classes
  (US equity, ETF, futures, FX, HK equity) with live price, % change,
  day range, and volume.
- Filterable by asset class, with auto-refresh and a pulsing live
  indicator.
- Renders the full data path: Vercel → Supabase → Cloudflare →
  bloomberg-service → Bloomberg SAPI.

### 5.10 Portfolio comparison
- Side-by-side comparison of two portfolios: positions, P&L, trade
  history. Useful for strategy A/B testing.

### 5.11 Comparison & analytics
- Each portfolio has detail page with position-level live prices and
  charts (recharts).
- Trade log shows executed trades with `executed_at`, price, qty,
  direction, fees, P&L.

### 5.12 SPA routing
- `vercel.json` at the repo root rewrites all unmatched paths to
  `/index.html` so deep links like `/portfolio/<uuid>` and `/ai`
  render the SPA instead of 404'ing.

### 5.13 AI quality features
- Gemini function calling (strict schema)
- 4-second timeout (falls back to lite model)
- Self-critique step at low confidence
- In-memory LRU cache for repeated commands
- User-editable `SYSTEM_INSTRUCTIONS.md` for tone/examples **without
  redeploying**

### 5.14 Service-to-service auth
- `INTERNAL_API_KEY` is a separate, low-privilege shared secret used
  only for service-to-service HTTP calls between Edge Functions
  (`ai-service` → `market-data`).
- Must be set to the **same value** on both functions.
- Unlike `SERVICE_KEY` (the DB service-role key), a leak of
  `INTERNAL_API_KEY` only identifies a caller as "another edge
  function"; it grants no DB privileges.
- The shared `supabase/functions/_shared/auth.ts` helper accepts a
  Supabase user JWT **OR** the `INTERNAL_API_KEY` Bearer.

### 5.15 Offline semantic code search (indexing/)
- Builds a **Chroma** index of the whole repo using
  **`nomic-embed-text`** running in **Ollama**.
- `indexing/build_index.py` walks the repo (skipping `.git`,
  `node_modules`, `.venv*`, build artefacts, images), chunks files
  into ~2000-char windows with 200-char overlap, and POSTs each batch
  to Ollama's `/api/embeddings`.
- Vectors are stored in a persistent Chroma store at `./.chroma/` in a
  collection called `papertrade`.
- `indexing/query_index.py "..."` lets you query from the command
  line, ranked by cosine similarity.
- Also wireable into Kilo's built-in code indexing via an
  OpenAI-compatible provider pointing at Ollama.

### 5.16 Documentation site (doc/)
- A small static HTML/CSS/JS viewer for project docs.
- Lists and renders the markdown files in the repo (SETUP.md,
  DEPLOYMENT.md, FRAMEWORK.md, etc.) with custom styling.

---

## 6. Data flow for a typical "Buy 100 AAPL" request

1. **User types** `"Buy 100 AAPL at market"` in the AI chat.
2. **Frontend** (`AIChatPage.tsx`) calls `callAI(input)` →
   POSTs to `${SUPABASE_URL}/functions/v1/ai-service`.
3. **Edge Function `ai-service`** runs Gemini function-calling to
   parse the command. The parser doesn't touch prices yet — it
   returns `{action: "BUY", direction: "LONG", ticker: "AAPL",
   qty: 100, confidence: 0.95, needs_confirmation: true, ...}`.
4. **`ai-service`** then POSTs to
   `${SUPABASE_URL}/functions/v1/market-data/refresh?ticker=AAPL`
   (authenticated with `INTERNAL_API_KEY`).
5. **Edge Function `market-data`** checks the `instrument_prices`
   cache. If stale (>5 min), it calls the Python relay
   `https://<cloudflare-tunnel>/quote?ticker=AAPL` (authenticated
   with `BLOOMBERG_RELAY_KEY`).
6. **Python `bloomberg-service`** calls `xbbg_sapi.bdp(["AAPL US
   Equity"], [...])`, which opens a B-PIPE session on
   `10.103.1.46:8194` and returns the quote as a DataFrame.
7. **`market-data`** upserts the result into `instrument_prices` and
   returns the JSON to `ai-service`.
8. **`ai-service`** enriches the parsed command with
   `market_price`, `market_change_pct`, `market_context`,
   `from_cache: false` and returns the full payload to the frontend.
9. **Frontend** displays the parsed command card with the live price
   badge. User clicks **Confirm**.
10. **`executeTrade()`** in `services/db.ts` writes a row to `trades`
    with `direction = 'LONG'`, `executed_at = now()`, and updates
    `positions` (insert or merge with existing row).
11. **UI** re-fetches positions; the new row appears in the
    portfolio detail page with the live price ticking.

---

## 7. Security model

| Secret | Where it lives | What it grants | If leaked |
|---|---|---|---|
| `SERVICE_KEY` / `SUPABASE_SERVICE_KEY` | Supabase secrets, bloomberg-service `.env` | Full DB read/write, bypasses RLS | Game over. Treat as root password. |
| `BLOOMBERG_RELAY_KEY` / `RELAY_API_KEY` | Supabase secrets, bloomberg-service `.env` | Can call the relay | Attacker can fetch prices (and probe Bloomberg). No DB access. |
| `INTERNAL_API_KEY` | Supabase secrets (both functions) | Can call one Edge Function from another | Identifies caller as "another edge function"; no DB privileges. |
| `GEMINI_API_KEY` | Supabase secrets | Can call Gemini LLM | Attacker can run LLM queries; quota theft. |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Vercel env, public | Can call Edge Functions | Public anyway (intended). |
| `xbbg_sapi` wheel credentials | Bundled in the wheel (UUID + IP pairs) | Native B-PIPE access | Already on disk; not added by this code. |

### JWT handling

The Edge Functions are deployed with `--no-verify-jwt` because the
project uses anonymous auth, which the Supabase gateway rejects with
`UNAUTHORIZED_LEGACY_JWT` otherwise. JWTs are **not** signature-checked
at the edge. The shared `supabase/functions/_shared/auth.ts` helper
re-verifies them with `supabase.auth.getUser(jwt)` and falls back to a
soft payload decode for legacy anonymous tokens. New deployments
should migrate to the new anonymous sign-in flow and drop
`--no-verify-jwt` so the gateway enforces signatures.

### Git hygiene

- `xbbg_sapi_extracted/`, `xbbg_sapi-*.whl`, `.venv*`,
  `bloomberg-service/.venv/`, `.chroma/`, `frontend/dist/`, etc. are
  all `.gitignore`d. The wheel ships with hardcoded firm credentials;
  do not commit it.
- `BBG_HOST`, `BBG_UUID`, `BBG_USER_IP` env vars override the
  hardcoded defaults in `xbbg_sapi/core.py` so the deployed service
  doesn't have to rely on the wheel's built-in credentials.

---

## 8. Local development (TL;DR)

Three PowerShell windows, ~60 seconds from cold start:

| Window | Process | Command |
|---|---|---|
| 1 | Main shell | (your usual workspace) |
| 2 | uvicorn | `cd bloomberg-service && ..\..venv-bb\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000` |
| 3 | cloudflared | `& "$env:USERPROFILE\cloudflared.exe" tunnel --url http://localhost:8000` |
| 4 (optional) | scheduler | `cd bloomberg-service && ..\..venv-bb\Scripts\python.exe scheduler.py` |

Then `supabase secrets set BLOOMBERG_RELAY_URL=<cloudflare url>` and
open the Vercel app. Full details in [`SETUP.md`](./SETUP.md).

---

## 9. Production upgrade path

The current setup is fine for paper-trading. Production needs:

1. A **named Cloudflare Tunnel** (stable URL, no more manual reseed).
2. The relay running on a **firm VM with whitelisted IP, 24/7**.
3. **NSSM** (Windows) or **systemd** (Linux) for crash recovery.
4. Migrate anonymous auth to the new sign-in flow, drop
   `--no-verify-jwt`.
5. Set up monitoring + alerting on the relay and Edge Functions.
6. Add a `bdh()` historical data path (for charts beyond the
   cache).

See `BLOOMBERG_MIGRATION_PLAN.md` and `DEPLOYMENT.md` for the full
design.

---

## 10. Related documentation

- [`SETUP.md`](./SETUP.md) — daily startup playbook for the Bloomberg
  relay
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — full production deploy guide
- [`BLOOMBERG_MIGRATION_PLAN.md`](./BLOOMBERG_MIGRATION_PLAN.md) —
  design history of the Finnhub → Bloomberg migration
- `bloomberg-service/README.md` — relay-specific dev + deploy
- `indexing/README.md` — Chroma + Ollama offline indexer
- `supabase/migrations/` — database schema evolution
