-- 005_instrument_universe.sql
-- Renames stock_prices -> instrument_prices and adds multi-asset columns
-- (asset_class, bbg_symbol, contract_size, currency, expiry_date) so the
-- cache can hold US equity, ETF, futures, FX, HK equity, etc. in one
-- table. User-facing tickers (AAPL, ES1, EURUSD, 00700) stay as the
-- primary key text — the BBG symbol is resolved at quote time by the
-- bloomberg-service.

-- Idempotent rename: if 005 is re-run (e.g. SQL Editor replay or partial
-- deploy recovery), the second `RENAME` would otherwise fail with
-- `relation "stock_prices" does not exist` and abort the rest of the
-- migration.
--
-- We use a tagged dollar-quote (`$mig005$`) rather than bare `$$`
-- here. Some SQL splitter tools (and the Supabase CLI's statement
-- splitter in particular) can get confused by a `DO $$ ... $$;`
-- block immediately followed by other `$$ ... $$` PL/pgSQL function
-- bodies further down in the same file — they end up trying to parse
-- the whole rest of the file as the DO block. Tagged delimiters make
-- the boundaries unambiguous.
DO $mig005$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'stock_prices') THEN
    ALTER TABLE stock_prices RENAME TO instrument_prices;
  END IF;
END $mig005$;

ALTER TABLE instrument_prices
    ADD COLUMN IF NOT EXISTS asset_class TEXT NOT NULL DEFAULT 'EQUITY'
        CHECK (asset_class IN ('EQUITY', 'ETF', 'FUTURE', 'FX', 'BOND', 'OPTION', 'INDEX', 'CRYPTO', 'MUTUAL_FUND')),
    ADD COLUMN IF NOT EXISTS bbg_symbol TEXT,
    ADD COLUMN IF NOT EXISTS contract_size NUMERIC(18,6),
    ADD COLUMN IF NOT EXISTS currency TEXT,
    ADD COLUMN IF NOT EXISTS expiry_date DATE;

UPDATE instrument_prices
   SET contract_size = 1
 WHERE contract_size IS NULL;

CREATE INDEX IF NOT EXISTS idx_instrument_prices_asset_class ON instrument_prices(asset_class) WHERE asset_class IS NOT NULL;
-- Drop the old `last_updated` index from migration 002. PostgreSQL does
-- NOT auto-rename indexes when their table is renamed, so after the
-- `stock_prices` -> `instrument_prices` rename above we would otherwise
-- have two identical indexes on `last_updated DESC`, doubling the write
-- cost of every market-data upsert.
DROP INDEX IF EXISTS idx_stock_prices_updated;
CREATE INDEX IF NOT EXISTS idx_instrument_prices_updated ON instrument_prices(last_updated DESC);

-- Drop the old sector-specific index (it was on the old table name)
DROP INDEX IF EXISTS idx_stock_prices_sector;

-- Recreate the RLS policy (the rename doesn't move policies, but be
-- explicit so this migration is idempotent if applied to a fresh DB).
DROP POLICY IF EXISTS "Public read stock prices" ON instrument_prices;
DROP POLICY IF EXISTS "Public read instrument prices" ON instrument_prices;
CREATE POLICY "Public read instrument prices"
    ON instrument_prices FOR SELECT
    USING (true);

-- Refresh the helper to keep the new table name.
DROP FUNCTION IF EXISTS get_price_freshness(TEXT, INT);
CREATE OR REPLACE FUNCTION get_price_freshness(p_ticker TEXT, p_max_age_minutes INT DEFAULT 5)
RETURNS TABLE (
    is_fresh BOOLEAN,
    age_minutes NUMERIC,
    price NUMERIC
) AS $$
DECLARE
    v_last_updated TIMESTAMPTZ;
    v_price NUMERIC;
    v_age NUMERIC;
BEGIN
    SELECT last_updated, instrument_prices.current_price
    INTO v_last_updated, v_price
    FROM instrument_prices
    WHERE ticker = UPPER(p_ticker);

    IF v_last_updated IS NULL THEN
        RETURN QUERY SELECT FALSE, NULL::NUMERIC, NULL::NUMERIC;
        RETURN;
    END IF;

    v_age := EXTRACT(EPOCH FROM (NOW() - v_last_updated)) / 60.0;

    RETURN QUERY SELECT (v_age <= p_max_age_minutes), v_age, v_price;
END;
$$ LANGUAGE plpgsql STABLE;

DROP FUNCTION IF EXISTS tickers_in_use();
CREATE OR REPLACE FUNCTION tickers_in_use()
RETURNS TABLE (ticker TEXT) AS $$
    SELECT DISTINCT UPPER(p.ticker)
    FROM positions p
    JOIN portfolios pf ON pf.id = p.portfolio_id
    WHERE p.qty <> 0 AND pf.is_archived = FALSE
    ORDER BY UPPER(p.ticker);
$$ LANGUAGE sql STABLE;
