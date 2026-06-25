-- 006_ls_snapshots.sql
-- Adds L/S decomposition to daily_snapshots so the Risk page can
-- plot long/short/net/gross over time without replaying trades in
-- the browser on every page load.
--
-- All columns are idempotent (ADD COLUMN IF NOT EXISTS) and default
-- to 0/null so re-running the migration is safe and existing rows
-- are still readable.
--
-- No backfill: existing rows are left at the defaults. New snapshots
-- (written by the compute-snapshots Edge Function, see T2.2) will
-- populate the L/S columns. The app is small and the trade log is
-- the source of truth for historical L/S — clients can replay from
-- `trades` if they need a backfill.

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
