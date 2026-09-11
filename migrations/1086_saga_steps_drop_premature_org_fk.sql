-- organization_saga_steps.org_id carried FOREIGN KEY -> organizations(id), but saga steps are
-- written by OrganizationSagaService.begin() BEFORE the organisation row is created — that is the
-- point of the saga. The BEFORE INSERT trigger trg_set_org_id copies organization_id down from the
-- parent saga, so every step insert referenced an organisation that did not exist yet and failed
-- 23503, making organisation creation impossible.
--
-- The parent, organization_lifecycle_sagas, has no foreign keys for exactly this reason. The child
-- must match it. Lifecycle is already covered by fk_org_saga_steps_saga ON DELETE CASCADE, and the
-- column itself stays (NOT NULL, trigger-populated) because the RLS policy predicates on it.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "organization_saga_steps" DROP CONSTRAINT IF EXISTS "organization_saga_steps_org_id_fk";
