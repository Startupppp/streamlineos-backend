-- 1046: finish the actor contraction on support_ticket_watchers.
--
-- 0865 added "user_membership_id", backfilled it and installed the composite tenant
-- foreign key; 0866 validated that key. The pair was then never contracted: the four
-- *_actor_drop migrations (0915/0916/0917/0918) do not name this table, and nothing in
-- migrations/ drops "user_id". The Drizzle declaration
-- (src/db/schema/support/support-workspace.ts) meanwhile stopped declaring "user_id" and
-- declares "user_membership_id" NOT NULL, so every insert omitted a column the database
-- still required: POST /support/:supportTicketId/follow raised 23502 and answered 500 for
-- every caller in every tenant. 73 tables sit in the same expanded state; this is the only
-- one whose declaration dropped the legacy column, which is why it is the only one failing.
--
-- @data-loss: a row whose (org_id, user_id) pair has no organization_members row cannot
-- carry a membership actor, so it is deleted rather than stranded. Those are watch
-- subscriptions held by people who are no longer members of the organisation; the composite
-- foreign key would reject them and "user_membership_id" cannot be made NOT NULL while they
-- exist. Measured before authoring: 0 such rows on scratch_perf_seed (0 rows in the table)
-- and 0 on scratch_t15_500d (1 row, mappable). A watch is re-creatable by following the
-- ticket again. The DELETE announces its count with RAISE NOTICE rather than running silent.
--
-- The legacy unique index uniq_support_ticket_watchers_ticket_user (ticket_id, user_id) and
-- the single-column foreign key support_ticket_watchers_user_id_users_id_fk go with the
-- column. Neither is declared in Drizzle; the membership equivalents
-- (uniq_support_ticket_watchers_ticket_membership, fk_support_ticket_watchers_user_actor)
-- are, and both already exist. User erasure still reaches these rows: users -> ON DELETE
-- CASCADE -> organization_members -> ON DELETE CASCADE -> support_ticket_watchers.

SET lock_timeout = '5s';
--> statement-breakpoint

UPDATE "support_ticket_watchers" w
SET "user_membership_id" = (
  SELECT om.id
  FROM "organization_members" om
  WHERE om.org_id = w.org_id AND om.user_id = w.user_id
  ORDER BY (om.status = 'ACTIVE') DESC, om.id DESC
  LIMIT 1
)
WHERE w."user_membership_id" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "organization_members" om
    WHERE om.org_id = w.org_id AND om.user_id = w.user_id
  );
--> statement-breakpoint

DO $$
DECLARE
  stranded integer;
BEGIN
  SELECT count(*) INTO stranded
  FROM public.support_ticket_watchers
  WHERE user_membership_id IS NULL;
  IF stranded > 0 THEN
    RAISE NOTICE '1046: deleting % support_ticket_watchers row(s) whose watcher is no longer a member of the organisation', stranded;
    DELETE FROM public.support_ticket_watchers WHERE user_membership_id IS NULL;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "support_ticket_watchers"
  ADD CONSTRAINT "ck_support_ticket_watchers_user_actor_nn"
  CHECK ("user_membership_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE "support_ticket_watchers"
  VALIDATE CONSTRAINT "ck_support_ticket_watchers_user_actor_nn";
--> statement-breakpoint

ALTER TABLE "support_ticket_watchers"
  ALTER COLUMN "user_membership_id" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "support_ticket_watchers"
  DROP CONSTRAINT "ck_support_ticket_watchers_user_actor_nn";
--> statement-breakpoint

DROP INDEX IF EXISTS "uniq_support_ticket_watchers_ticket_user";
--> statement-breakpoint

ALTER TABLE "support_ticket_watchers"
  DROP CONSTRAINT IF EXISTS "support_ticket_watchers_user_id_users_id_fk",
  DROP COLUMN IF EXISTS "user_id";
