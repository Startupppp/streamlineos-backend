SET statement_timeout = 0;

-- =============================================================================
-- 0370 — repair tenant columns that cannot enforce tenancy
-- =============================================================================
-- Two defects found by auditing pg_catalog rather than the Drizzle model:
--
-- (A) FOUR tables were created by the baseline with `org_id integer`, while
--     `organizations.id` is TEXT and the Drizzle model declares them
--     `text(...).references(() => organizations.id)`. The column therefore
--     could never hold a real org id and could never carry a foreign key —
--     a tenant column that cannot reference a tenant. All four are empty, so
--     the type change is a metadata-only rewrite of an empty relation.
--
-- (B) THREE more tenant columns had NO foreign key at all, so an org id that
--     references nothing could be written and deleting an org would strand the
--     rows instead of cascading. Verified zero orphans before adding each.
--
-- The baseline is never regenerated (its hash is applied), so this is a
-- forward-only repair.
-- =============================================================================

-- (A) integer -> text, then the FK the model always claimed to have.
ALTER TABLE "affiliates"        ALTER COLUMN "org_id" TYPE text USING "org_id"::text;
--> statement-breakpoint
ALTER TABLE "app_installations" ALTER COLUMN "org_id" TYPE text USING "org_id"::text;
--> statement-breakpoint
ALTER TABLE "billing_profiles"  ALTER COLUMN "org_id" TYPE text USING "org_id"::text;
--> statement-breakpoint
ALTER TABLE "revenue_events"    ALTER COLUMN "org_id" TYPE text USING "org_id"::text;
--> statement-breakpoint

DO $$
DECLARE
  t text;
  col text;
  orphans integer;
BEGIN
  FOR t, col IN
    SELECT * FROM (VALUES
      ('affiliates',         'org_id'),
      ('app_installations',  'org_id'),
      ('billing_profiles',   'org_id'),
      ('revenue_events',     'org_id'),
      ('crm_sla_breach_log', 'org_id'),
      ('invitation_events',  'org_id'),
      ('email_outbox',       'organization_id')
    ) AS v(t, col)
  LOOP
    -- Refuse to add a constraint that would silently orphan rows.
    EXECUTE format(
      'SELECT count(*) FROM %I x WHERE x.%I IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = x.%I)',
      t, col, col) INTO orphans;

    IF orphans > 0 THEN
      RAISE EXCEPTION '0370: %.% has % row(s) referencing a non-existent organization', t, col, orphans;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      WHERE rel.relname = t AND c.contype = 'f'
        AND c.conname = format('fk_%s_org', t)
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES organizations(id) ON DELETE CASCADE',
        t, format('fk_%s_org', t), col);
    END IF;

    -- Every tenant column needs a leading index for tenant-scoped reads.
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = t
        AND indexdef LIKE '%(' || col || '%'
    ) THEN
      EXECUTE format('CREATE INDEX %I ON %I (%I)', format('idx_%s_org', t), t, col);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- Prove the repair: no tenant column may remain without a foreign key.
DO $$
DECLARE
  leftover integer;
BEGIN
  SELECT count(*) INTO leftover
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
   AND a.attname IN ('org_id', 'organization_id') AND NOT a.attisdropped
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint con
      WHERE con.conrelid = c.oid AND con.contype = 'f' AND a.attnum = ANY(con.conkey)
    );

  IF leftover > 0 THEN
    RAISE EXCEPTION '0370: % tenant column(s) still have no foreign key', leftover;
  END IF;
END $$;
