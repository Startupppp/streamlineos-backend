-- 1052: make roster_entries' declared integrity real.
--
-- Three objects, one purpose: every one of them is about the
-- (org_id, user_membership_id, date) grain of roster_entries, and all three are
-- either assumed by running code or declared in Drizzle while absent from the
-- catalog. Verified against pg_indexes / pg_constraint on a database at journal
-- head as streamline_app (rolbypassrls = false), not inferred from the
-- declaration.
--
-- 1. THE NATURAL KEY. RostersService.upsertRosterEntry
--    (modules/hr/time/rosters.service.ts:41) issues
--    ON CONFLICT (roster_id, user_membership_id, date) DO UPDATE. No unique
--    index, unique constraint or primary key covers those columns in the
--    declaration OR the catalog, so Postgres has no arbiter to infer and the
--    statement fails at PLAN time with 42P10 -- on every call, for every
--    tenant, since the endpoint shipped. Reproduced, not reasoned about:
--
--      BEGIN; EXPLAIN INSERT INTO roster_entries (...) ON CONFLICT
--        (roster_id, user_membership_id, date) DO UPDATE SET notes = 'x'; ROLLBACK;
--      ERROR: there is no unique or exclusion constraint matching the
--             ON CONFLICT specification
--
--    Nothing tested this path at any level -- not a mocked spec, none at all.
--    A mocked spec could not have caught it regardless: ts-jest runs
--    isolatedModules and the error comes from the planner, so only a spec
--    against a real catalog can see it.
--
--    org_id LEADS the index. roster_entries is RLS-enabled (relrowsecurity = t,
--    policy tenant_isolation: org_id = current_org_id()), and backend/CLAUDE.md
--    section 7 makes org_id mandatory in a covering index on such a table --
--    the policy qual is not leakproof, so it is evaluated against the heap
--    tuple and the planner refuses an index that cannot supply org_id itself.
--    Section 3 independently requires per-org business keys to be composite.
--    The service's ON CONFLICT target is widened to match in the same commit;
--    inference requires the target list to equal the index columns exactly, so
--    adding org_id here without adding it there would swap one 42P10 for
--    another.
--
--    NOT PARTIAL, and NULLS stay DISTINCT, both deliberately. user_membership_id
--    is nullable and object 3 below nulls it when a membership is deleted, so a
--    departed member's roster rows become NULL-membership tombstones. Under the
--    default NULLS DISTINCT each tombstone stays its own row, which is correct.
--    NULLS NOT DISTINCT would collapse every departed member's row for one
--    (roster, date) into a single row and silently lose the rest. Keeping the
--    index total also means the ON CONFLICT site needs no arbiter predicate --
--    and note the API asymmetry that makes a partial index a trap here:
--    onConflictDoNothing takes { target, where } while only onConflictDoUpdate
--    takes targetWhere, so a targetWhere passed to the former is dropped in
--    silence and re-emits the identical broken SQL.
--
-- 2. THE SUPPORTING INDEX. index("idx_roster_entries_org_user_membership_date")
--    on (org_id, user_membership_id, date) is declared at
--    db/schema/hr/rosters.ts:36 and does not exist in the catalog. It is not
--    redundant against the unique index above: that one carries roster_id in
--    position two, so it cannot serve "what is this person rostered for", and a
--    narrow index under a wider one is not redundancy. It is also the
--    referencing side of the foreign key below, which every parent delete
--    probes.
--
-- 3. THE ACTOR FOREIGN KEY. foreignKey "fk_roster_entries_user_actor" on
--    (org_id, user_membership_id) -> organization_members (org_id, id)
--    ON DELETE SET NULL is declared at db/schema/hr/rosters.ts:37 and does not
--    exist in the catalog either. Without it a roster entry in org A can name a
--    membership in org B, and a deleted membership leaves a dangling pointer
--    rather than a NULL. The parent anchor it needs is already present
--    (uniq_org_members_org_id_key UNIQUE (org_id, id)), read from pg_constraint
--    before this file was written.
--
--    The SET NULL carries an EXPLICIT COLUMN LIST naming only the nullable
--    pointer. org_id is NOT NULL on this table, so a bare composite SET NULL
--    would try to null the tenant column and raise 23502 on every parent
--    delete -- the defect 0770 swept and 0992 repaired, and the shape 0607 and
--    0634 already use.
--
--    ADD CONSTRAINT ... NOT VALID then VALIDATE, per backend/CLAUDE.md section
--    3: ADD CONSTRAINT ... FOREIGN KEY takes ACCESS EXCLUSIVE on BOTH tables
--    while it installs triggers, so one long SELECT on organization_members
--    would stall every write to both.
--
-- ORPHAN REPAIR BEFORE THE KEY. Rows whose user_membership_id names a
-- membership that no longer exists are set to NULL first -- exactly what
-- ON DELETE SET NULL would have done had the constraint existed. This is a
-- repair, not a data decision: the pointer is already dangling and the FK
-- cannot validate around it. It runs BEFORE the unique index because nulling a
-- membership can only ever REDUCE collisions under NULLS DISTINCT, never
-- create one.
--
-- DUPLICATES: the migration REFUSES rather than de-duplicates. Choosing which
-- roster entry survives is a scheduling decision a migration must not make
-- silently, and the DO block names the offending tuples instead of letting
-- CREATE UNIQUE INDEX raise a bare 23505. Measured on a database at journal
-- head: roster_entries holds 0 rows in all 8 organizations, so there is nothing
-- to collide there -- consistent with an upsert that has never once succeeded.
--
-- CREATE INDEX rather than CONCURRENTLY: check-migration-discipline rule 7
-- fails on CREATE [UNIQUE] INDEX CONCURRENTLY with a ZERO baseline, because it
-- cannot run inside drizzle-kit migrate's transaction wrapper. lock_timeout
-- bounds the lock wait instead, failing fast rather than queueing behind a
-- reader and blocking every writer behind it.

SET lock_timeout = '5s';
--> statement-breakpoint

UPDATE "roster_entries" re
   SET "user_membership_id" = NULL
 WHERE re."user_membership_id" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM "organization_members" om
      WHERE om."org_id" = re."org_id"
        AND om."id" = re."user_membership_id"
   );
--> statement-breakpoint

DO $$
DECLARE
  duplicate_count integer;
  sample text;
BEGIN
  SELECT count(*), coalesce(string_agg(format('(%s, %s, %s, %s) x%s', d.org_id, d.roster_id, d.user_membership_id, d.date, d.n), '; '), '')
    INTO duplicate_count, sample
    FROM (
      SELECT org_id, roster_id, user_membership_id, date, count(*) AS n
        FROM roster_entries
       WHERE user_membership_id IS NOT NULL
       GROUP BY org_id, roster_id, user_membership_id, date
      HAVING count(*) > 1
       LIMIT 20
    ) d;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'roster_entries has % duplicated (org_id, roster_id, user_membership_id, date) tuple(s); uniq_roster_entries_org_roster_membership_date cannot be created until they are resolved. First tuples: %',
      duplicate_count, sample
      USING HINT = 'Decide which roster entry survives per tuple -- shift assignment, day-off flag and notes may differ -- before re-running this migration. Do not delete blindly.';
  END IF;
END
$$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_roster_entries_org_roster_membership_date"
  ON "roster_entries" ("org_id", "roster_id", "user_membership_id", "date");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_roster_entries_org_user_membership_date"
  ON "roster_entries" ("org_id", "user_membership_id", "date");
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_roster_entries_user_actor'
  ) THEN
    ALTER TABLE "roster_entries"
      ADD CONSTRAINT "fk_roster_entries_user_actor"
      FOREIGN KEY ("org_id", "user_membership_id")
      REFERENCES "organization_members" ("org_id", "id")
      ON DELETE SET NULL ("user_membership_id") NOT VALID;
  END IF;
END
$$;
--> statement-breakpoint

ALTER TABLE "roster_entries" VALIDATE CONSTRAINT "fk_roster_entries_user_actor";
