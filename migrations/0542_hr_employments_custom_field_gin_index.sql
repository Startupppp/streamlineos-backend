-- 0542 — HR: GIN containment index on hr_employments.custom_field_values
--
-- Enables fast @> (containment) queries for filtering employments by custom field
-- value. Example: WHERE custom_field_values @> '{"field_key": "value"}'::jsonb
--
-- Operator class: jsonb_path_ops supports only @> but uses a smaller index than
-- the default jsonb_ops. It is the right choice when the only use-case is
-- containment filtering, which is all we need here.
--
-- Why org_id is NOT in this index:
--   GIN indexes do not support index-only scans (no visibility map for GIN
--   leaves), so the §7 rule "covering index must contain org_id for index-only
--   scans" does not apply. Leading a GIN index with org_id would require the
--   btree_gin extension, which this deployment does not install. The planner
--   will filter org_id via the existing btree idx_hr_employments_org index in a
--   BitmapAnd with the GIN result.
--
-- CONCURRENTLY note:
--   CREATE INDEX CONCURRENTLY cannot run inside a migration transaction. The
--   statement below uses plain CREATE INDEX IF NOT EXISTS (idempotent) so it
--   runs safely inside the Drizzle migration wrapper. On a large production table
--   where taking a ShareLock is unacceptable, run the equivalent CONCURRENTLY
--   statement manually outside a transaction BEFORE applying this migration:
--
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS
--       "idx_hr_employments_custom_field_values_gin"
--       ON "hr_employments"
--       USING gin ("custom_field_values" jsonb_path_ops);
--
--   The IF NOT EXISTS guard makes this migration a no-op when the index already
--   exists (matching the precedent in 0374_build_partial_indexes.sql).

SET statement_timeout = 0;
SET lock_timeout = '5s';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_employments_custom_field_values_gin"
  ON "hr_employments"
  USING gin ("custom_field_values" jsonb_path_ops);
