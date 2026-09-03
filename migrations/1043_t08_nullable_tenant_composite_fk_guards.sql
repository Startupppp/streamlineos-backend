-- 1043: close the two composite foreign keys whose TENANT column is nullable.
--
-- A composite FOREIGN KEY is MATCH SIMPLE by default, and MATCH SIMPLE does not
-- fire at all when ANY of its columns is NULL. That is not a nuance; it is the
-- exact hole that produced this release's P1 cross-tenant write, where
-- announcement_reads.org_id was nullable and an omitted org_id meant the
-- composite FK to the parent never ran. The constraint LOOKS present in
-- pg_constraint and enforces nothing on the rows that matter.
--
-- Audited at head against pg_catalog, not against the declarations: of the 3
-- composite FKs in `public` that carry a tenant-shaped column, exactly 2 have
-- that column NULLABLE.
--
--   contacts.fk_contacts_organization_id_org  (org_id, organization_id)
--       org_id is NOT NULL, so the FK always fires for the tenant. The nullable
--       member is organization_id, an OPTIONAL PARENT — "this contact belongs to
--       no CRM organisation" is a real state and a non-firing FK is correct
--       there. Not a hole, deliberately left alone. (CRM is also out of release
--       scope.)
--
--   audit_logs.fk_audit_logs_org_actor_membership  (org_id, actor_membership_id)
--   payroll_statutory_rule_sets.fk_..._entity_id_org  (org_id, entity_id)
--       Both have org_id NULLABLE, and both are holes.
--
-- Why org_id is nullable on those two, and why NOT NULL is the WRONG fix:
-- both are on the documented list of tables that hold genuinely global rows
-- (src/common/tenant/README.md, "Tables that need a different policy"), and
-- both carry the matching RLS escape `CASE WHEN org_id IS NULL THEN true`.
-- audit_logs uses it for platform events (pinned by the existing
-- chk_audit_logs_tenant_or_platform: `(org_id IS NULL) = is_platform_event`);
-- payroll_statutory_rule_sets uses it for the system-default statutory rule
-- sets seeded by 0292 — all 8 rows on a production-shaped seed are exactly
-- those, org_id NULL and entity_id NULL. Forcing org_id NOT NULL would delete
-- the feature.
--
-- The correct fix is therefore not to remove the NULL but to forbid the ONE
-- combination in which the FK silently stops enforcing: a row that names a
-- tenant-scoped child (a membership, a payroll entity) while claiming to have
-- no tenant. In that state the referenced id is both unenforceable AND
-- uninterpretable — a membership id and a payroll entity id are only meaningful
-- inside an organisation — so this is a data-integrity rule, not just a
-- tightening. With the CHECK in place the composite FK is enforced on every row
-- that carries a reference at all, which is what it was written to do.
--
-- Repair before validate: a row already in the forbidden state has an
-- unenforceable, uninterpretable reference, so the reference is cleared rather
-- than the row dropped — the audit entry keeps actor_user_id and every other
-- column, and nothing is lost that was ever readable. Measured 0 such rows on
-- scratch_perf_seed (audit_logs 0 of 0; payroll_statutory_rule_sets 0 of 8), so
-- on a database at head this repair is a no-op; it exists for the ones that are
-- not.
--
-- Lock shape: ADD CONSTRAINT … NOT VALID takes ACCESS EXCLUSIVE only long
-- enough to write the catalog row and does NOT scan the table; VALIDATE
-- CONSTRAINT then takes SHARE UPDATE EXCLUSIVE, which does not block reads or
-- writes. audit_logs is the largest table this touches, and that split is why
-- it can be done online. lock_timeout makes the first step fail fast instead of
-- queueing behind a long read and blocking every writer behind it in turn.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.audit_logs
  DROP CONSTRAINT IF EXISTS "chk_audit_logs_membership_requires_org";
--> statement-breakpoint

ALTER TABLE public.audit_logs
  ADD CONSTRAINT "chk_audit_logs_membership_requires_org"
  CHECK (actor_membership_id IS NULL OR org_id IS NOT NULL)
  NOT VALID;
--> statement-breakpoint

UPDATE public.audit_logs
  SET actor_membership_id = NULL
  WHERE org_id IS NULL AND actor_membership_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.audit_logs
  VALIDATE CONSTRAINT "chk_audit_logs_membership_requires_org";
--> statement-breakpoint

ALTER TABLE public.payroll_statutory_rule_sets
  DROP CONSTRAINT IF EXISTS "chk_payroll_statutory_rule_sets_entity_requires_org";
--> statement-breakpoint

ALTER TABLE public.payroll_statutory_rule_sets
  ADD CONSTRAINT "chk_payroll_statutory_rule_sets_entity_requires_org"
  CHECK (entity_id IS NULL OR org_id IS NOT NULL)
  NOT VALID;
--> statement-breakpoint

UPDATE public.payroll_statutory_rule_sets
  SET entity_id = NULL
  WHERE org_id IS NULL AND entity_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.payroll_statutory_rule_sets
  VALIDATE CONSTRAINT "chk_payroll_statutory_rule_sets_entity_requires_org";
