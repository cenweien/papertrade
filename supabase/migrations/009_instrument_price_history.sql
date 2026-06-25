-- 009_instrument_price_history.sql
-- Daily close-price history per ticker, used by the Risk page to compute
-- Sharpe / VaR / CVaR / Sortino from market data rather than the
-- portfolio's own trade-replay snapshots.
--
-- Rows are written by the `market-data/historical-series` edge function
-- (on-demand backfill from Bloomberg) and by the bloomberg-service
-- scheduler.py tick (background pre-fill for tickers_in_use()).
--
-- The frontend asks for a [start..end] window and the edge function
-- only fetches the missing sub-range from Bloomberg, so this table is
-- a write-through cache, not a copy of Bloomberg's full history.
--
-- Window policy: rows older than 5 years are pruned on every write so
-- the table stays small (the Risk page asks for at most ~1y).

CREATE TABLE IF NOT EXISTS instrument_price_history (
    ticker         TEXT        NOT NULL,
    trade_date     DATE        NOT NULL,
    close          NUMERIC(18,6) NOT NULL,
    last_updated   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ticker, trade_date)
);

-- Per-ticker lookups (the dominant query is "give me ticker X from D1..D2").
CREATE INDEX IF NOT EXISTS idx_instrument_price_history_ticker_date
    ON instrument_price_history (ticker, trade_date DESC);

-- Last-updated index for the pruning job (drop rows older than 5y whose
-- trade_date is more than 5y ago).
CREATE INDEX IF NOT EXISTS idx_instrument_price_history_trade_date
    ON instrument_price_history (trade_date);

ALTER TABLE instrument_price_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read instrument price history" ON instrument_price_history;
CREATE POLICY "Public read instrument price history"
    ON instrument_price_history FOR SELECT
    USING (true);

-- Writes go through the service-role client (supabaseAdmin) inside edge
-- functions and the Python scheduler. No public INSERT/UPDATE/DELETE.
DROP POLICY IF EXISTS "Service write instrument price history" ON instrument_price_history;