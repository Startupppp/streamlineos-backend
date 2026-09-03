-- 1043 DOWN -- removes the two "a reference requires a tenant" CHECK constraints.
--
-- Dropping a CHECK is itself lossless and instant: the constraint holds no data,
-- and after this runs both tables accept the org_id-NULL-with-a-reference state
-- again -- which is exactly the state in which the composite FOREIGN KEY beside
-- it (MATCH SIMPLE) stops firing. Rolling this back re-opens the hole; that is
-- what rolling it back MEANS, and it is recorded here rather than left implicit.
--
-- @data-loss: the forward migration's repair is NOT reversible. 1043 cleared
-- actor_membership_id on any audit_logs row that had one while having no org_id,
-- and entity_id on the same shape in payroll_statutory_rule_sets. Those values
-- cannot be reconstructed -- and could not have been interpreted in the first
-- place, since a membership id and a payroll entity id are only meaningful
-- inside an organisation, which is precisely why the reference was cleared
-- rather than the row rejected. On a database at head the repair matched 0 rows
-- (measured: audit_logs 0 of 0, payroll_statutory_rule_sets 0 of 8), so this
-- clause bites only where the forward migration actually found something.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.audit_logs
  DROP CONSTRAINT IF EXISTS "chk_audit_logs_membership_requires_org";
--> statement-breakpoint

ALTER TABLE public.payroll_statutory_rule_sets
  DROP CONSTRAINT IF EXISTS "chk_payroll_statutory_rule_sets_entity_requires_org";
