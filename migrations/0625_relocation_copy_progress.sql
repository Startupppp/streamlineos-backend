-- Copy progress on organization_relocations, so a relocation is resumable in fact and not only
-- in the state machine.
--
-- resumeFrom() already returns the recorded state rather than the beginning, but a relocation
-- interrupted halfway through SNAPSHOT resumed at the start of SNAPSHOT and re-copied every
-- table it had already copied. These four columns are what "resumes from where it stopped"
-- needs: how many tables the plan holds, how many are done, how many rows have moved, and which
-- table was last completed.
--
-- last_copied_table is the resume point. It is the last table whose COPY committed, so a
-- restart continues at the entry after it in the plan's deterministic order.

ALTER TABLE "organization_relocations"
  ADD COLUMN IF NOT EXISTS "tables_planned" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "organization_relocations"
  ADD COLUMN IF NOT EXISTS "tables_copied" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "organization_relocations"
  ADD COLUMN IF NOT EXISTS "rows_copied" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "organization_relocations"
  ADD COLUMN IF NOT EXISTS "last_copied_table" text;
