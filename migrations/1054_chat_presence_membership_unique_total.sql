-- 1054 — uniq_chat_presence_org_membership becomes TOTAL, so `ON CONFLICT
--        (org_id, membership_id)` can infer it again and chat presence writes stop
--        raising 42P10.
--
-- WHAT WAS WRONG. src/db/schema/chat/chat-huddle-tables.ts:27 declares
--
--   uniqueIndex("uniq_chat_presence_org_membership").on(table.orgId, table.membershipId)
--
-- with no predicate. The only journalled statement that ever created it — 0713 —
-- created it PARTIAL:
--
--   CREATE UNIQUE INDEX IF NOT EXISTS uniq_chat_presence_org_membership
--     ON chat_user_presence (org_id, membership_id)
--     WHERE membership_id IS NOT NULL;
--
-- Measured on a database bootstrapped to journal head 677:
--
--   uniq_chat_presence_org_membership   indpred = (membership_id IS NOT NULL)
--
-- Both production presence upserts trust the declaration and name the two columns
-- with no arbiter predicate — ChatPresenceService.heartbeat (chat-presence.service.ts:39)
-- and .setStatus (:71). Postgres cannot infer a partial index from a bare target, so
-- both statements fail at PLAN time with SQLSTATE 42P10, "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification". Plan time is what
-- makes this total: no colliding row, no client key, no concurrency and no data of
-- any kind is needed. POST /chat/presence/heartbeat and PUT /chat/status returned
-- 500 for every authenticated caller with an ACTIVE membership, in every tenant,
-- since 0713. Reproduced by running the real service against head: 42P10.
--
-- This is the same defect class as uniq_chat_messages_client_key, fixed for
-- chat_messages in 08b9274c4; that commit did not touch presence, and
-- check:conflict-targets did not catch this one because it judges partiality from
-- the DRIZZLE DECLARATION, which says total. Declaration-versus-catalog drift is
-- that gate's blind spot.
--
-- WHY THE CATALOG IS THE WRONG SIDE, NOT THE CALL SITES. The predicate constrains
-- nothing, twice over:
--
--   1. Migration 0762 set chat_user_presence.membership_id NOT NULL, and the
--      catalog still agrees (pg_attribute.attnotnull = 't'). No row can fail the
--      predicate, so the partial index already covers the whole table.
--
--   2. Even where the column were nullable, a UNIQUE btree over a key that
--      CONTAINS that column enforces exactly the same thing partial or total: a
--      row with NULL membership_id has a NULL in the key and NULL keys never
--      collide. `WHERE membership_id IS NOT NULL` on this index is definitionally
--      a no-op as a constraint.
--
-- So the partial and total forms are indistinguishable as constraints and differ
-- only in whether ON CONFLICT can find them. Rebuilding it total costs no
-- enforcement and no behaviour; it makes the catalog say what the declaration
-- already says, and it keeps check:conflict-targets honest about this call site
-- instead of leaving it judging a declaration the database does not implement.
-- Adding a vacuous `targetWhere` at the two call sites would have been the other
-- half of the same drift: the declaration would still be lying, and it would have
-- to be changed to .where(...) to stop lying, which weakens the index for no gain.
--
-- DROP THEN CREATE, NOT CREATE/DROP/RENAME. drizzle-kit migrate wraps the file in
-- one transaction (check-migration-discipline rule 7), and DROP INDEX takes ACCESS
-- EXCLUSIVE on chat_user_presence, so from the drop until COMMIT no other session
-- can write the table. There is no window in which uniqueness is unenforced and a
-- concurrent writer exists to exploit it, and if anything below fails the whole
-- file rolls back with the old index intact.
--
-- CREATE INDEX rather than CONCURRENTLY: CONCURRENTLY cannot run inside that
-- transaction wrapper. lock_timeout bounds the lock wait instead. The table holds
-- at most one row per active member per organisation, so the build is trivial.

SET lock_timeout = '5s';
--> statement-breakpoint

-- Refuse rather than guess if the premise above is false on this database. A
-- nullable membership_id with NULL rows present would still be safe (NULL keys do
-- not collide), but it would mean 0762 did not take here and that is worth
-- knowing before the index is rebuilt.
DO $$
DECLARE
  is_not_null boolean;
  null_rows bigint;
BEGIN
  SELECT a.attnotnull INTO is_not_null
    FROM pg_attribute a
   WHERE a.attrelid = 'chat_user_presence'::regclass
     AND a.attname = 'membership_id'
     AND NOT a.attisdropped;

  IF is_not_null IS NULL THEN
    RAISE EXCEPTION '1054: chat_user_presence.membership_id does not exist';
  END IF;

  IF NOT is_not_null THEN
    SELECT count(*) INTO null_rows FROM chat_user_presence WHERE membership_id IS NULL;
    RAISE EXCEPTION
      '1054: chat_user_presence.membership_id is nullable (% row(s) NULL); migration 0762 has not taken on this database',
      null_rows
      USING HINT = 'Apply 0762_chat_presence_membership_not_null before this migration.';
  END IF;
END
$$;
--> statement-breakpoint

DROP INDEX IF EXISTS "uniq_chat_presence_org_membership";
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_chat_presence_org_membership"
  ON "chat_user_presence" ("org_id", "membership_id");
--> statement-breakpoint

-- Read the catalog back rather than trusting completion: db:migrate reports success
-- over a statement that did nothing, and IF EXISTS / IF NOT EXISTS hide a no-op.
DO $$
DECLARE
  predicate text;
  is_unique boolean;
  is_valid boolean;
BEGIN
  SELECT pg_get_expr(x.indpred, x.indrelid), x.indisunique, x.indisvalid
    INTO predicate, is_unique, is_valid
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'uniq_chat_presence_org_membership'
     AND x.indrelid = 'chat_user_presence'::regclass;

  IF is_unique IS NULL THEN
    RAISE EXCEPTION '1054: uniq_chat_presence_org_membership does not exist after this migration';
  END IF;
  IF predicate IS NOT NULL THEN
    RAISE EXCEPTION '1054: uniq_chat_presence_org_membership is still partial (indpred = %)', predicate;
  END IF;
  IF NOT is_unique OR NOT is_valid THEN
    RAISE EXCEPTION '1054: uniq_chat_presence_org_membership unique=% valid=% (expected true / true)',
      is_unique, is_valid;
  END IF;
END
$$;
