SET lock_timeout = '5s';
--> statement-breakpoint
-- INV-205. A pick line could record how much was picked and nothing about why
-- the rest was not. That leaves the two cases that matter indistinguishable: a
-- line picked short because the shelf was empty, and a line picked short
-- because the picker moved on. The first is a stock problem, the second is a
-- process problem, and a warehouse that cannot tell them apart fixes neither.
--
-- `substitute_variant_id` records what actually went in the tote when a picker
-- swapped one item for another. Without it a substitution is invisible until a
-- customer opens the box.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inv_pick_exception') THEN
    CREATE TYPE "inv_pick_exception" AS ENUM (
      'SHORT',
      'NOT_FOUND',
      'DAMAGED',
      'SUBSTITUTED'
    );
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_pick_list_lines"
  ADD COLUMN IF NOT EXISTS "exception_reason" "inv_pick_exception";
--> statement-breakpoint
ALTER TABLE "inv_pick_list_lines"
  ADD COLUMN IF NOT EXISTS "exception_notes" text;
--> statement-breakpoint
ALTER TABLE "inv_pick_list_lines"
  ADD COLUMN IF NOT EXISTS "substitute_variant_id" integer;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_pick_lines_substitute_variant'
  ) THEN
    ALTER TABLE "inv_pick_list_lines"
      ADD CONSTRAINT "fk_inv_pick_lines_substitute_variant"
      FOREIGN KEY ("org_id", "substitute_variant_id")
      REFERENCES "inv_product_variants" ("org_id", "id") NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_pick_list_lines"
  VALIDATE CONSTRAINT "fk_inv_pick_lines_substitute_variant";
--> statement-breakpoint
-- Exceptions are the rare row in a table that grows with every pick, and
-- "which lines had a problem" is the only reason to query the column.
CREATE INDEX IF NOT EXISTS "idx_inv_pick_lines_exception"
  ON "inv_pick_list_lines" ("org_id", "exception_reason")
  WHERE "exception_reason" IS NOT NULL;
