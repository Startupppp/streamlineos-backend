SET statement_timeout = 0;
-- wave-4-phase-a-orgid-backfill.sql  (Wave 4 Phase A — denormalized tenant org_id)
-- Adds a SELF-MAINTAINING org_id to tenant line-item/junction tables that lacked one.
-- For every public table without org_id/organization_id that has a NOT-NULL single-column
-- FK to an org-bearing parent: add org_id, backfill it from that parent, install a
-- BEFORE INSERT trigger that auto-derives org_id from the parent (so NO service-code change
-- is needed and the column can safely be NOT NULL), then add NOT NULL + org FK +
-- (org_id, pk) candidate key. Global/platform tables (no org-bearing parent) are skipped.
-- Idempotent + re-runnable.
--
-- DETERMINISM — read before editing the DO block below.
--
-- This walk used to be a single unordered `FOR r IN SELECT ... FROM pg_class` pass, and a
-- table only qualified when its parent ALREADY carried org_id. Both halves of that are
-- order-dependent, so the schema this file produced was a function of heap order:
--
--   * a child visited before its parent saw a parent with no org_id, failed the test, and
--     was skipped forever — the pass never came back;
--   * a table with two eligible parents picked whichever the planner returned first.
--
-- Measured on two fresh databases at this same commit, same journal, same extensions:
-- one ended with 744 org_id-bearing tables, the other 743 (`workflow_actions` missing).
-- The failure mode is not a crash. Tenant isolation is keyed on org_id, so a table that
-- silently misses the column gets no trg_set_org_id and no tenant policy.
--
-- The fix has two parts, and BOTH are required:
--
--  1. TOTAL ORDER. Each pass materialises its whole work list with one query, one snapshot
--     and an explicit `ORDER BY` — including a total tiebreak on the parent-FK choice, so
--     two parents can never be resolved by planner luck.
--  2. FIXED POINT. Ordering alone does not fix it: a child sorted before its parent is
--     still missed on that pass. The block therefore repeats until a pass adds nothing, so
--     the result is the transitive closure however the rows come back. `added > 0` implies
--     at least one table gained org_id, and a table that has it is excluded from the next
--     pass, so the loop strictly decreases the candidate set and terminates.
--
-- `src/db/cold-build-integrity.spec.ts` fails if either property is removed from this file.

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
DECLARE r RECORD; batch jsonb; nulls int; fkname text; ck text; pkcol text;
        pass int := 0; added int;
BEGIN
  LOOP
    pass := pass + 1;

    -- One query, one snapshot, one total order: the work list for this pass and the parent
    -- chosen for each table are both fixed before a single ALTER runs.
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.relname), '[]'::jsonb) INTO batch
    FROM (
      SELECT c.relname::text AS relname,
             p.fk_col::text AS fk_col,
             p.parent_table::text AS parent_table,
             p.parent_pk::text AS parent_pk,
             p.parent_org::text AS parent_org
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
      -- pick a NOT-NULL single-col FK to an org-bearing parent (prefer the CASCADE/owning
      -- parent, then break every remaining tie by name so the choice is never planner luck)
      JOIN LATERAL (
        SELECT ca.attname AS fk_col, parent.relname AS parent_table, pa.attname AS parent_pk, porg.attname AS parent_org
        FROM pg_constraint con
        JOIN pg_class parent ON parent.oid=con.confrelid
        JOIN pg_attribute ca ON ca.attrelid=con.conrelid AND ca.attnum=con.conkey[1]
        JOIN pg_attribute pa ON pa.attrelid=con.confrelid AND pa.attnum=con.confkey[1]
        JOIN LATERAL (SELECT a.attname FROM pg_attribute a WHERE a.attrelid=con.confrelid AND a.attname IN ('org_id','organization_id') AND NOT a.attisdropped ORDER BY CASE a.attname WHEN 'org_id' THEN 0 ELSE 1 END, a.attname LIMIT 1) porg ON true
        WHERE con.conrelid=c.oid AND con.contype='f' AND array_length(con.conkey,1)=1 AND ca.attnotnull
        ORDER BY CASE WHEN con.confdeltype='c' THEN 0 ELSE 1 END, parent.relname, ca.attname, con.conname
        LIMIT 1
      ) p ON true
      WHERE c.relkind='r'
        AND NOT c.relispartition
        AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname IN ('org_id','organization_id') AND NOT a.attisdropped)
      ORDER BY c.relname
    ) t;

    added := 0;
    FOR r IN
      SELECT * FROM jsonb_to_recordset(batch)
        AS x(relname text, fk_col text, parent_table text, parent_pk text, parent_org text)
      ORDER BY relname
    LOOP
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS org_id text', r.relname);
      EXECUTE format('UPDATE %I c SET org_id = pp.%I FROM %I pp WHERE pp.%I = c.%I AND c.org_id IS NULL',
                     r.relname, r.parent_org, r.parent_table, r.parent_pk, r.fk_col);
      EXECUTE format('DROP TRIGGER IF EXISTS trg_set_org_id ON %I', r.relname);
      EXECUTE format('CREATE TRIGGER trg_set_org_id BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent(%L,%L,%L,%L)',
                     r.relname, r.parent_table, r.parent_pk, r.parent_org, r.fk_col);
      added := added + 1;

      EXECUTE format('SELECT count(*) FROM %I WHERE org_id IS NULL', r.relname) INTO nulls;
      IF nulls > 0 THEN CONTINUE; END IF;

      EXECUTE format('ALTER TABLE %I ALTER COLUMN org_id SET NOT NULL', r.relname);
      fkname := left(r.relname || '_org_id_fk', 63);
      IF NOT EXISTS (SELECT 1 FROM pg_constraint con JOIN pg_class cl ON cl.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace AND ns.nspname='public' WHERE con.conname=fkname AND cl.relname=r.relname) THEN
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE', r.relname, fkname);
      END IF;
      SELECT a.attname INTO pkcol
      FROM pg_constraint pc
      JOIN pg_class cl ON cl.oid=pc.conrelid
      JOIN pg_namespace ns ON ns.oid=cl.relnamespace AND ns.nspname='public'
      JOIN pg_attribute a ON a.attrelid=pc.conrelid AND a.attnum=pc.conkey[1]
      WHERE cl.relname=r.relname AND pc.contype='p' AND array_length(pc.conkey,1)=1
      ORDER BY pc.conname LIMIT 1;
      IF pkcol IS NOT NULL THEN
        ck := left('uniq_' || r.relname || '_org_id', 63);
        IF NOT EXISTS (SELECT 1 FROM pg_constraint con JOIN pg_class cl ON cl.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace AND ns.nspname='public' WHERE con.conname=ck AND cl.relname=r.relname) THEN
          EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (org_id, %I)', r.relname, ck, pkcol);
        END IF;
      END IF;
    END LOOP;

    EXIT WHEN added = 0;
    IF pass > 64 THEN
      RAISE EXCEPTION '0320: org_id closure did not converge after % passes', pass;
    END IF;
  END LOOP;
END $$;
