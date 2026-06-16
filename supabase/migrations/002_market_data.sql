-- PaperTrade Market Data Schema
-- Run this in Supabase SQL Editor: https://app.supabase.com/project/_/sql
-- Creates the stock_prices cache table for Finnhub market data

-- ============================================================
-- STOCK PRICES CACHE
-- ============================================================
-- Caches real-time US stock quotes from Finnhub to avoid hitting
-- rate limits (60 calls/min on free tier).
-- All positions/portfolios reference tickers by symbol; the frontend
-- joins positions.current_price with this table for live data.

CREATE TABLE IF NOT EXISTS stock_prices (
    ticker TEXT PRIMARY KEY,
    current_price NUMERIC(18,4) NOT NULL,
    previous_close NUMERIC(18,4),
    change_pct NUMERIC(10,4),
    day_high NUMERIC(18,4),
    day_low NUMERIC(18,4),
    day_open NUMERIC(18,4),
    volume BIGINT,
    company_name TEXT,
    sector TEXT,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_prices_updated ON stock_prices(last_updated DESC);
CREATE INDEX IF NOT EXISTS idx_stock_prices_sector ON stock_prices(sector) WHERE sector IS NOT NULL;

ALTER TABLE stock_prices ENABLE ROW LEVEL SECURITY;

-- Public read - stock prices are public market data
DROP POLICY IF EXISTS "Public read stock prices" ON stock_prices;
CREATE POLICY "Public read stock prices"
    ON stock_prices FOR SELECT
    USING (true);

-- Service role can write (Edge Function uses SERVICE_KEY)
-- No explicit policy needed - service_role bypasses RLS

-- ============================================================
-- HELPER: get_fresh_price
-- Returns the cached price if fresh (< 5 min), NULL otherwise.
-- Used by the market-data Edge Function to decide whether to refresh.
-- ============================================================
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
    SELECT last_updated, stock_prices.current_price
    INTO v_last_updated, v_price
    FROM stock_prices
    WHERE ticker = UPPER(p_ticker);

    IF v_last_updated IS NULL THEN
        RETURN QUERY SELECT FALSE, NULL::NUMERIC, NULL::NUMERIC;
        RETURN;
    END IF;

    v_age := EXTRACT(EPOCH FROM (NOW() - v_last_updated)) / 60.0;

    RETURN QUERY SELECT (v_age <= p_max_age_minutes), v_age, v_price;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- HELPER: tickers_in_use
-- Returns distinct tickers from all open positions across all users.
-- Used by the scheduled refresh job to know what to update.
-- ============================================================
CREATE OR REPLACE FUNCTION tickers_in_use()
RETURNS TABLE (ticker TEXT) AS $$
    SELECT DISTINCT UPPER(p.ticker)
    FROM positions p
    JOIN portfolios pf ON pf.id = p.portfolio_id
    WHERE p.qty > 0 AND pf.is_archived = FALSE
    ORDER BY UPPER(p.ticker);
$$ LANGUAGE sql STABLE;

-- ============================================================
-- DONE
-- ============================================================
-- Next steps:
-- 1. Deploy the market-data Edge Function:
--      supabase functions deploy market-data
-- 2. Set the FINNHUB_API_KEY secret in Supabase:
--      supabase secrets set FINNHUB_API_KEY=your_key
-- 3. The market-data function will auto-populate this table on first quote request.
</content>
</invoke>