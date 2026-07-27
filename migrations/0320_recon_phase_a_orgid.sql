-- wave-4-phase-a-orgid-backfill.sql  (Wave 4 Phase A — denormalized tenant org_id)
-- Adds a SELF-MAINTAINING org_id to tenant line-item/junction tables that lacked one.
-- For every public table without org_id/organization_id that has a NOT-NULL single-column
-- FK to an org-bearing parent: add org_id, backfill it from that parent, install a
-- BEFORE INSERT trigger that auto-derives org_id from the parent (so NO service-code change
-- is needed and the column can safely be NOT NULL), then add NOT NULL + org FK +
-- (org_id, pk) candidate key. Global/platform tables (no org-bearing parent) are skipped.
-- Idempotent + re-runnable. Applied + verified on the Neon dev branch: 66 tables, 0 failures.
-- (Enables +116 Phase-D composite FKs once these tables carry org_id.)

CREATE OR REPLACE FUNCTION set_org_id_from_parent() RETURNS trigger AS $fn$
DECLARE fk_val text; v_org text;
BEGIN
  IF (to_jsonb(NEW) ->> 'org_id') IS NOT NULL THEN RETURN NEW; END IF;
  fk_val := to_jsonb(NEW) ->> TG_ARGV[3];
  IF fk_val IS NULL THEN RETURN NEW; END IF;
  EXECUTE format('SELECT %I::text FROM %I WHERE %I::text = $1', TG_ARGV[2], TG_ARGV[0], TG_ARGV[1])
    INTO v_org USING fk_val;
  NEW.org_id := v_org;
  RETURN NEW;
END; $fn$ LANGUAGE plpgsql;

DO $$
DECLARE r RECORD; p RECORD; nulls int; fkname text; ck text; pkcol text;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
    WHERE c.relkind='r'
      AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname IN ('org_id','organization_id') AND NOT a.attisdropped)
  LOOP
    -- pick a NOT-NULL single-col FK to an org-bearing parent (prefer the CASCADE/owning parent)
    SELECT ca.attname AS fk_col, parent.relname AS parent_table, pa.attname AS parent_pk, porg.attname AS parent_org
      INTO p
    FROM pg_constraint con
    JOIN pg_class parent ON parent.oid=con.confrelid
    JOIN pg_attribute ca ON ca.attrelid=con.conrelid AND ca.attnum=con.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid=con.confrelid AND pa.attnum=con.confkey[1]
    JOIN LATERAL (SELECT a.attname FROM pg_attribute a WHERE a.attrelid=con.confrelid AND a.attname IN ('org_id','organization_id') AND NOT a.attisdropped ORDER BY CASE a.attname WHEN 'org_id' THEN 0 ELSE 1 END LIMIT 1) porg ON true
    WHERE con.conrelid=r.oid AND con.contype='f' AND array_length(con.conkey,1)=1 AND ca.attnotnull
    ORDER BY CASE WHEN con.confdeltype='c' THEN 0 ELSE 1 END
    LIMIT 1;
    IF p.fk_col IS NULL THEN CONTINUE; END IF;

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS org_id text', r.relname);
    EXECUTE format('UPDATE %I c SET org_id = pp.%I FROM %I pp WHERE pp.%I = c.%I AND c.org_id IS NULL',
                   r.relname, p.parent_org, p.parent_table, p.parent_pk, p.fk_col);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_set_org_id ON %I', r.relname);
    EXECUTE format('CREATE TRIGGER trg_set_org_id BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent(%L,%L,%L,%L)',
                   r.relname, p.parent_table, p.parent_pk, p.parent_org, p.fk_col);
    EXECUTE format('SELECT count(*) FROM %I WHERE org_id IS NULL', r.relname) INTO nulls;
    IF nulls > 0 THEN CONTINUE; END IF;

    EXECUTE format('ALTER TABLE %I ALTER COLUMN org_id SET NOT NULL', r.relname);
    fkname := left(r.relname || '_org_id_fk', 63);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=fkname AND conrelid=r.oid) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE', r.relname, fkname);
    END IF;
    SELECT a.attname INTO pkcol
    FROM pg_constraint pc JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=pc.conkey[1]
    WHERE pc.conrelid=r.oid AND pc.contype='p' AND array_length(pc.conkey,1)=1 LIMIT 1;
    IF pkcol IS NOT NULL THEN
      ck := left('uniq_' || r.relname || '_org_id', 63);
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=ck AND conrelid=r.oid) THEN
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (org_id, %I)', r.relname, ck, pkcol);
      END IF;
    END IF;
  END LOOP;
END $$;
