SET statement_timeout = 0;
-- 0359 — exit_checklists tenant isolation (idempotent)
-- =============================================================================
-- W-12 (tenant-isolation hole):
--   exit_checklists had no org_id column; tenant scoping relied transitively
--   on resignation_id → resignations.  Every other tenant table in this schema
--   carries a direct org_id with a leading composite index and a composite FK.
--   The org_id column may have been added by the Wave-4 bulk trigger migration;
--   every step here is idempotent so the migration is safe regardless of prior
--   DB state.
-- =============================================================================

ALTER TABLE "exit_checklists" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
UPDATE "exit_checklists" ec
SET    "org_id" = r."org_id"
FROM   "resignations" r
WHERE  ec."resignation_id" = r."id"
  AND  ec."org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "exit_checklists" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'exit_checklists_org_id_organizations_id_fk'
      AND conrelid = 'exit_checklists'::regclass
  ) THEN
    ALTER TABLE "exit_checklists"
      ADD CONSTRAINT "exit_checklists_org_id_organizations_id_fk"
      FOREIGN KEY ("org_id")
      REFERENCES "organizations" ("id")
      ON DELETE CASCADE;
  END IF;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_exit_checklists_org_resignation'
      AND conrelid = 'exit_checklists'::regclass
  ) THEN
    ALTER TABLE "exit_checklists"
      ADD CONSTRAINT "fk_exit_checklists_org_resignation"
      FOREIGN KEY ("org_id", "resignation_id")
      REFERENCES "resignations" ("org_id", "id")
      ON DELETE CASCADE;
  END IF;
END;
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_exit_checklists_org_resignation"
  ON "exit_checklists" ("org_id", "resignation_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniq_exit_checklists_org_id'
      AND conrelid = 'exit_checklists'::regclass
  ) THEN
    ALTER TABLE "exit_checklists"
      ADD CONSTRAINT "uniq_exit_checklists_org_id"
      UNIQUE ("org_id", "id");
  END IF;
END;
$$;
