# Tier 1 + Tier 2 Implementation Plan — PM-Grade Risk for the Long/Short Tool

## Goal

Move the Risk page and the position list from a long-only academic view to a **proper L/S PM view**, by:

1. **Tier 1** — pure frontend + the existing `riskMetrics.ts` service. Zero schema changes. Lands in 1–2 PRs.
2. **Tier 2** — one schema migration (add L/S columns to `daily_snapshots` + a snapshot writer that actually runs) + a new time-series chart. Lands in 1 PR.

The split is deliberate: Tier 1 surfaces longs vs shorts *now* using data we already have. Tier 2 fixes the deeper "no time" problem we just discussed by making `daily_snapshots` real, persistent, and L/S-aware.

---

## Current state (verified)

| File | What it does today | Gap |
|---|---|---|
| `frontend/src/services/riskMetrics.ts:49-54` | Computes `grossExposure` and `netExposure` from `positionValues` | Only `grossExposure` is returned; `netExposure` is discarded |
| `frontend/src/services/riskMetrics.ts:104-112` | Historical VaR 95% from `daily_return` series | No CVaR / Expected Shortfall, no Sortino, no current drawdown, no days-in-drawdown |
| `frontend/src/services/riskMetrics.ts:114-128` | Sector exposure groups `Math.abs(value)` per sector | No long vs short split; no per-side %, no net sector bar |
| `frontend/src/pages/RiskPage.tsx:282-367` | 6 metric tiles, all whole-book | No net-exposure tile, no net-% tile, no β tile (β is Tier 3) |
| `frontend/src/pages/RiskPage.tsx:424-487` | Pie + table of gross sector exposure | Pie is wrong for L/S — mixes long-tech $ with short-tech $ |
| `frontend/src/pages/PortfolioDetailPage.tsx:496-593` | Positions table with Direction badge, P&L, weight | No long/short subtotals, no concentration metrics, no MCR |
| `supabase/migrations/001_initial_schema.sql:57-67` | `daily_snapshots` has `equity, exposure, cash, daily_return` | No `long_value`, `short_value`, `net_value`, no `per_sector_jsonb`, no `per_position_jsonb` |
| `frontend/src/services/db.ts:535-546` | `createSnapshot` exists but is **never called** | Snapshots are empty for every user — Risk page's "365 snapshots" is always `[]` |
| `frontend/src/services/db.ts:583-671` | `buildPositionHistory` replays trades in JS to draw a per-position P&L curve | Works, but is O(trades × positions) in the browser on every page load |

The biggest hidden bug surfaced during planning: **the Risk page has never had real data**. `createSnapshot` was written but no one wired it to a cron, a button, or a workflow. Every risk number is computed against zero snapshots, which is why VaR shows "N/A" and the drawdown chart shows nothing for new users. This must be fixed in Tier 2 (or the Tier 2 charts are meaningless).

---

# Tier 1 — Pure frontend / service changes

All edits are in two files: `frontend/src/services/riskMetrics.ts` and `frontend/src/pages/RiskPage.tsx`. Plus one new file for the concentration metrics on the portfolio page.

## T1.1 — Expose `netExposure` and add L/S-aware metrics to `RiskMetrics`

**File:** `frontend/src/services/riskMetrics.ts`

**Changes:**

1. Add to the `RiskMetrics` interface (after L26):
   ```ts
   netExposure: number;          // sum of signed (qty * price) — already computed
   longExposure: number;         // sum of max(0, qty * price)
   shortExposure: number;        // sum of min(0, qty * price) — will be ≤ 0
   netExposurePct: number;       // netExposure / equity
   grossExposurePct: number;     // grossExposure / equity
   longExposurePct: number;
   shortExposurePct: number;
   currentDrawdownPct: number;   // running drawdown from peak (signed, negative)
   daysInDrawdown: number;       // 0 if at peak, else days since peak
   cvar95Pct: number | null;     // expected shortfall (mean of worst 5%)
   sortinoRatio: number | null;  // downside-deviation Sharpe
   ```

2. Add computation block for the new fields. Use signed `pv.value` (which is `qty × price`, signed) — `pv.position.qty < 0` is a short. No new data needed.

3. **CVaR 95%** implementation: take the worst-5% returns, average them, return as a positive loss magnitude. Keep the same `>= 20 observations` guard as VaR. Reuse `dailyReturns` from L63.

4. **Sortino**: identical to Sharpe (L62–L80) but denominator is `sqrt(mean(min(0, r - rfr_daily)^2))` (downside deviation). Reject zero downside.

5. **Current drawdown** + **days in drawdown**: walk `snapshots` from latest backwards, count until `equity >= runningPeak`. Return 0 if at peak.

**Acceptance:** `computeRiskMetrics` returns the new fields; existing call sites compile.

## T1.2 — Add Net Exposure + Long/Short tiles to the Risk page

**File:** `frontend/src/pages/RiskPage.tsx`

**Changes (in the 6-tile grid at L282–L367):**

Replace the existing 6 tiles with **8 tiles in a 2×4 grid** (`md:grid-cols-2 lg:grid-cols-4`):

| # | Label | Value | Subtitle | Tone |
|---|---|---|---|---|
| 1 | Return | `fmtPct(metrics.returnPct)` | unchanged | unchanged |
| 2 | **Net Exposure** | `fmtPct(metrics.netExposurePct)` | `Net $X` | positive if long-bias, negative if short-bias, neutral near 0 |
| 3 | **Gross Exposure** | `fmtPct(metrics.grossExposurePct)` | `Gross $X` | warning if > 180%, negative if > 220% |
| 4 | **Long $** | `fmtPct(metrics.longExposurePct)` | `$X` | positive |
| 5 | **Short $** | `fmtPct(metrics.shortExposurePct)` | `$-X` (absolute) | negative |
| 6 | Sharpe | unchanged | unchanged | unchanged |
| 7 | **Sortino** | `toFixed(2)` | `downside vol` | positive if > 1 |
| 8 | **Max DD** + **Current DD** combined | `fmtPct(-metrics.maxDrawdownPct)` / `fmtPct(metrics.currentDrawdownPct)` | `${daysInDrawdown}d in DD` | negative |

Drop the old Win Rate tile from the top (move to a smaller "secondary stats" line at the bottom of the tile row, or remove — it's a performance metric, not a risk metric). Move VaR 95% and Leverage into a new "Tail risk" card below the tiles (see T1.5).

**Acceptance:** New tiles render with correct tone logic; no console errors.

## T1.3 — Replace the sector pie with a long/short grouped bar chart

**File:** `frontend/src/pages/RiskPage.tsx`, replace the sector card at L424–L487.

**New shape:** two side-by-side charts.

1. **Left: Horizontal grouped bar chart** (`<BarChart layout="vertical">`).
   - X axis = sector, Y axis = `valueUsd` (% of equity).
   - Two `<Bar>`s per sector: green (long) and red (short), stacked. Or use `<Bar dataKey="longPct">` + `<Bar dataKey="shortPct">` with opposite-sign values so they sit on opposite sides of zero.
   - Add a "net" marker (a small `<ReferenceLine>` per sector, or a third bar).
   - Sort by `|netPct|` desc.

2. **Right: Table** with columns `Sector | Long $ | Long % | Short $ | Short % | Net $ | Net %`. Use existing `fmtMoney` + `fmtPct`. Color `Net %` green if positive, red if negative.

**Computation changes in `riskMetrics.ts`:**

Add a new helper:
```ts
export interface SectorLS {
  sector: string;
  longUsd: number;
  shortUsd: number;       // positive number
  netUsd: number;
  longPct: number;
  shortPct: number;
  netPct: number;
}
```

Iterate `positionValues`, use signed `pv.value` to bucket into `longUsd` and `shortUsd` (with `Math.abs` on the short side for the display number, but keep signs for `netUsd`).

Extend `RiskMetrics` with `sectorExposureLS: SectorLS[]` (sorted by `|netPct|` desc).

**Acceptance:** A portfolio that has `+AAPL` (Tech) and `−MSFT` (Tech) now shows a Tech row with both long and short bars, not a single combined bar.

## T1.4 — Long/Short subtotals + concentration metrics on the positions table

**File:** `frontend/src/pages/PortfolioDetailPage.tsx`, positions table at L496–L593.

**Changes:**

1. Above the `<table>`, add a 4-tile summary strip (compact, no full cards):
   - `Longs: N positions, $X (+X% gross)`
   - `Shorts: M positions, $X (+X% gross)`
   - `Net: $X (+X% equity)`
   - `Gross: $X (+X% equity)`

2. Add 3 new columns to the table:
   - **Weight** — `value / equity` as a % of NAV (signed for shorts).
   - **Days Held** — `floor((now - position.updated_at) / 1 day)` (cheap proxy; full holding period is Tier 2).
   - **% Gross** — `|value| / sum(|all values|)` as a % of book gross (for concentration).

3. **Concentration row** at the bottom of the card (a small footer with three stats):
   - **Herfindahl** of long side: `Σ (longWeight)^2` (lower = more diversified).
   - **Herfindahl** of short side: same.
   - **Top-5 names** as % of gross.

4. **Sort** the table by `|weight|` desc by default (largest positions first — what a PM scans).

**Computation:** add a new pure helper in `riskMetrics.ts` (or a new `services/concentration.ts`):
```ts
export function concentrationMetrics(positions, livePrices, equity): {
  herfindahlLong, herfindahlShort, top5GrossPct, largestSinglePct
}
```

**Acceptance:** Visual long/short split is obvious; concentration numbers are correct (manually verifiable: `Σ (longWeight)^2 + Σ (shortWeight)^2` ≤ 1, with equality only if one name on each side).

## T1.5 — New "Tail risk" card with VaR + CVaR + Leverage

**File:** `frontend/src/pages/RiskPage.tsx`, insert a new card after the 8-tile row, before the underwater chart.

Layout: a single card with three sub-blocks side-by-side (`md:grid-cols-3`):

| Block | Value | Subtitle |
|---|---|---|
| VaR 95% (daily) | `metrics.var95Pct.toFixed(2)%` | "Historical · 5th percentile" |
| CVaR 95% (daily) | `metrics.cvar95Pct?.toFixed(2)% ?? 'N/A'` | "Expected shortfall · mean of worst 5%" |
| Leverage | `metrics.leverageRatio.toFixed(2)×` | `Gross / Equity · Gross $X` |

If `cvar95Pct == null`, show "N/A — need ≥20 daily returns" (same pattern as VaR).

**Acceptance:** Both VaR and CVaR render; the relationship VaR ≤ CVaR holds (sanity check).

## T1.6 — Wire CVaR + Sortino tile thresholds

**File:** `frontend/src/pages/RiskPage.tsx`

- CVaR card tone: `negative` if > 3%, `warning` if > 2%, else `neutral`.
- Sortino tile tone: `positive` if ≥ 1.5, `neutral` if ≥ 0.5, `negative` if < 0.

**Acceptance:** Tile colors match documented thresholds.

## T1 deliverables checklist

- [ ] `riskMetrics.ts`: `netExposure`, `longExposure`, `shortExposure`, `*Pct` versions, `cvar95Pct`, `sortinoRatio`, `currentDrawdownPct`, `daysInDrawdown`, `sectorExposureLS` all in `RiskMetrics`.
- [ ] `RiskPage.tsx`: 8-tile row, tail-risk card, long/short grouped bar.
- [ ] `PortfolioDetailPage.tsx`: long/short subtotals, Weight/Days Held/% Gross columns, concentration footer.
- [ ] Manual test: a portfolio with 2 longs and 1 short renders correctly; net exposure is non-zero; sector bar shows separate green/red bars.
- [ ] No new dependencies; no new schema columns.

---

# Tier 2 — Snapshot writer + L/S time series

The deeper problem from the previous conversation: **time is captured as one-shot stamps but never persisted as a time series**. Tier 2 makes `daily_snapshots` real, persistent, and L/S-aware, and adds the canonical L/S exposure chart.

## T2.1 — Migration: extend `daily_snapshots` with L/S columns + per-sector/per-position JSONB

**New file:** `supabase/migrations/006_ls_snapshots.sql`

```sql
-- Adds L/S decomposition to daily_snapshots so we can plot
-- long/short/net/gross over time without replaying trades in JS.

ALTER TABLE daily_snapshots
    ADD COLUMN IF NOT EXISTS long_value      NUMERIC(18,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS short_value     NUMERIC(18,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS net_value       NUMERIC(18,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS long_pct        NUMERIC(10,4),  -- % of equity
    ADD COLUMN IF NOT EXISTS short_pct       NUMERIC(10,4),
    ADD COLUMN IF NOT EXISTS net_pct         NUMERIC(10,4),
    ADD COLUMN IF NOT EXISTS gross_pct       NUMERIC(10,4),
    ADD COLUMN IF NOT EXISTS sector_jsonb    JSONB,          -- {tech: {long, short, net}, ...}
    ADD COLUMN IF NOT EXISTS position_jsonb  JSONB;          -- {AAPL: {qty, mv, sector}, ...}
```

**Backfill strategy (decide on implementation):** for existing rows, leave new columns at their defaults. New snapshots will populate them. Optionally, a one-time backfill migration that replays `trades` against the stored `daily_snapshots` to populate `long_value/short_value/net_value` for historical days — but this is best-effort and can be deferred. Decide during implementation: backfill or skip?

**Acceptance:** Migration runs clean on a Supabase project that already has migration 005 applied. The Supabase JS types regenerate to include the new columns (see T2.5).

## T2.2 — Edge function: `compute-snapshots` (the writer that actually runs)

**New directory:** `supabase/functions/compute-snapshots/index.ts`

**Behavior:**

- HTTP endpoint `POST /functions/v1/compute-snapshots` that:
  - Accepts optional `?portfolio_id=...` and optional `?date=YYYY-MM-DD` query params.
  - If no date, defaults to today (UTC).
  - If no portfolio, iterates all portfolios.

- For each `(portfolio, date)`:
  1. Replay all `trades` for that portfolio **strictly before `date+1`**, in `trade_timestamp` order, to derive the per-ticker signed qty and avg_price at end-of-day.
  2. Look up `current_price` for each ticker from `instrument_prices` (table populated by the Python scheduler) for that date — fall back to the last-known price with a `last_updated` check; if the latest price is more than 7 days old, mark the row with `stale_prices = true` (no column; we just exclude it from returns).
  3. Compute:
     - `equity = current_capital + Σ signed(qty × price)`
     - `exposure = Σ |signed(qty × price)|` (existing column — preserve)
     - `long_value = Σ max(0, signed(qty × price))`
     - `short_value = Σ min(0, signed(qty × price))` (negative)
     - `net_value = long_value + short_value`
     - `*_pct` = the value divided by equity
     - `sector_jsonb` = aggregate by sector (signed)
     - `position_jsonb` = per-ticker {qty, mv, sector}
     - `daily_return` = `(equity_today - equity_yesterday) / equity_yesterday` (or null for first snapshot)
  4. Upsert into `daily_snapshots` on `(portfolio_id, snapshot_date)`.
  5. On the first snapshot ever for a portfolio, accept `daily_return = 0` (don't divide by zero on prior equity = null).

- Auth: same pattern as `market-data` and `ai-service` — accept either a user JWT or the `INTERNAL_API_KEY` header.

**Why an Edge Function and not a Supabase scheduled function or pg_cron:**
- The project already deploys Edge Functions via `supabase functions deploy`.
- It keeps the replay logic in TypeScript (matches `db.ts` `buildPositionHistory` style on the frontend).
- Avoids requiring pg_cron which may not be enabled on the free plan.

**Acceptance:** Calling `POST /compute-snapshots?portfolio_id=...` creates/updates a `daily_snapshots` row for today with all the new L/S columns populated. Calling it twice in one day is idempotent (upsert).

## T2.3 — Wire the snapshot writer to actually run

**File:** `frontend/src/services/db.ts` (or new `frontend/src/services/snapshots.ts`)

Three triggers (any of which should call the edge function — pick the cheapest one to ship):

1. **Lazy trigger** (ships immediately, no infra needed): after a successful `executeTrade`, the frontend `await`s a fire-and-forget `triggerSnapshotRefresh(portfolioId)`. The edge function runs the replay; the user sees the new row on next page load.
2. **Manual "Recompute" button** on the Risk page (debug-friendly, helps verify).
3. **External cron** (deferred — Tier 3): the Python `scheduler.py` already runs every 5 min, add a daily 23:55 UTC tick that calls `compute-snapshots` for all portfolios. *Out of scope for Tier 2 — note it as a follow-up.*

For Tier 2, ship **(1) + (2)**. (1) is the production path; (2) is the ops hatch.

**Acceptance:** Execute any trade → within ~5 seconds a new `daily_snapshots` row appears (the edge function may take 1–2s to cold-start; show a "Snapshot pending…" indicator on the Risk page while waiting). Re-loading the Risk page after a trade shows non-empty charts.

## T2.4 — Long/Short/Net/Gross stacked area chart on the Risk page

**File:** `frontend/src/pages/RiskPage.tsx`

**New card**, inserted between the new tiles (T1.2) and the existing underwater chart. This is the canonical L/S PM visual.

**Data source:** fetch all `daily_snapshots` for the portfolio (no limit, or limit 730 = 2 years). Plot:
- Stacked area: long_value (green, top) + short_value (red, negative axis, below zero)
- Two lines on top: `net_value` (blue) and `gross_value` (purple)
- Y axis: $ amount (not %) — gives a sense of book size changes over time
- X axis: date
- Tooltip: show all four values for the hovered day

If `snapshots.length < 2` and the user has at least one trade but no snapshot, show a "Recompute snapshots" button (calls the edge function). If `snapshots.length === 0` and there are no trades, show "No trade history yet".

**Acceptance:** A portfolio that grew from 100% long to 100% short and back to 50/50 over a quarter shows that story visually. Net line crosses zero at the right point.

## T2.5 — Regenerate Supabase TS types

**File:** `frontend/src/types/database.types.ts`

Run the Supabase type generator (or manually edit — both the `Row` interface for `daily_snapshots` and the `Update` type need the new optional fields). The plan author should run:

```bash
npx supabase gen types typescript --project-id <id> > frontend/src/types/database.types.ts
```

If running the CLI is not available, the fallback is to manually add the same fields to the `daily_snapshots.Row` and `Update` types in `database.types.ts` (matches migration 006).

**Acceptance:** `createSnapshot` call in `db.ts` compiles with the new `long_value`, `short_value`, `sector_jsonb`, `position_jsonb` fields.

## T2.6 — Pass the L/S data through `riskMetrics.ts`

**File:** `frontend/src/services/riskMetrics.ts`

Extend `RiskMetrics` (additive — does not break Tier 1) with optional fields populated from the **time series** of snapshots (not just "now"):

```ts
peakEquity: number;                    // max equity in the window
peakEquityDate: string;                // when peak occurred
recoveryDays: number | null;           // days from peak to current equity, null if not recovered
worstDayReturnPct: number | null;      // single-worst day
worstDayDate: string | null;
```

These are cheap to compute (one pass over snapshots) and let us add small "Worst day: −4.2% on 2024-08-05" annotations to the underwater chart later.

**Acceptance:** All new fields populated when `snapshots.length > 0`, else null/0.

## T2.7 — Limit-breach traffic lights (the cheap-and-impressive finish)

**File:** `frontend/src/pages/RiskPage.tsx`, new card at the very top of the page (above the 8-tile row).

A horizontal strip of 4–6 traffic lights, each computing a one-liner against the current metrics:

| Light | Check | Color |
|---|---|---|
| **Net exposure** | `Math.abs(netExposurePct) < 30` | green, else yellow (>50 → red) |
| **Gross exposure** | `grossExposurePct < 180` | green, else yellow (>220 → red) |
| **Single-name** | `largestSinglePct < 10` | green, else yellow (>15 → red) |
| **Concentration** | `1 / (herfindahlLong + herfindahlShort) > 20` (eff. N) | green, else yellow (<10 → red) |
| **Drawdown** | `Math.abs(currentDrawdownPct) < 5` | green, else yellow (>10 → red) |
| **VaR** | `var95Pct < 2` | green, else yellow (>3 → red) |

Each light is a small inline-flex with a colored dot + label + value. Pure CSS, no new component needed.

**Acceptance:** A portfolio with `net = 45%` shows the Net light yellow. Hovering shows the threshold. Limits are constants in the file (clearly marked `// TODO: move to user-configurable limits`).

## T2 deliverables checklist

- [ ] `supabase/migrations/006_ls_snapshots.sql` applied.
- [ ] `supabase/functions/compute-snapshots/index.ts` deployed and callable.
- [ ] `frontend/src/types/database.types.ts` regenerated.
- [ ] `db.ts` `createSnapshot` updated to write the new fields, OR a new `writeSnapshot` helper that the edge function calls via service-role (preferred — keep edge function as the only writer).
- [ ] `RiskPage.tsx` gets the L/S stacked area chart.
- [ ] `RiskPage.tsx` gets the limit-breach traffic lights at the top.
- [ ] `executeTrade` triggers a snapshot refresh.
- [ ] Manual test: trade → snapshot row appears with correct L/S columns → Risk page renders all charts non-empty.

---

# Open questions to resolve before implementation

1. **Backfill strategy for `daily_snapshots`.** T2.1 leaves existing rows with default 0s. Should we (a) skip backfill (cleanest, but Risk page is empty until tomorrow), (b) write a one-time backfill SQL function that replays trades per-day and populates the new columns for historical rows, or (c) compute historical L/S entirely from the trade log on the frontend, ignoring `daily_snapshots` for pre-migration dates? **Recommendation: (a)** — the app is small, no one has real history yet, and forward-filling from `trade_timestamp` onwards is the simplest.

2. **Snapshot timing.** Should `executeTrade` synchronously wait for the snapshot, or fire-and-forget? **Recommendation: fire-and-forget** with an optimistic `equity` update on the client (current behavior is fine). The Risk page should poll or invalidate on next mount.

3. **Sector data source.** Tier 1 splits sectors using `position.sector` (DB column, often `null`) falling back to `livePrices[p.ticker].sector` (Finnhub). When a sector is `"Unknown"`, the bar chart will show a row. **Recommendation:** filter `"Unknown"` out of the bar chart but keep it in the table with a footnote (matches existing behavior at L478–L483).

4. **Should the limit-breach thresholds be hard-coded in T2.7, or pulled from a per-portfolio settings table?** **Recommendation: hard-code with TODO** for Tier 2; a `portfolio_risk_limits` table is a Tier 3+ concern.

5. **Where should the `compute-snapshots` edge function live — Supabase Edge Function (Deno) or a sibling of the existing `bloomberg-service` FastAPI?** **Recommendation: Supabase Edge Function** — it has direct DB access via service role, no public ingress problem, and matches the pattern of the other two functions.

6. **Tier 1 vs Tier 2 ordering.** T1 is shippable in 1–2 PRs with no infra. T2 depends on T1 being in (so the Risk page is wired up before the time series starts populating). **Recommendation: T1 PR first, T2 PR second.** Don't try to ship both in one PR.

---

# Suggested PR sequence

1. **PR 1 (Tier 1):** `riskMetrics.ts` + `RiskPage.tsx` + `PortfolioDetailPage.tsx` edits. ~300 lines of changes. No schema, no infra. Demo-ready in 1 day.
2. **PR 2 (Tier 2.1–2.2):** Migration `006_ls_snapshots.sql` + Edge function `compute-snapshots`. Deploy the function. ~200 lines. No frontend changes yet.
3. **PR 3 (Tier 2.3–2.7):** Wire snapshot writer to `executeTrade`, add the L/S area chart, traffic lights, regenerate types. ~400 lines. Demo-ready with real history.
4. **PR 4 (post-Tier 2):** Python `scheduler.py` daily tick that calls `compute-snapshots` for all portfolios. ~30 lines. Optional.

Total scope across the 3 active PRs: ~900 lines of TS/SQL, zero new third-party deps.

---

# What this does NOT include (deferred to Tier 3+)

- β per ticker (needs `price_history` table; see prior conversation).
- CVaR/Sortino from a multi-year return series (T2 will use whatever snapshots exist, so it improves automatically as history accumulates).
- Position correlation heatmap (needs `price_history`).
- Scenario analysis.
- Days-to-liquidate (needs Bloomberg `TURNOVER`).
- P&L attribution.
- Borrow cost / short availability.
- Per-portfolio configurable risk limits (T2.7 uses constants).
- Reconciling `trade_timestamp` vs `executed_at` (separate cleanup; not strictly a Tier 2 concern).
