# 2026-08-28 — Employment fields migrated off `users.*` (batch 3)

Ticket 13: third and last migrate batch of employment facts onto canonical `hr_employments` / `hr_people`.

## Changed endpoints / readers

| Module | File | Field(s) migrated |
|---|---|---|
| dashboard | `dashboard-leave.service.ts` `getLeavesToday` | `designation` |
| dashboard | `dashboard-hr.service.ts` `buildTeamAttendance` | `designation` |
| dashboard | `dashboard-hr.service.ts` `buildBirthdays` | `designation`, `joiningDate` |
| dashboard | `resignation-approval-scope.ts` `derivedApprover` predicate | `reportingTo` → `hr_reporting_lines` |
| notifications | `broadcasts.service.ts` `listInbox` | `orgDepartmentId` |
| notifications | `broadcasts.service.ts` `resolveRecipients` departments branch | `orgDepartmentId` |
| rbac | `roles.service.ts` `listSimulationCandidates` | `designation` |
| branches | `branches.service.ts` `getOne` employees WHERE | `branchId` → `locationId` |
| organization/hierarchy | `org-hierarchy-dependencies.service.ts` BRANCH `member_profiles` WHERE | `branchId` → `locationId` |
| organization/hierarchy | `org-hierarchy-dependencies.service.ts` DEPARTMENT `member_profiles` WHERE | `orgDepartmentId` → `departmentId` |

## Read strategy

Every reader now uses `COALESCE(hr_employments.<canonical>, users.<legacy>)` with LEFT JOINs through `hr_people` (matched on `org_id + user_id`, `deleted_at IS NULL`) and `hr_employments` (`isPrimary = true`, `deleted_at IS NULL`). Legacy column remains the fallback until data is fully migrated.

`resignation-approval-scope.ts` adds a correlated EXISTS subquery through `hr_reporting_lines → hr_employments → hr_people` as the canonical path and keeps `users.reporting_to = actorUserId` as an OR fallback.

## Response shapes

All API response shapes are unchanged — employment fields continue to be returned at the same keys; they are now resolved from the canonical source with legacy fallback.
