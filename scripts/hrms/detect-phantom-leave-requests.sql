-- HRMS-E2E-012 — detect leave requests whose ownership does not add up.
--
-- READ-ONLY. It changes nothing and must stay that way: any cleanup of what it
-- finds needs an approved plan first (§9). Run it with
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/hrms/detect-phantom-leave-requests.sql
-- The whole file runs inside a READ ONLY transaction that is rolled back, so a
-- stray write fails instead of landing.
--
-- The live write path (`LeavesWriteService.create`) sets user_id,
-- user_membership_id and created_by_membership_id from the caller, all three for
-- the same person. A row that breaks that shape was written by something else —
-- a seed, an import, a hand-run script, or a membership later deleted — and is
-- what a manager sees as a request they never made. Each class is reported per
-- tenant with a count and up to five sample ids; nothing is joined across orgs.

BEGIN TRANSACTION READ ONLY;

WITH classified AS (
  SELECT lr.org_id, lr.id, lr.status, c.class
  FROM leave_requests lr
  LEFT JOIN organization_members owner_m
    ON owner_m.org_id = lr.org_id AND owner_m.id = lr.user_membership_id
  CROSS JOIN LATERAL (VALUES
    -- No membership: invisible to "My leaves" (which filters on the membership)
    -- but still listed to approvers.
    (CASE WHEN lr.user_membership_id IS NULL THEN 'no_owner_membership' END),
    -- The display identity and the tenant identity name different people.
    (CASE WHEN owner_m.id IS NOT NULL AND owner_m.user_id <> lr.user_id
          THEN 'user_id_disagrees_with_membership' END),
    -- The requester is not a member of the org the row lives in.
    (CASE WHEN NOT EXISTS (
            SELECT 1 FROM organization_members m
            WHERE m.org_id = lr.org_id AND m.user_id = lr.user_id)
          THEN 'requester_not_in_org' END),
    -- Created by someone other than its owner. The live path never does this.
    (CASE WHEN lr.created_by_membership_id IS NOT NULL
           AND lr.user_membership_id IS NOT NULL
           AND lr.created_by_membership_id <> lr.user_membership_id
          THEN 'created_by_someone_else' END),
    -- The requester is also the approver of record.
    (CASE WHEN lr.approver_membership_id IS NOT NULL
           AND lr.approver_membership_id = lr.user_membership_id
          THEN 'requester_is_approver' END)
  ) AS c(class)
  WHERE c.class IS NOT NULL
)
SELECT org_id,
       class,
       count(*)                                   AS rows,
       count(*) FILTER (WHERE status = 'PENDING') AS pending,
       (array_agg(id ORDER BY id))[1:5]           AS sample_ids
FROM classified
GROUP BY org_id, class
ORDER BY org_id, class;

ROLLBACK;
