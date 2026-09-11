-- 1051 — two RESTRICT foreign keys to organization_members that block member removal
--        outright become ON DELETE SET NULL with an explicit column list.
--
-- WHAT WAS WRONG. `MEMBERSHIP_ARTIFACTS` (src/modules/organization/core/membership-artifacts.ts)
-- rules both of these `onRemoval: "set-null"` and states, in prose, that the composite
-- foreign key already IS `ON DELETE SET NULL`. It is not. Measured against a database
-- bootstrapped to journal head 674 (`pg_constraint.confdeltype`):
--
--   performance_reviews.fk_performance_reviews_reviewer_actor   confdeltype = 'r'  (RESTRICT)
--   hr_mood_checkins.fk_hr_mood_checkins_user_actor             confdeltype = 'r'  (RESTRICT)
--
-- Nothing in the runtime reads MEMBERSHIP_ARTIFACTS — its only consumers are
-- verify-membership-revocation.ts, check-restrict-fks.mjs and four spec files — so the
-- inventory's ruling was never a mechanism. There is no code path in
-- org-member-departure.service.ts or org-membership-access-revocation.ts that clears
-- either pointer before the membership row is deleted. The result is that a member who
-- has ever reviewed someone, or logged one mood check-in, cannot be hard-deleted at all:
-- the delete raises 23503 naming the constraint.
--
-- WHY SET NULL IS SAFE HERE AND WAS NOT SAFE FOR calendar_events. Migration 0839 reverted
-- calendar_events to NO ACTION because `created_by_membership_id` is NOT NULL, and
-- `ON DELETE SET NULL` — with or without a column list — still has to write NULL into it,
-- which raises 23502. The column list restricts WHICH columns are nulled; it does not make
-- a NOT NULL column nullable. Both columns below are already NULLABLE, verified in the
-- catalog before this migration was written, so the same objection does not apply:
--
--   performance_reviews.reviewer_membership_id  attnotnull = false
--   hr_mood_checkins.user_membership_id         attnotnull = false
--
-- calendar_events is deliberately NOT touched here. Its column is NOT NULL by design and
-- `calendar-departed-actor.spec.ts` pins that ("departure must be a soft status change").
-- Changing it is a product decision about hard deletion and GDPR erasure, not a
-- reconciliation, and it belongs to the calendar territory.
--
-- WHY THE COLUMN LIST IS MANDATORY. `org_id` leads both composite keys and is NOT NULL.
-- A bare `ON DELETE SET NULL` nulls EVERY referencing column, so it would try to null
-- `org_id` and raise 23502 on every removal — the exact defect `check:set-null-column-lists`
-- exists for, and the one 0770/0923/0927 cycled through. `ON DELETE SET NULL (col)` is the
-- only correct form, and 488 foreign keys at head already carry one.
--
-- LOCKING. Per backend/CLAUDE.md §3, ADD CONSTRAINT ... FOREIGN KEY takes ACCESS EXCLUSIVE
-- on BOTH tables while it installs its triggers, so each is added NOT VALID and validated
-- separately. lock_timeout fails fast rather than queueing behind a long read.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "performance_reviews"
  DROP CONSTRAINT IF EXISTS "fk_performance_reviews_reviewer_actor";
--> statement-breakpoint

ALTER TABLE "performance_reviews"
  ADD CONSTRAINT "fk_performance_reviews_reviewer_actor"
  FOREIGN KEY ("org_id", "reviewer_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("reviewer_membership_id")
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "performance_reviews"
  VALIDATE CONSTRAINT "fk_performance_reviews_reviewer_actor";
--> statement-breakpoint

ALTER TABLE "hr_mood_checkins"
  DROP CONSTRAINT IF EXISTS "fk_hr_mood_checkins_user_actor";
--> statement-breakpoint

ALTER TABLE "hr_mood_checkins"
  ADD CONSTRAINT "fk_hr_mood_checkins_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "hr_mood_checkins"
  VALIDATE CONSTRAINT "fk_hr_mood_checkins_user_actor";
--> statement-breakpoint

-- Assert the catalog, not the exit code. `db:migrate` swallows errors, so a migration in
-- this repo proves nothing by completing; it has to read pg_catalog back. Both constraints
-- must be validated SET NULL with a column list naming exactly the actor column — never
-- org_id, which is what makes the difference between a working revoke and a 23502.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(r.relname || '.' || c.conname || ' confdeltype=' || c.confdeltype::text
                    || ' validated=' || c.convalidated::text
                    || ' setcols=' || coalesce(array_length(c.confdelsetcols, 1)::text, 'none'), ', ')
    INTO bad
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  WHERE c.conname IN ('fk_performance_reviews_reviewer_actor', 'fk_hr_mood_checkins_user_actor')
    AND c.contype = 'f'
    AND NOT (
      c.confdeltype = 'n'
      AND c.convalidated
      AND array_length(c.confdelsetcols, 1) = 1
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(c.confdelsetcols) k(attnum)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE a.attname = 'org_id' OR a.attnotnull
      )
    );

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '1051: foreign key not a validated SET NULL over a nullable non-org column: %', bad;
  END IF;

  IF (SELECT count(*) FROM pg_constraint
      WHERE conname IN ('fk_performance_reviews_reviewer_actor', 'fk_hr_mood_checkins_user_actor')
        AND contype = 'f') <> 2 THEN
    RAISE EXCEPTION '1051: expected both foreign keys to exist after this migration';
  END IF;
END $$;
