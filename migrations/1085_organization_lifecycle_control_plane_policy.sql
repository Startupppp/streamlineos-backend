-- The organization-creation saga runs BEFORE the organisation it is creating can be a tenant:
-- OrganizationSagaService.begin/findByRequestKey/claim execute under @NoTenantTransaction() on
-- POST /organization and POST /org/setup/complete, so app.organization_id is never set. The three
-- lifecycle tables nonetheless carried USING (<org col> = app.current_org_id()), the throwing
-- variant, so every organisation creation raised 42501 and answered 500 — the wizard's Launch step
-- could never complete.
--
-- Same control-plane shape migration 1082 applied to organization_placement: full access on the
-- out-of-tenant path where the GUC is unset, scoped to the caller's own org once one is known.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_lifecycle_sagas";
--> statement-breakpoint
DROP POLICY IF EXISTS "control_plane_access" ON "organization_lifecycle_sagas";
--> statement-breakpoint
CREATE POLICY "control_plane_access" ON "organization_lifecycle_sagas"
  FOR ALL
  TO PUBLIC
  USING (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null())
  WITH CHECK (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null());
--> statement-breakpoint
-- org_id existed only on the push-built database this policy was authored against, so a journal-built
-- database stopped here with 42703. Created before the policy that predicates on it; idempotent.
ALTER TABLE "organization_saga_steps" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
UPDATE "organization_saga_steps" AS s
SET "org_id" = g."organization_id"
FROM "organization_lifecycle_sagas" AS g
WHERE g."saga_id" = s."saga_id" AND s."org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "organization_saga_steps"
  DROP CONSTRAINT IF EXISTS "chk_org_saga_steps_org_id_not_null";
--> statement-breakpoint
ALTER TABLE "organization_saga_steps"
  ADD CONSTRAINT "chk_org_saga_steps_org_id_not_null" CHECK ("org_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "organization_saga_steps" VALIDATE CONSTRAINT "chk_org_saga_steps_org_id_not_null";
--> statement-breakpoint
ALTER TABLE "organization_saga_steps" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_saga_steps" DROP CONSTRAINT "chk_org_saga_steps_org_id_not_null";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_saga_steps_org" ON "organization_saga_steps" ("org_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.set_saga_step_org_id() RETURNS trigger AS $$
BEGIN
  IF NEW."org_id" IS NULL THEN
    SELECT g."organization_id" INTO NEW."org_id"
    FROM public."organization_lifecycle_sagas" AS g
    WHERE g."saga_id" = NEW."saga_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_set_org_id" ON "organization_saga_steps";
--> statement-breakpoint
CREATE TRIGGER "trg_set_org_id" BEFORE INSERT ON "organization_saga_steps"
  FOR EACH ROW EXECUTE FUNCTION public.set_saga_step_org_id();
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_saga_steps";
--> statement-breakpoint
DROP POLICY IF EXISTS "control_plane_access" ON "organization_saga_steps";
--> statement-breakpoint
CREATE POLICY "control_plane_access" ON "organization_saga_steps"
  FOR ALL
  TO PUBLIC
  USING (app.current_org_id_or_null() IS NULL OR "org_id" = app.current_org_id_or_null())
  WITH CHECK (app.current_org_id_or_null() IS NULL OR "org_id" = app.current_org_id_or_null());
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_reservations";
--> statement-breakpoint
DROP POLICY IF EXISTS "control_plane_access" ON "organization_reservations";
--> statement-breakpoint
CREATE POLICY "control_plane_access" ON "organization_reservations"
  FOR ALL
  TO PUBLIC
  USING (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null())
  WITH CHECK (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null());
