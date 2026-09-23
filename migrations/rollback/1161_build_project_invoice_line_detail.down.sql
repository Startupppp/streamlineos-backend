-- Rollback for migration 1161.
--
-- Drops the per-project invoice line detail setting and then the enum type.
-- Rolling back returns every project to the pre-1161 behaviour, where a generated
-- invoice line carried the worker's raw timesheet text to the client portal.
--
-- @data-loss: projects.invoice_line_detail
-- Any project switched to 'raw' loses that choice and silently reverts to the
-- old always-raw behaviour, which is a disclosure change, not just a data loss.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."projects" DROP COLUMN IF EXISTS "invoice_line_detail";
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
     WHERE t.typname = 'invoice_line_detail' AND NOT a.attisdropped
  ) THEN
    DROP TYPE IF EXISTS "public"."invoice_line_detail";
  END IF;
END $$;
