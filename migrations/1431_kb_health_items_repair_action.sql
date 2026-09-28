-- 1431 — Knowledge base: add repair_action column to kb_health_items.
--
-- B4 (content-health): the S15 requirement specifies that a health item
-- "links to its evidence and to an allowed repair". The evidence link is already
-- in the evidence jsonb column (added in 1228). The allowed-repair link was
-- missing: when bulkRepair applies a repair, the item did not record which
-- action was taken. This column closes that gap so the workflow surface can show
-- what was done, and an audit trail exists without inspecting state changes.
--
-- The column is nullable because:
--   - Items created by the scanner (contradictory_claim) or detected on-demand
--     (unowned, stale, etc.) have not had a repair applied yet.
--   - dismiss() and assign() do not constitute a repair in the bulkRepair sense;
--     they set state/assignee independently.
--   - The CHECK constraint restricts values to the three enum members that match
--     bulkRepairBodySchema.repairAction, keeping the column self-documenting.
--
-- Replays on an empty DB: the precondition checks for kb_health_items existence
-- only; it does not raise if the column is absent (so replay is safe).
--
-- Rollback: migrations/rollback/1431_kb_health_items_repair_action.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_health_items') IS NULL THEN
    RAISE EXCEPTION '1431 precondition: public.kb_health_items is absent — run 1228 first';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."kb_health_items"
  ADD COLUMN IF NOT EXISTS "repair_action" text;
--> statement-breakpoint

ALTER TABLE "public"."kb_health_items"
  DROP CONSTRAINT IF EXISTS "chk_kb_health_items_repair_action";
--> statement-breakpoint

ALTER TABLE "public"."kb_health_items"
  ADD CONSTRAINT "chk_kb_health_items_repair_action" CHECK (
    "repair_action" IS NULL OR "repair_action" IN (
      'assign_owner', 'request_review', 'mark_needs_content'
    )
  );
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'kb_health_items'
      AND column_name = 'repair_action'
  ), '1431 post-check: kb_health_items.repair_action was not added';
END $$;
--> statement-breakpoint
