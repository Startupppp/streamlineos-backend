-- 1126 — Recruitment: where a BGV verdict came from
--
-- `bgv_status` already records what the verdict is. It never recorded who said
-- so, which means a CLEARED typed in by a recruiter and a CLEARED returned by a
-- verification agency were the same row. Those are different claims with
-- different evidence behind them, and an offer that relies on the second must
-- not be satisfied by the first without anybody being able to tell.
--
-- `bgv_reference` is the agency's own case identifier, so a verdict can be
-- traced back to the report it came from.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "bgv_source" text;
--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "bgv_reference" text;
--> statement-breakpoint
-- A verdict must name its source. NOT VALID so the existing rows, which predate
-- the column and have nothing to say, are left alone rather than back-filled
-- with a source nobody observed.
ALTER TABLE "candidates" ADD CONSTRAINT "chk_candidates_bgv_source"
  CHECK ("bgv_source" IS NULL OR "bgv_source" IN ('MANUAL', 'AGENCY')) NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_candidates_org_bgv_reference"
  ON "candidates" ("org_id", "bgv_reference")
  WHERE "bgv_reference" IS NOT NULL;
