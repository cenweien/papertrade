# Risk Management Analytics Page — Plan

## Goal
Build a new dedicated **Risk Analytics** page in the existing React/TS frontend that displays the six risk metrics the user listed, sourced from real portfolio/trade/position data already in Supabase. This is "basic" analytics — pure derivations over existing tables — no new DB schema, no new data sources.

## Existing code we'll reuse / extend

- **`frontend/src/services/db.ts:481-525`** — already has `computePerformanceMetrics()` which computes equity, totalReturn, sharpeRatio (annualized), and maxDrawdown from `daily_snapshots`. Win rate is currently hardcoded to 0 and returns/exposure are exposed.
- **`frontend/src/services/db.ts:144-158`** — `getTrades(portfolioId)` already returns `Trade[]` with `pnl` (nullable) for win-rate calculation.
- **`frontend/src/services/db.ts:420-433`** — `getPositions()` returns signed-qty positions with `sector`.
- **`frontend/src/types/database.types.ts:65-74`** — `positions.sector: string | null`. Sectors are optional and may be null for tickers not in the `instrument_prices` cache — must handle gracefully.
- **`frontend/src/services/marketData.ts`** — `useLivePrices()` hook (already used by `PortfolioDetailPage.tsx:51-54`) for live prices when computing exposure & sector weights.
- **`frontend/src/components/Layout.tsx:22-27`** — nav array; add a "Risk" entry. Use `ShieldAlert` (lucide-react, already a dep) as icon.
- **`frontend/src/App.tsx:50-60`** — routes table; add `/risk` and `/risk/:portfolioId` paths.
- **Tailwind utility classes** already in use: `card`, `btn-primary`, `btn-secondary`, `btn-ghost`, `input`, `label`, `badge`, `badge-success`, `badge-danger`, `text-green-600`, `text-red-600`, `text-slate-*`. No new CSS needed.
- **Charts**: `recharts` is already a dep (`package.json:22`). Use it for a drawdown-underwater chart and a sector-exposure pie.

## Metric definitions (locked — match what the user wrote)

| # | Metric | Formula | Inputs | Edge cases |
|---|---|---|---|---|
| 1 | **Return %** | `(equity − initial_capital) / initial_capital × 100` | `portfolio.initial_capital`, live equity | Already implemented in `db.ts:491` |
| 2 | **Sharpe Ratio** | `(meanReturn − riskFreeRate) / stdDev(returns)` annualized | `daily_snapshots.daily_return[]` | Annualize via `× 252` for mean, `× √252` for stddev; rfr = 5% (hardcoded constant `RISK_FREE_RATE = 0.05`, documented in code). Show "N/A" if <2 snapshots. Already partially implemented at `db.ts:497-502` |
| 3 | **Win Rate** | `winningTrades / totalClosedTrades × 100` | `trades` with `status='CLOSED'` and `pnl` non-null | "Winning" = `pnl > 0`. If zero closed trades → "N/A". Currently a placeholder at `db.ts:514` |
| 4 | **Max Drawdown** | largest peak-to-trough % decline in equity | `daily_snapshots.equity[]` (with `initial_capital` as seed peak) | Return as positive percentage. Already implemented at `db.ts:505-511` |
| 5 | **VaR (95%)** | loss threshold at 95% confidence | `daily_snapshots.daily_return[]` | **Historical method**: 5th percentile of the return distribution (1.65σ is parametric — we go historical since returns aren't normal). If <20 daily returns → "N/A (insufficient data)". Returned as a positive percentage (the loss magnitude). |
| 6 | **Sector Exposure** | `Σ(position_value_in_sector) / equity × 100` per sector | `positions[]` with `sector` (fall back to `instrument_prices.sector` via cached quotes, else bucket as "Unknown") | Group positions by sector; show a donut/pie chart + a table sorted desc by %. "Unknown" bucket must be disclosed. |
| 7 | **Leverage Ratio** | `grossExposure / equity` | `Σ |position.qty × price|` / `equity` | Use **absolute** exposure (longs + shorts, no netting) — standard definition. Warn with red badge if > 2.0. If equity ≤ 0 → "N/A". |

## File changes

### 1. `frontend/src/services/riskMetrics.ts` (NEW)

Pure functions, fully unit-testable, no React/Supabase coupling. Replaces/extends `computePerformanceMetrics`.

```ts
export const RISK_FREE_RATE = 0.05; // annualized, ~5y US Treasury; configurable later

export interface RiskMetrics {
  returnPct: number;
  sharpeRatio: number | null;
  winRate: number | null;
  maxDrawdownPct: number;
  var95Pct: number | null;
  leverageRatio: number | null;
  // by-sector breakdown used by the Sector Exposure panel
  sectorExposure: { sector: string; pct: number; valueUsd: number }[];
  // supporting context for display
  totalTrades: number;
  closedTrades: number;
  dailyReturnCount: number;
  equity: number;
  grossExposure: number;
}

export function computeRiskMetrics(input: {
  portfolio: Portfolio;
  positions: Position[];
  trades: Trade[];
  snapshots: DailySnapshot[];
  livePrices: Record<string, { current_price: number; sector?: string | null }>;
}): RiskMetrics { ... }
```

Conventions for `null` vs `0`:
- `null` = cannot compute (insufficient data, zero trades, etc.) → UI shows "N/A"
- `0` = computed and is genuinely zero

### 2. `frontend/src/pages/RiskPage.tsx` (NEW)

Single portfolio-scoped analytics view.

Layout (top-to-bottom, max-w-7xl, p-8):
1. **Header** — title "Risk Analytics", portfolio selector dropdown (reuses `getPortfolios()`) defaulting to the first non-archived portfolio.
2. **Six metric cards** in a responsive grid (`grid-cols-1 md:grid-cols-2 lg:grid-cols-3`):
   - Return % (green/red)
   - Sharpe Ratio (with "(annualized)" subtitle)
   - Win Rate (with "X / Y trades" subtitle)
   - Max Drawdown (red, with "since inception" subtitle)
   - VaR 95% (red, with "daily historical" subtitle)
   - Leverage Ratio (yellow if >1.5, red if >2.0)
3. **Underwater chart** (recharts `AreaChart`, gradient fill red) — equity drawdown % over time, X = `snapshot_date`. Hidden if <2 snapshots.
4. **Sector Exposure panel** — recharts `PieChart` (donut, `innerRadius`) + adjacent sorted table with sector / $ value / % equity.
5. **Returns distribution mini-panel** — recharts `BarChart` of daily returns histogram, with a vertical reference line at the VaR threshold. Helps interpret the VaR number.

Loading state (`<div className="p-8 text-slate-600">Loading…</div>`), empty state ("No data yet — execute trades and let daily snapshots populate"), error state, all matching the pattern in `PortfolioDetailPage.tsx:159-172`.

### 3. `frontend/src/App.tsx` — add routes

```tsx
<Route path="/risk" element={<RiskPage />} />
<Route path="/risk/:portfolioId" element={<RiskPage />} />
```

### 4. `frontend/src/components/Layout.tsx` — add nav entry

Add `{ path: '/risk', icon: ShieldAlert, label: 'Risk Analytics' }` to `navItems` at `Layout.tsx:22-27`. Update the `ShieldAlert` import on `Layout.tsx:5`.

### 5. `frontend/src/services/db.ts` — minor cleanup (optional)

`computePerformanceMetrics` becomes redundant once `riskMetrics.ts` ships. Either:
- **(a)** Delete `computePerformanceMetrics` and update its single caller in `PortfolioDetailPage.tsx:11` to use the new `computeRiskMetrics`, OR
- **(b)** Leave it in place; the new file is additive. **(Default — choose (b) to keep the diff minimal and avoid breaking existing callers/tests.)**

## Data flow

```
RiskPage mount
  → Promise.all([getPortfolios(), defaultPortfolioId])
  → useLivePrices(portfolioTickers, 60_000) for live prices
  → Promise.all([getPortfolio(id), getPositions(id), getTrades(id, 500), getSnapshots(id, 365)])
  → computeRiskMetrics(...)
  → render
```

Live prices from `useLivePrices` feed into both the equity calculation AND the sector fallback (so an `Unknown` bucket shrinks as the price cache warms). When live prices are unavailable we fall back to `position.current_price ?? position.avg_price`, matching `PortfolioDetailPage.tsx:177`.

## Validation / "insufficient data" rules

| Metric | Minimum required | UI behavior |
|---|---|---|
| Sharpe | ≥2 daily returns | else "N/A (need ≥2 snapshots)" |
| VaR 95% | ≥20 daily returns | else "N/A (need ≥20 daily returns)" |
| Win rate | ≥1 closed trade with non-null `pnl` | else "N/A (no closed trades)" |
| Max drawdown | ≥1 snapshot OR initial capital only | always computable; show "0.00%" if flat |
| Sector exposure | ≥1 position | else "No open positions" |
| Leverage | `equity > 0` | else "N/A (negative equity)" |

## Testing

No test framework is currently configured in `frontend/package.json` (no `vitest`/`jest` dep). To stay consistent with the existing codebase, **no tests added**. Manual verification:
1. `npm run dev`, navigate to `/risk` for each portfolio.
2. Visual: numbers match the values shown on `/portfolio/:id` for the same portfolio.
3. Visual: cards show "N/A" with the explanatory tooltip text when data is sparse.

## Out of scope (explicit non-goals)

- No new Supabase migrations. All inputs already exist.
- No CVaR / Expected Shortfall (only VaR 95% requested).
- No parametric VaR or Monte Carlo — historical method only.
- No real-time alert thresholds (e.g., email if drawdown > X%) — that's a future feature.
- No historical risk-free rate series — single annualized constant.
- No multi-portfolio aggregation on this page — selector is one-at-a-time. Aggregation could be a future Comparison-style page.

## Implementation order

1. Write `services/riskMetrics.ts` with all 7 metric functions + types.
2. Write `pages/RiskPage.tsx` consuming it, with full UI + charts.
3. Wire route in `App.tsx`.
4. Add nav entry in `Layout.tsx`.
5. `npm run lint` — must pass (project uses ESLint with `--max-warnings 0`, `package.json:9`).
6. `npm run build` — must succeed (`tsc -b && vite build`, `package.json:8`).
