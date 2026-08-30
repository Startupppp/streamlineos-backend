-- candidate_resumes is tenant data by 0320's own rule and never received a tenant column.
--
-- 0320_recon_phase_a_orgid.sql adds a denormalised org_id to every public table that has no
-- org column and does have a NOT NULL single-column foreign key to an org-bearing parent. It
-- sweeps pg_catalog rather than naming its tables, so which tables it covers depends on the
-- shape of the database at the moment it runs -- 66 tables in the control plane, 69 in a cold
-- cell. candidate_resumes matches the rule in both and was reached by neither.
--
-- Until now nothing could report it. db:verify-rls looked for tables that HAVE an org column
-- and lack a policy, so a table missing the column entirely passed the check by being more
-- broken rather than less. That blind spot is closed in the same change as this migration.
--
-- Pattern follows 0320 for the column and trigger, then 0591 for the policy, and the order in
-- the second half matters: ENABLE, then DROP IF EXISTS so a re-run is clean, then CREATE, then
-- REVOKE the PUBLIC grant, then GRANT to the application role. Reversing the last two leaves
-- PUBLIC holding rights on a table whose policy is already live.

ALTER TABLE "candidate_resumes" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint

UPDATE "candidate_resumes" c
   SET "org_id" = p."org_id"
  FROM "candidates" p
 WHERE p."id" = c."candidate_id" AND c."org_id" IS NULL;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_set_org_id ON "candidate_resumes";
--> statement-breakpoint

CREATE TRIGGER trg_set_org_id
  BEFORE INSERT ON "candidate_resumes"
  FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent('candidates', 'id', 'org_id', 'candidate_id');
--> statement-breakpoint

DO $repair$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'public.candidate_resumes'::regclass
      AND a.attname = 'org_id' AND a.attnotnull
  ) THEN
    ALTER TABLE "candidate_resumes" ALTER COLUMN "org_id" SET NOT NULL;
  END IF;
END $repair$;
--> statement-breakpoint

DO $repair$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.candidate_resumes'::regclass
      AND conname = 'candidate_resumes_org_id_fk'
  ) THEN
    ALTER TABLE "candidate_resumes"
      ADD CONSTRAINT "candidate_resumes_org_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint

DO $repair$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.candidate_resumes'::regclass
      AND conname = 'fk_candidate_resumes_candidate_id_org'
  ) THEN
    ALTER TABLE "candidate_resumes"
      ADD CONSTRAINT "fk_candidate_resumes_candidate_id_org"
      FOREIGN KEY ("org_id", "candidate_id") REFERENCES "candidates"("org_id", "id") ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint

DO $repair$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.candidate_resumes'::regclass
      AND conname = 'uniq_candidate_resumes_org_id'
  ) THEN
    ALTER TABLE "candidate_resumes"
      ADD CONSTRAINT "uniq_candidate_resumes_org_id" UNIQUE ("org_id", "id");
  END IF;
END $repair$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_candidate_resumes_org" ON "candidate_resumes" ("org_id");
--> statement-breakpoint

ALTER TABLE "candidate_resumes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "candidate_resumes";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "candidate_resumes"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

REVOKE ALL ON "candidate_resumes" FROM PUBLIC;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate_resumes" TO streamline_app;
