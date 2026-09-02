-- ON DELETE SET NULL can only ever write NULL. Where the columns it writes are
-- declared non-nullable the referential action is unreachable: the parent delete
-- raises 23502 instead of doing anything useful, and org-member-departure surfaces
-- it as a 500 because that is not a foreign-key error code.
--
-- 0770 swept this class once and failed closed at the moment it ran. 0923 and 0927
-- reintroduced it afterwards (7 composite actor foreign keys with no column list),
-- and 0916 converted 0865's correct support_tickets column list into a defect by
-- making the single column it names non-nullable. This migration repairs the
-- residue and re-derives every column list from pg_attribute at run time, so a
-- list authored earlier cannot go stale again inside this file.
--
-- Two constraints have no nullable member at all, so no column list can rescue
-- them and the delete action itself has to change. Both become NO ACTION, the
-- ruling 0839 already applied to calendar_events: the parent delete is refused
-- with 23503, which the departure path can classify and explain, rather than
-- attempting a write the table forbids.
--
--   support_tickets.fk_support_tickets_created_actor — 0916 dropped the legacy
--   created_by user column, so created_by_membership_id is the only creator
--   identity the row has; nulling it would erase the author, not preserve them.
--
--   hr_safety_incidents_reported_by_users_id_fk — reported_by is the reporter of
--   a safety incident and is non-nullable by design.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE support_tickets
  DROP CONSTRAINT IF EXISTS fk_support_tickets_created_actor;
--> statement-breakpoint

ALTER TABLE support_tickets
  ADD CONSTRAINT fk_support_tickets_created_actor
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members (org_id, id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE support_tickets VALIDATE CONSTRAINT fk_support_tickets_created_actor;
--> statement-breakpoint

ALTER TABLE hr_safety_incidents
  DROP CONSTRAINT IF EXISTS hr_safety_incidents_reported_by_users_id_fk;
--> statement-breakpoint

ALTER TABLE hr_safety_incidents
  ADD CONSTRAINT hr_safety_incidents_reported_by_users_id_fk
  FOREIGN KEY (reported_by)
  REFERENCES users (id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE hr_safety_incidents VALIDATE CONSTRAINT hr_safety_incidents_reported_by_users_id_fk;
--> statement-breakpoint

DO $$
DECLARE
  r record;
  nullable_cols text;
  new_def text;
  fixed integer := 0;
  remaining integer;
  offenders text;
BEGIN
  FOR r IN
    SELECT nsp.nspname AS sch,
           rel.relname AS tbl,
           con.conname AS name,
           pg_get_constraintdef(con.oid) AS def,
           con.conrelid AS relid,
           con.conkey AS keycols
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE con.contype = 'f'
      AND con.confdeltype = 'n'
      AND EXISTS (
        SELECT 1
        FROM unnest(COALESCE(con.confdelsetcols, con.conkey)) z(attnum)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = z.attnum
        WHERE a.attnotnull
      )
    ORDER BY nsp.nspname, rel.relname, con.conname
  LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY x.ord)
      INTO nullable_cols
      FROM unnest(r.keycols) WITH ORDINALITY x(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = r.relid AND a.attnum = x.attnum
     WHERE NOT a.attnotnull;

    IF nullable_cols IS NULL THEN
      RAISE EXCEPTION
        '0992: %.% constraint % has no nullable member — ON DELETE SET NULL is unreachable and the delete action must change explicitly',
        r.sch, r.tbl, r.name;
    END IF;

    new_def := regexp_replace(
      r.def,
      'ON DELETE SET NULL(\s*\([^)]*\))?',
      'ON DELETE SET NULL (' || nullable_cols || ')'
    );

    IF new_def = r.def THEN
      RAISE EXCEPTION '0992: unexpected definition for %.% constraint %: %', r.sch, r.tbl, r.name, r.def;
    END IF;

    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', r.sch, r.tbl, r.name);
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s NOT VALID', r.sch, r.tbl, r.name, new_def);
    EXECUTE format('ALTER TABLE %I.%I VALIDATE CONSTRAINT %I', r.sch, r.tbl, r.name);
    fixed := fixed + 1;
  END LOOP;

  SELECT count(*), string_agg(rel.relname || '.' || con.conname, ', ')
    INTO remaining, offenders
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE con.contype = 'f'
    AND con.confdeltype = 'n'
    AND EXISTS (
      SELECT 1
      FROM unnest(COALESCE(con.confdelsetcols, con.conkey)) z(attnum)
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = z.attnum
      WHERE a.attnotnull
    );

  IF remaining > 0 THEN
    RAISE EXCEPTION '0992: % ON DELETE SET NULL foreign key(s) still write a non-nullable column: %', remaining, offenders;
  END IF;

  RAISE NOTICE '0992: rebuilt % SET NULL foreign key(s) with an explicit nullable-only column list', fixed;
END $$;
