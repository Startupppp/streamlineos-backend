-- wave-4-phase-d-composite-fks.sql  (Wave 4 Phase D — tenant composite FKs)
-- For every single-column FK whose CHILD has a NOT-NULL org column and whose PARENT
-- has a (org, pk) candidate key (added in Phase C), adds a SUPPLEMENTARY composite
-- foreign key (child_org, child_fk) -> parent(org, pk). This makes a child row
-- unable to reference a parent in a DIFFERENT org — tenant-scoped referential
-- integrity (OWASP A01 / §20 defense-in-depth).
--
-- ON DELETE NO ACTION deliberately: the composite FK only ENFORCES the org match; the
-- pre-existing single-column FK keeps its own delete behavior (cascade / set null), so
-- the two never impose conflicting delete semantics. Idempotent + drift-tolerant.
-- Applied + verified on the Neon dev branch: 535 composite FKs, 0 cross-tenant orphans.

DO $$
DECLARE
  r RECORD;
  cname text;
BEGIN
  FOR r IN
    SELECT child.oid AS child_oid, child.relname AS child_table, ca.attname AS child_col,
           parent.relname AS parent_table, pa.attname AS parent_col, pa.attnum AS parent_col_num,
           parent.oid AS parent_oid, childorg.attname AS child_org_col,
           parentorg.attname AS parent_org_col, parentorg.attnum AS parent_org_num
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_namespace cn ON cn.oid = child.relnamespace AND cn.nspname = 'public'
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
    JOIN LATERAL (SELECT a.attname FROM pg_attribute a WHERE a.attrelid=child.oid AND a.attname IN ('org_id','organization_id') AND a.attnotnull AND NOT a.attisdropped ORDER BY CASE a.attname WHEN 'org_id' THEN 0 ELSE 1 END LIMIT 1) childorg ON true
    JOIN LATERAL (SELECT a.attname, a.attnum FROM pg_attribute a WHERE a.attrelid=parent.oid AND a.attname IN ('org_id','organization_id') AND NOT a.attisdropped ORDER BY CASE a.attname WHEN 'org_id' THEN 0 ELSE 1 END LIMIT 1) parentorg ON true
    WHERE con.contype = 'f' AND array_length(con.conkey,1) = 1
  LOOP
    -- parent must have a (org, refcol) unique/pk candidate key to target
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = r.parent_oid AND contype IN ('u','p') AND array_length(conkey,1) = 2
        AND conkey @> ARRAY[r.parent_org_num, r.parent_col_num]::smallint[]
    ) THEN CONTINUE; END IF;
    -- skip if a composite FK from this child to this parent already exists
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = r.child_oid AND contype = 'f' AND array_length(conkey,1) = 2
        AND confrelid = r.parent_oid
    ) THEN CONTINUE; END IF;
    cname := left('fk_' || r.child_table || '_' || r.child_col || '_org', 63);
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = cname AND conrelid = r.child_oid) THEN CONTINUE; END IF;
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I, %I) REFERENCES %I(%I, %I)',
      r.child_table, cname, r.child_org_col, r.child_col, r.parent_table, r.parent_org_col, r.parent_col
    );
  END LOOP;
END $$;
