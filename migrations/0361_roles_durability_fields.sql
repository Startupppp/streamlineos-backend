SET statement_timeout = 0;
DO $$
DECLARE
  dup_count integer;
  dup_detail text;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT org_id, COALESCE(module_key, '') AS mk, LOWER(name) AS ln
    FROM roles
    GROUP BY org_id, COALESCE(module_key, ''), LOWER(name)
    HAVING COUNT(*) > 1
  ) dups;

  IF dup_count > 0 THEN
    SELECT string_agg(
      r.org_id || '/' || COALESCE(r.module_key, '<org-wide>') || '/' || r.name,
      ', '
    ) INTO dup_detail
    FROM roles r
    WHERE (r.org_id, COALESCE(r.module_key, ''), LOWER(r.name)) IN (
      SELECT org_id, COALESCE(module_key, ''), LOWER(name)
      FROM roles
      GROUP BY org_id, COALESCE(module_key, ''), LOWER(name)
      HAVING COUNT(*) > 1
      LIMIT 10
    );

    RAISE EXCEPTION
      'Migration 0361 aborted: % duplicate role name group(s) found (case-insensitive, per org+module). De-duplicate manually before running this migration. Affected rows: %',
      dup_count, dup_detail;
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "created_by" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'roles_created_by_users_id_fk'
      AND conrelid = 'roles'::regclass
  ) THEN
    ALTER TABLE "roles"
      ADD CONSTRAINT "roles_created_by_users_id_fk"
      FOREIGN KEY ("created_by")
      REFERENCES "users" ("id")
      ON DELETE SET NULL;
  END IF;
END;
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_roles_org_module_name_ci"
  ON "roles" (org_id, COALESCE(module_key, ''), LOWER(name));
