-- 0540 — HR: Add custom_field_values JSONB column to hr_employments
--
-- Stores custom field values keyed by the definition's `key` string, not its id.
-- Example document: {"department_code": "ENG", "joining_bonus_eligible": true}
--
-- The column carries NOT NULL with an empty-object default so existing rows are
-- immediately valid. No backfill is needed for the column itself; the data backfill
-- from the legacy sidecar table (hr_employment_custom_field_values) runs in 0541.
--
-- The GIN containment index is created in 0542 after the backfill completes so the
-- index is built once over the populated column rather than rebuilt after backfill.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_employments"
  ADD COLUMN IF NOT EXISTS "custom_field_values" jsonb NOT NULL DEFAULT '{}';
