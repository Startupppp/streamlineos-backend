SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
-- D7 — an audit export that is worth what its checksum says.
--
-- Three parts, and the order matters: the second is what makes the first
-- honest, and the third is what makes the endpoint reachable by anybody.
--
-- ---------------------------------------------------------------------------
-- 1. The job. A manifest, not a blob.
-- ---------------------------------------------------------------------------
-- `inv_export_jobs` stores the CSV it produced in `result_url`, a text column.
-- That is workable for a filtered product list and wrong for an audit export,
-- which is an organisation's whole ledger and has no upper bound. This table
-- stores only what the document is a *function of* — the pinned evidence
-- ceilings, the resolved warehouse scope, the date filters, the schema version
-- — plus the checksum and row counts it produced. `download` re-derives the
-- bytes on demand, streamed and keyset-paginated, and gets the same file every
-- time. Nothing is materialised anywhere.
--
-- `pinned_xmax` is the part that is easy to leave out and impossible to add
-- later. `serial` allocates ids outside transaction control, so at the moment
-- max(id) reads 100, id 98 may still be uncommitted and will appear below the
-- ceiling when it commits. Until `pg_snapshot_xmin(pg_current_snapshot())` has
-- passed the `pg_snapshot_xmax` recorded here, the set of rows at or below the
-- ceilings can still grow, and a checksum over a set that can still grow is a
-- claim rather than a guarantee. The service refuses to complete a job before
-- that boundary is crossed.
CREATE TABLE IF NOT EXISTS "inv_audit_export_jobs" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "status" inv_job_status NOT NULL DEFAULT 'PENDING',
  "schema_version" integer NOT NULL,
  "evidence_version" text NOT NULL,
  "ledger_ceiling_id" integer NOT NULL,
  "audit_ceiling_id" integer NOT NULL,
  "pinned_xmax" numeric(20, 0) NOT NULL,
  "scope_warehouse_ids" jsonb,
  "sections" jsonb NOT NULL,
  "filter_from" date,
  "filter_to" date,
  "ledger_row_count" integer,
  "audit_row_count" integer,
  "checksum" text,
  "byte_length" bigint,
  "settled_at" timestamp,
  "failure_reason" text,
  "created_by" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- The table was created empty in this same transaction, so there is nothing for
-- a `NOT VALID` -> `VALIDATE` split to defer: the validating scan is over zero
-- rows. What the split cannot help with either way is the lock taken on the
-- *referenced* side, which is why `lock_timeout` above is the real mitigation
-- here -- this fails fast instead of queueing behind a long read on
-- `organizations` and blocking every write to it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inv_audit_export_jobs_org_id_fk') THEN
    ALTER TABLE "inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_org_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inv_audit_export_jobs_created_by_fk') THEN
    ALTER TABLE "inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_created_by_fk"
      FOREIGN KEY ("created_by") REFERENCES "users"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_inv_audit_export_jobs_org_id') THEN
    ALTER TABLE "inv_audit_export_jobs" ADD CONSTRAINT "uniq_inv_audit_export_jobs_org_id" UNIQUE ("org_id", "id");
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_audit_export_jobs_org_created"
  ON "inv_audit_export_jobs" ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_audit_export_jobs_org_status"
  ON "inv_audit_export_jobs" ("org_id", "status");
--> statement-breakpoint
ALTER TABLE "inv_audit_export_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_audit_export_jobs";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inv_audit_export_jobs"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 2. The audit trail becomes append-only, like the ledger already is.
-- ---------------------------------------------------------------------------
-- `0529` froze the facts on `inv_stock_transactions` and deliberately left
-- `notes`, `reason` and `metadata` editable, because an annotation describes a
-- movement rather than being it. `inv_audit_events` has no such split: every
-- column on it is a record of something that happened, and nothing in the
-- application has ever updated one -- `InventoryAuditService` and
-- `InventorySettingsService` only insert.
--
-- The export names both tables as evidence and says so in its manifest. Half of
-- that claim was enforced by the database and half was enforced by nobody
-- having written the UPDATE yet. This closes the gap rather than letting the
-- document assert something only one of its two sources can back.
--
-- BEFORE UPDATE only, for the reason 0529 gives: organizations cascade-delete
-- into this table, and a DELETE guard would make deleting a tenant impossible.
CREATE OR REPLACE FUNCTION inv_audit_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed text;
BEGIN
  changed := CASE
    WHEN NEW.org_id         IS DISTINCT FROM OLD.org_id         THEN 'org_id'
    WHEN NEW.actor_user_id  IS DISTINCT FROM OLD.actor_user_id  THEN 'actor_user_id'
    WHEN NEW.action         IS DISTINCT FROM OLD.action         THEN 'action'
    WHEN NEW.resource_type  IS DISTINCT FROM OLD.resource_type  THEN 'resource_type'
    WHEN NEW.resource_id    IS DISTINCT FROM OLD.resource_id    THEN 'resource_id'
    WHEN NEW.before         IS DISTINCT FROM OLD.before         THEN 'before'
    WHEN NEW.after          IS DISTINCT FROM OLD.after          THEN 'after'
    WHEN NEW.metadata       IS DISTINCT FROM OLD.metadata       THEN 'metadata'
    WHEN NEW.created_at     IS DISTINCT FROM OLD.created_at     THEN 'created_at'
    ELSE NULL
  END;

  IF changed IS NOT NULL THEN
    RAISE EXCEPTION
      'inv_audit_events is append-only: % cannot be changed on recorded event %',
      changed, OLD.id
      USING ERRCODE = '23514',
            HINT = 'Record a new audit event instead of editing this one.';
  END IF;

  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_inv_audit_events_append_only ON inv_audit_events;
--> statement-breakpoint
CREATE TRIGGER trg_inv_audit_events_append_only
  BEFORE UPDATE ON inv_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION inv_audit_events_append_only();
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 3. `inventory:audit:export`, and the backfill without which it reaches nobody.
-- ---------------------------------------------------------------------------
-- The catalogue row has to exist before any grant can name it:
-- `role_permission_grants.permission_key` is a foreign key onto
-- `permissions.name`, and `PermissionCatalogSyncService` writes that row at
-- application boot, which is after this migration runs.
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key", "is_delegable")
VALUES (
  'inventory:audit:export',
  'inventory:audit',
  'export',
  'Take an immutable, checksummed audit export of the inventory ledger and audit trail',
  'inventory',
  true
)
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
INSERT INTO "permission_supported_scopes" ("permission_key", "scope")
VALUES ('inventory:audit:export', 'all')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Role templates grant on role CREATION only, so a new key reaches no existing
-- organisation without this. The slugs are the three `seedSystemRolesForOrg`
-- actually mints -- not the `ROLE_TEMPLATES` slugs seven CRM migrations granted
-- to and reached nobody with.
--
-- `INVENTORY_MODULE_MEMBER` is deliberately absent, and that is what a fresh
-- organisation gets too: `buildModuleMemberPermissionKeys` takes only keys
-- ending in `:view` or `:read`, so a module member is not seeded this one.
-- Including it here would make a backfilled organisation differ from a fresh
-- one by signup date, which is exactly the divergence 0226 exists to prevent --
-- in the direction of granting evidence access to more people than intended.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'inventory:audit:export', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
