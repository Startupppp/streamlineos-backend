-- 0543 — B5. A pick exception that somebody owns, and a substitution that
-- rewrites the demand behind it.
--
-- Before this a pick exception was one enum value and a note. Nobody owned it,
-- nothing said whether it had been looked at, and a substitution recorded what
-- went in the tote while the sales order carried on demanding the SKU that did
-- not. Three things arrive here.
--
--   * `WRONG_LOCATION` on `inv_pick_exception`. It is the one member that does
--     not close the line: the other four say the units are not coming, this one
--     says they exist somewhere else. The line is retargeted to
--     `exception_location_id` and the work stays outstanding.
--   * The exception's own lifecycle on `inv_pick_list_lines` — owner, status,
--     resolution, who reported it and when, who resolved it and when. Two CHECK
--     constraints keep the trio honest: a status exactly when there is a reason,
--     and a resolution exactly when the status is RESOLVED. Conventions drift;
--     a queue that silently misses rows is how an order ships short and nobody
--     is told.
--   * Two permission keys, `inventory:picking:substitute` and
--     `inventory:picking:review`, backfilled onto the module roles whose
--     templates now carry them. Role templates grant on role CREATION only
--     (`seed-system-roles.spec.ts` asserts a re-seed must not touch an existing
--     role's grants), so without the backfill the keys reach new organisations
--     and nowhere else. Same shape as 0532 and 0436.
--
-- Existing exception rows are backfilled RESOLVED/ACCEPTED rather than OPEN.
-- They were raised under rules that had no review at all, and landing them in a
-- supervisor's queue would present historical facts as outstanding work — and,
-- because an unresolved review-requiring exception now blocks a wave from
-- completing, would reopen waves that finished weeks ago.
--
-- Locking, per §3 Migrations. `ALTER TABLE ... ADD COLUMN` with no default and
-- no NOT NULL is a catalogue-only change, so the ACCESS EXCLUSIVE it takes is
-- held for microseconds — but every foreign key below still points at a live
-- table (`users` is global: every tenant's authentication queues behind a bare
-- ADD CONSTRAINT), so each is installed NOT VALID and validated separately, and
-- `lock_timeout` makes a contended one fail fast rather than block the table
-- behind it. `CREATE INDEX CONCURRENTLY` cannot appear inside a transaction
-- block and drizzle's runner wraps every pending migration in one, so the index
-- is the plain form; `inv_pick_list_lines` is small and the partial predicate
-- excludes almost all of it.

SET lock_timeout = '5s';
--> statement-breakpoint

-- Enum members are additive and cannot be added inside a transaction block on
-- older servers; `ADD VALUE IF NOT EXISTS` is idempotent, which is what makes a
-- re-run safe.
ALTER TYPE "inv_pick_exception" ADD VALUE IF NOT EXISTS 'WRONG_LOCATION';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inv_pick_exception_status') THEN
    CREATE TYPE "inv_pick_exception_status" AS ENUM ('OPEN', 'RESOLVED');
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inv_pick_exception_resolution') THEN
    CREATE TYPE "inv_pick_exception_resolution" AS ENUM ('ACCEPTED', 'REJECTED');
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_pick_list_lines"
  ADD COLUMN IF NOT EXISTS "exception_owner_id" text,
  ADD COLUMN IF NOT EXISTS "exception_status" "inv_pick_exception_status",
  ADD COLUMN IF NOT EXISTS "exception_resolution" "inv_pick_exception_resolution",
  ADD COLUMN IF NOT EXISTS "exception_resolution_notes" text,
  ADD COLUMN IF NOT EXISTS "exception_reported_by" text,
  ADD COLUMN IF NOT EXISTS "exception_reported_at" timestamp,
  ADD COLUMN IF NOT EXISTS "exception_resolved_by" text,
  ADD COLUMN IF NOT EXISTS "exception_resolved_at" timestamp,
  ADD COLUMN IF NOT EXISTS "exception_location_id" integer;
--> statement-breakpoint

-- Backfilled before the CHECKs go on, or a row raised under the old rules fails
-- the validation of a constraint written for the new ones.
UPDATE "inv_pick_list_lines"
   SET "exception_status" = 'RESOLVED',
       "exception_resolution" = 'ACCEPTED',
       "exception_resolved_at" = now()
 WHERE "exception_reason" IS NOT NULL
   AND "exception_status" IS NULL;
--> statement-breakpoint

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('fk_inv_pick_list_lines_exception_owner', '("exception_owner_id") REFERENCES "users" ("id") ON DELETE SET NULL'),
      ('fk_inv_pick_list_lines_exception_reported_by', '("exception_reported_by") REFERENCES "users" ("id") ON DELETE SET NULL'),
      ('fk_inv_pick_list_lines_exception_resolved_by', '("exception_resolved_by") REFERENCES "users" ("id") ON DELETE SET NULL'),
      ('fk_inv_pick_list_lines_exception_location', '("exception_location_id") REFERENCES "inv_locations" ("id") ON DELETE SET NULL')
    ) AS t(name, spec)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = fk.name AND conrelid = 'inv_pick_list_lines'::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE "inv_pick_list_lines" ADD CONSTRAINT %I FOREIGN KEY %s NOT VALID',
        fk.name, fk.spec
      );
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = fk.name AND conrelid = 'inv_pick_list_lines'::regclass AND NOT convalidated
    ) THEN
      EXECUTE format('ALTER TABLE "inv_pick_list_lines" VALIDATE CONSTRAINT %I', fk.name);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- A status without a reason is a lifecycle for an exception nobody raised; a
-- reason without a status is a row the supervisor queue cannot see.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_pick_list_lines_exception_status'
  ) THEN
    ALTER TABLE "inv_pick_list_lines"
      ADD CONSTRAINT "chk_inv_pick_list_lines_exception_status" CHECK (
        ("exception_reason" IS NULL) = ("exception_status" IS NULL)
      ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_pick_list_lines" VALIDATE CONSTRAINT "chk_inv_pick_list_lines_exception_status";
--> statement-breakpoint

-- A resolution on an OPEN exception is a decision nobody took; a RESOLVED one
-- with no resolution cannot say what was decided.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_pick_list_lines_exception_resolution'
  ) THEN
    ALTER TABLE "inv_pick_list_lines"
      ADD CONSTRAINT "chk_inv_pick_list_lines_exception_resolution" CHECK (
        ("exception_status" = 'RESOLVED') = ("exception_resolution" IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_pick_list_lines" VALIDATE CONSTRAINT "chk_inv_pick_list_lines_exception_resolution";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_pick_lines_exception_queue"
  ON "inv_pick_list_lines" ("org_id", "exception_status", "id")
  WHERE "exception_reason" IS NOT NULL;
--> statement-breakpoint

-- The catalogue row has to exist before any grant can reference it:
-- `role_permission_grants.permission_key` is a foreign key onto
-- `permissions.name`, and `PermissionCatalogSyncService` writes that row at
-- application boot, which is after this migration runs.
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key", "is_delegable")
VALUES
  ('inventory:picking:substitute', 'inventory:picking', 'substitute',
   'Swap a different SKU in at the shelf, rewriting the sales-order line and its reservation',
   'inventory', true),
  ('inventory:picking:review', 'inventory:picking', 'review',
   'Own and resolve pick exceptions raised by pickers', 'inventory', true)
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint

INSERT INTO "permission_supported_scopes" ("permission_key", "scope")
VALUES ('inventory:picking:substitute', 'all'), ('inventory:picking:review', 'all')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- The slug is the part that goes wrong. `seedSystemRolesForOrg` mints
-- `${MODULE}_MODULE_OWNER|ADMIN|MEMBER`, and those are the only `INVENTORY%`
-- slugs a live organisation actually has -- `INVENTORY_MANAGER` and
-- `INVENTORY_SUPERVISOR` are `ROLE_TEMPLATES` slugs an administrator may
-- materialise, and seven CRM migrations once backfilled onto their equivalents
-- and granted eighteen permissions to nobody (see 0532). MODULE_MEMBER is
-- deliberately left out: both keys are management authority, not a `:read`.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."key", 'all'
FROM "roles" r
CROSS JOIN (VALUES ('inventory:picking:substitute'), ('inventory:picking:review')) AS k("key")
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
