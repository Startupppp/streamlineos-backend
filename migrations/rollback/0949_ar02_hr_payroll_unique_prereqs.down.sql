-- 0949_ar02_hr_payroll_unique_prereqs DOWN — drops every constraint and index the up migration added.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE legal_entities DROP CONSTRAINT IF EXISTS "legal_entities_org_id_id_uniq";
--> statement-breakpoint
ALTER TABLE org_units DROP CONSTRAINT IF EXISTS "org_units_org_id_id_uniq";
