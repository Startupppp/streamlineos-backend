-- 0354 — drop dead Postgres enum types
-- =============================================================================
-- Drops 9 pgEnum types whose Drizzle declarations were the SOLE reference in
-- all of backend/src/ (no table column used them, no module imported them).
-- Verified by counting grep occurrences — each symbol appeared exactly once
-- (its own declaration). The Drizzle declarations are removed from schema files
-- in the same change so the ORM no longer tries to CREATE them.
--
-- Evidence per type:
--   payroll_status          — created in 0000, used in the "payrolls" table
--                             (status column). payrolls was fully dropped in
--                             0345; the type was orphaned and never re-assigned.
--   deal_activity_type      — created in 0000, never assigned to any column in
--                             any migration.
--   crm_event_status        — created in 0000, never assigned to any column.
--   task_type               — created in 0000, never assigned to any column.
--                             CRM metadata uses "task_type" as a string key, not
--                             a Postgres enum column.
--   onboarding_flow_task_status  — created in 0000, never assigned to any column.
--   onboarding_flow_task_category — created in 0000, never assigned to any column.
--   hr_custom_field_type    — created in 0000, used in hr_custom_field_definitions
--                             (field_type column). That table was superseded by
--                             the cross-module custom_field_definitions table
--                             which uses text("field_type"). The old table and its
--                             Drizzle definition are gone; the type is orphaned.
--   payroll_run_type        — created in 0292, never assigned to any column
--                             (hr/payroll-runs.ts uses text("run_type") instead).
--   support_source_channel  — created in 0000, never assigned to any column.
--
-- All DROPs are IF EXISTS (idempotent) and safe on an empty DB because the
-- types have no dependent columns after the table drops above.
-- =============================================================================

DROP TYPE IF EXISTS "payroll_status";
DROP TYPE IF EXISTS "deal_activity_type";
DROP TYPE IF EXISTS "crm_event_status";
DROP TYPE IF EXISTS "task_type";
DROP TYPE IF EXISTS "onboarding_flow_task_status";
DROP TYPE IF EXISTS "onboarding_flow_task_category";
DROP TYPE IF EXISTS "hr_custom_field_type";
DROP TYPE IF EXISTS "payroll_run_type";
DROP TYPE IF EXISTS "support_source_channel";
