-- Objects the migration chain creates that the running control plane never received.
--
-- Generated from pg_catalog by src/scripts/generate-chain-repair.mjs --direction=drift.
-- 0320_recon_phase_a_orgid.sql sweeps the catalogue rather than naming its tables, so its
-- outcome depends on the shape of the database at the moment it runs. It covered 66 tables
-- in the control plane and 69 in a cold cell. This file closes that difference.

--
-- foreign keys (2)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'workflow_variables' AND k.conname = 'workflow_variables_org_id_fk') THEN
    ALTER TABLE "public"."workflow_variables" ADD CONSTRAINT "workflow_variables_org_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'workflow_variables' AND k.conname = 'fk_workflow_variables_workflow_version_id_org') THEN
    ALTER TABLE "public"."workflow_variables" ADD CONSTRAINT "fk_workflow_variables_workflow_version_id_org" FOREIGN KEY (org_id, workflow_version_id) REFERENCES workflow_versions(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
--
-- triggers (1)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'workflow_variables' AND t.tgname = 'trg_set_org_id') THEN
    CREATE TRIGGER trg_set_org_id BEFORE INSERT ON public.workflow_variables FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent('workflow_versions', 'id', 'org_id', 'workflow_version_id');
  END IF;
END $repair$;
