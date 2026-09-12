-- Reverses 1086. Re-adds `organization_saga_steps_org_id_fk`, the foreign key
-- from organization_saga_steps.org_id to organizations(id).
--
-- ⚠ READ THIS BEFORE RUNNING IT. Applying this rollback RESTORES A KNOWN
-- PRODUCTION BREAKAGE, and a total one. Saga steps are written by
-- OrganizationSagaService.begin() BEFORE the organisation row exists — that is
-- the entire point of the saga — and the BEFORE INSERT trigger trg_set_org_id
-- copies organization_id down from the parent saga. So every step insert
-- references an organisation that does not exist yet and fails 23503, making
-- organisation creation impossible. The parent table,
-- organization_lifecycle_sagas, carries no foreign keys for exactly this reason.
--
-- It exists anyway, and is not declared @irreversible, because 1086 destroys no
-- data and the constraint is exactly reproducible. Same position the 0913
-- rollback takes: a rollback restores the state before the migration; it does
-- not promise that state was good. The reason 1086 exists is that it was not.
--
-- THIS ADDS RATHER THAN RESTORES ON A CHAIN-BUILT DATABASE, which is the one
-- thing to understand before running it. No migration in this chain ever created
-- `organization_saga_steps_org_id_fk` — 1086's DROP IF EXISTS is the only
-- mention of that name in the tree. The constraint was live-only drift, present
-- on databases that acquired it outside the chain, and 1086 is the repair. On a
-- database built from the journal the constraint was never there, so this file
-- puts it in a state it has never been in. That is unavoidable: once 1086 has
-- run, a database that had the drift and one that never did are indistinguishable.
--
-- NOT VALID, deliberately. Rows written since 1086 belong to sagas whose
-- organisation may legitimately not exist yet, so a validating ADD CONSTRAINT
-- would fail against existing data and this rollback could not run at all.
-- NOT VALID checks new writes only — which is the prior behaviour being restored,
-- since the drifted constraint only ever bit on insert.
--
-- IDEMPOTENT. Run where the constraint is already present, a bare ADD CONSTRAINT
-- raises 42710 "constraint already exists" and the rollback dies on its first
-- statement, so it is added only when absent.
SET lock_timeout = '5s';
--> statement-breakpoint
DO $rollback$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'organization_saga_steps'
       AND k.conname = 'organization_saga_steps_org_id_fk'
  ) THEN
    ALTER TABLE "organization_saga_steps"
      ADD CONSTRAINT "organization_saga_steps_org_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id")
      NOT VALID;
  END IF;
END
$rollback$;
