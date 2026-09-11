-- 0851: VALIDATE NOT VALID FK constraints from migrations 0845-0850.
--
-- VALIDATE CONSTRAINT acquires ShareUpdateExclusiveLock (not ACCESS EXCLUSIVE), so it
-- can run while the table is still writable. It proves that every existing row satisfies
-- the FK before we can tighten to NOT NULL. Run after backfill is confirmed complete.
-- Each VALIDATE is a separate statement so a single failure doesn't abort the rest.

SET lock_timeout = '5s';

--> statement-breakpoint
-- A membership is authoritative only when exactly one active membership in the
-- row's organization resolves the legacy user.  This catches stale, duplicate,
-- and cross-tenant pointers before FK validation can make a partial backfill
-- appear successful.
DO $$
DECLARE spec record;
DECLARE invalid_count bigint;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('leave_requests', 'user_id', 'user_membership_id'),
      ('leave_requests', 'covering_employee_id', 'covering_employee_membership_id'),
      ('wfh_requests', 'user_id', 'user_membership_id'),
      ('hr_attendance_regularizations', 'user_id', 'user_membership_id'),
      ('documents', 'user_id', 'user_membership_id'),
      ('hr_cases', 'assigned_to', 'assigned_to_membership_id'),
      ('hr_cases', 'reported_by', 'reported_by_membership_id'),
      ('resignations', 'user_id', 'user_membership_id')
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
      RAISE EXCEPTION '0851 blocked: %.% has % unmappable, duplicate, inactive, or cross-tenant actor row(s)',
        spec.table_name, spec.legacy_column, invalid_count;
    END IF;
  END LOOP;
END $$;

--> statement-breakpoint
ALTER TABLE "leave_requests" VALIDATE CONSTRAINT "fk_leave_requests_user_actor";

--> statement-breakpoint
ALTER TABLE "leave_requests" VALIDATE CONSTRAINT "fk_leave_requests_covering_actor";

--> statement-breakpoint
ALTER TABLE "wfh_requests" VALIDATE CONSTRAINT "fk_wfh_requests_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations" VALIDATE CONSTRAINT "fk_hr_attendance_regularizations_user_actor";

--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "fk_documents_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_cases" VALIDATE CONSTRAINT "fk_hr_cases_assigned_to_actor";

--> statement-breakpoint
ALTER TABLE "hr_cases" VALIDATE CONSTRAINT "fk_hr_cases_reported_by_actor";

--> statement-breakpoint
ALTER TABLE "resignations" VALIDATE CONSTRAINT "fk_resignations_user_actor";
