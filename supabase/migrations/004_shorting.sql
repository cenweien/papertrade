-- 004_shorting.sql
-- Adds shorting (SHORT/COVER) support to the trades + positions tables.
--
-- Netting simplification: positions.qty is a single signed value per
-- (portfolio, ticker). A long and a short in the same ticker net into
-- one row. The trade's `direction` column records what the user did,
-- so the history is auditable even though the position row collapses.

ALTER TABLE trades
    ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'LONG'
        CHECK (direction IN ('LONG', 'SHORT'));

CREATE INDEX IF NOT EXISTS idx_trades_direction ON trades(portfolio_id, direction);

-- Ensure avg_price stays non-negative. Entry price is always positive
-- regardless of direction; the sign lives on qty.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'positions_avg_price_nonneg'
    ) THEN
        ALTER TABLE positions
            ADD CONSTRAINT positions_avg_price_nonneg CHECK (avg_price >= 0);
    END IF;
END
$$;
