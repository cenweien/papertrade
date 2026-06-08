-- PaperTrade Database Schema
-- Run this in Supabase SQL Editor: https://app.supabase.com/project/_/sql
-- This creates all tables, indexes, and Row Level Security policies

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABLES
-- ============================================================

-- Portfolios
CREATE TABLE IF NOT EXISTS portfolios (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    initial_capital NUMERIC(18,2) NOT NULL DEFAULT 100000,
    current_capital NUMERIC(18,2) NOT NULL DEFAULT 100000,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Trades
CREATE TABLE IF NOT EXISTS trades (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    portfolio_id UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    ticker TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    qty NUMERIC(18,4) NOT NULL CHECK (qty > 0),
    price NUMERIC(18,4) NOT NULL CHECK (price > 0),
    total_value NUMERIC(18,2) GENERATED ALWAYS AS (qty * price) STORED,
    trade_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stop_price NUMERIC(18,4),
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
    pnl NUMERIC(18,2),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Positions (current holdings)
CREATE TABLE IF NOT EXISTS positions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    portfolio_id UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    ticker TEXT NOT NULL,
    qty NUMERIC(18,4) NOT NULL DEFAULT 0,
    avg_price NUMERIC(18,4) NOT NULL DEFAULT 0,
    current_price NUMERIC(18,4),
    sector TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(portfolio_id, ticker)
);

-- Daily snapshots for performance tracking
CREATE TABLE IF NOT EXISTS daily_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    portfolio_id UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    equity NUMERIC(18,2) NOT NULL,
    exposure NUMERIC(18,2) NOT NULL DEFAULT 0,
    cash NUMERIC(18,2) NOT NULL,
    daily_return NUMERIC(10,4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(portfolio_id, snapshot_date)
);

-- AI chat history
CREATE TABLE IF NOT EXISTS ai_chat_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    portfolio_id UUID REFERENCES portfolios(id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    parsed_command JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_portfolios_user ON portfolios(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_portfolio ON trades(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(trade_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_ticker ON trades(ticker);
CREATE INDEX IF NOT EXISTS idx_positions_portfolio ON positions(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_portfolio_date ON daily_snapshots(portfolio_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_chat_history_user ON ai_chat_history(user_id, created_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================

ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_chat_history ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to make migration idempotent
DROP POLICY IF EXISTS "Users can manage own portfolios" ON portfolios;
DROP POLICY IF EXISTS "Users can view own trades" ON trades;
DROP POLICY IF EXISTS "Users can insert own trades" ON trades;
DROP POLICY IF EXISTS "Users can view own positions" ON positions;
DROP POLICY IF EXISTS "Users can manage own positions" ON positions;
DROP POLICY IF EXISTS "Users can view own snapshots" ON daily_snapshots;
DROP POLICY IF EXISTS "Users can insert own snapshots" ON daily_snapshots;
DROP POLICY IF EXISTS "Users can manage own chat history" ON ai_chat_history;

-- Portfolios: users can only see/modify their own
CREATE POLICY "Users can manage own portfolios"
    ON portfolios FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Trades: users can see/insert trades for their own portfolios
CREATE POLICY "Users can view own trades"
    ON trades FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM portfolios
            WHERE portfolios.id = trades.portfolio_id
            AND portfolios.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can insert own trades"
    ON trades FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM portfolios
            WHERE portfolios.id = trades.portfolio_id
            AND portfolios.user_id = auth.uid()
        )
    );

-- Positions: users can manage positions for their own portfolios
CREATE POLICY "Users can view own positions"
    ON positions FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM portfolios
            WHERE portfolios.id = positions.portfolio_id
            AND portfolios.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can manage own positions"
    ON positions FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM portfolios
            WHERE portfolios.id = positions.portfolio_id
            AND portfolios.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM portfolios
            WHERE portfolios.id = positions.portfolio_id
            AND portfolios.user_id = auth.uid()
        )
    );

-- Snapshots: users can read/insert snapshots for their portfolios
CREATE POLICY "Users can view own snapshots"
    ON daily_snapshots FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM portfolios
            WHERE portfolios.id = daily_snapshots.portfolio_id
            AND portfolios.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can insert own snapshots"
    ON daily_snapshots FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM portfolios
            WHERE portfolios.id = daily_snapshots.portfolio_id
            AND portfolios.user_id = auth.uid()
        )
    );

-- AI chat: users can manage their own
CREATE POLICY "Users can manage own chat history"
    ON ai_chat_history FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS portfolios_updated_at ON portfolios;
CREATE TRIGGER portfolios_updated_at
    BEFORE UPDATE ON portfolios
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS positions_updated_at ON positions;
CREATE TRIGGER positions_updated_at
    BEFORE UPDATE ON positions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- DONE
-- ============================================================
-- You should see: "Success. No rows returned"
-- This means all tables, RLS policies, and triggers are set up.
-- 
-- Next steps:
-- 1. Get your project URL and anon key from Supabase Settings → API
-- 2. Create a .env file in the frontend folder with these values
-- 3. Run: cd frontend && npm install && npm run dev