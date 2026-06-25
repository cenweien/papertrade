-- 008a_snapshot_update_policy.sql
-- Adds the missing UPDATE RLS policy on `daily_snapshots` so the
-- frontend can upsert snapshot rows for the user's own portfolios.
-- The original schema (001_initial_schema.sql:178) had only INSERT,
-- not UPDATE, which means the upsert path failed silently for the
-- browser session.
--
-- Auth model (matches the existing INSERT policy):
--   - A user can UPDATE a snapshot iff the portfolio belongs to
--     auth.uid() (the authenticated user). Cross-user updates are
--     rejected at the RLS layer.
--
-- No backfill needed; this is a policy change only.
--
-- Idempotent: the CLI runs both 008_*.sql files alphabetically when
-- iterating all migrations, so this file may run before
-- 008_snapshot_update_delete_policy.sql (which also creates a
-- "Users can update own snapshots" policy). DROP IF EXISTS keeps the
-- second run from failing with 42710.

DROP POLICY IF EXISTS "Users can update own snapshots" ON daily_snapshots;
CREATE POLICY "Users can update own snapshots"
    ON daily_snapshots FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM portfolios
            WHERE portfolios.id = daily_snapshots.portfolio_id
            AND portfolios.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM portfolios
            WHERE portfolios.id = daily_snapshots.portfolio_id
            AND portfolios.user_id = auth.uid()
        )
    );
