-- c23-02: Change hr_positions.status from the hr_position_status enum to text.
-- The four legacy values are preserved verbatim (USING status::text).
-- After this migration tenants can assign any status name that exists in their
-- hr_position_statuses lookup table, enabling custom statuses without a deploy.
--
-- OPERATOR ACTION REQUIRED after this migration applies:
--
--     VACUUM ANALYZE hr_positions;
--
-- ALTER COLUMN ... TYPE REWRITES THE TABLE. A rewrite discards the table's
-- statistics AND empties its visibility map, so until it is vacuumed and
-- analysed the planner both mis-estimates row counts and refuses index-only
-- scans. One list in this codebase went from 53 to 201,875 buffers on exactly
-- this, and only VACUUM (not ANALYZE alone) restored it.
--
-- The rewrite takes ACCESS EXCLUSIVE on hr_positions for its duration. The
-- lock_timeout below makes it fail fast rather than queue and block every
-- reader behind it; re-run at a quieter moment if it times out.
--
-- The hr_position_status enum TYPE is deliberately left in place: it is the
-- rollback path for this migration, and dropping it would put the Drizzle
-- snapshot out of step with the database.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_positions"
  ALTER COLUMN "status" TYPE text USING "status"::text;
