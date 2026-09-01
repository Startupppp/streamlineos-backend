-- @irreversible
-- 0907: VALIDATE NOT VALID FK constraints from migrations 0902-0906.
--
-- VALIDATE CONSTRAINT acquires ShareUpdateExclusiveLock (not ACCESS EXCLUSIVE), so it
-- can run while the table is still writable. It proves that every existing row satisfies
-- the FK before we can tighten to NOT NULL. Run after backfill is confirmed complete.
-- Each VALIDATE is a separate statement so a single failure doesn't abort the rest.

SET lock_timeout = '5s';

--> statement-breakpoint
-- Fail closed unless each legacy actor resolves to exactly one active membership
-- in the same organization and the stored membership pointer agrees with it.
DO $$
DECLARE spec record;
DECLARE invalid_count bigint;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('hr_wellness_checkins', 'user_id', 'user_membership_id'),
      ('hr_mood_checkins', 'user_id', 'user_membership_id'),
      ('hr_disciplinary_actions', 'employee_id', 'employee_membership_id'),
      ('hr_proxy_access', 'grantor_user_id', 'grantor_membership_id'),
      ('hr_proxy_access', 'proxy_user_id', 'proxy_membership_id'),
      ('recognitions', 'from_user_id', 'from_membership_id'),
      ('recognitions', 'to_user_id', 'to_membership_id'),
      ('hr_workflow_delegations', 'delegator_user_id', 'delegator_membership_id'),
      ('hr_workflow_delegations', 'delegate_user_id', 'delegate_membership_id'),
      ('hr_workflow_step_actions', 'acted_by_user_id', 'acted_by_membership_id')
    ) AS contract(table_name, legacy_column, membership_column)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I source WHERE
         (source.%I IS NOT NULL AND (
           (SELECT count(*) FROM organization_members member
             WHERE member.org_id = source.org_id
               AND member.user_id = source.%I
               AND member.status = ''ACTIVE'') <> 1
           OR source.%I IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM organization_members member
             WHERE member.org_id = source.org_id
               AND member.id = source.%I
               AND member.user_id = source.%I
               AND member.status = ''ACTIVE''
           )
         ))
         OR (source.%I IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM organization_members member
           WHERE member.org_id = source.org_id
             AND member.id = source.%I
             AND member.status = ''ACTIVE''
         ))',
      spec.table_name,
      spec.legacy_column, spec.legacy_column, spec.membership_column,
      spec.membership_column, spec.legacy_column,
      spec.membership_column, spec.membership_column
    ) INTO invalid_count;
    IF invalid_count > 0 THEN
      RAISE EXCEPTION '0907 blocked: %.% has % unmappable, duplicate, inactive, or cross-tenant actor row(s)',
        spec.table_name, spec.legacy_column, invalid_count;
    END IF;
  END LOOP;
END $$;

--> statement-breakpoint
ALTER TABLE "hr_wellness_checkins" VALIDATE CONSTRAINT "fk_hr_wellness_checkins_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_mood_checkins" VALIDATE CONSTRAINT "fk_hr_mood_checkins_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_disciplinary_actions" VALIDATE CONSTRAINT "fk_hr_disciplinary_actions_employee_actor";

--> statement-breakpoint
ALTER TABLE "hr_proxy_access" VALIDATE CONSTRAINT "fk_hr_proxy_access_grantor_actor";

--> statement-breakpoint
ALTER TABLE "hr_proxy_access" VALIDATE CONSTRAINT "fk_hr_proxy_access_proxy_actor";

--> statement-breakpoint
ALTER TABLE "recognitions" VALIDATE CONSTRAINT "fk_recognitions_from_actor";

--> statement-breakpoint
ALTER TABLE "recognitions" VALIDATE CONSTRAINT "fk_recognitions_to_actor";

--> statement-breakpoint
ALTER TABLE "hr_workflow_delegations" VALIDATE CONSTRAINT "fk_hr_workflow_delegations_delegator_actor";

--> statement-breakpoint
ALTER TABLE "hr_workflow_delegations" VALIDATE CONSTRAINT "fk_hr_workflow_delegations_delegate_actor";

--> statement-breakpoint
ALTER TABLE "hr_workflow_step_actions" VALIDATE CONSTRAINT "fk_hr_workflow_step_actions_acted_by_actor";
