-- 010_snapshot_delete_policy.sql
-- Adds the missing DELETE RLS policy on `daily_snapshots` so the
-- frontend can remove a same-day snapshot row when needed. The
-- original schema (001_initial_schema.sql:178) only granted SELECT
-- and INSERT, so any attempt to delete an old snapshot was rejected
-- at the RLS layer.
--
-- Auth model (matches the existing INSERT policy):
--   - A user can DELETE a snapshot iff the portfolio belongs to
--     auth.uid() (the authenticated user). Cross-user deletes are
--     rejected at the RLS layer.
--
-- Idempotent: DROP IF EXISTS keeps re-runs safe.

DROP POLICY IF EXISTS "Users can delete own snapshots" ON daily_snapshots;
CREATE POLICY "Users can delete own snapshots"
    ON daily_snapshots FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM portfolios
            WHERE portfolios.id = daily_snapshots.portfolio_id
            AND portfolios.user_id = auth.uid()
        )
    );
