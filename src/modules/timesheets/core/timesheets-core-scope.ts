import { eq, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  hrEmployments,
  hrPeople,
  hrReportingLines,
  organizationMembers,
  timesheetPeriods,
} from "../../../db/schema";
import { orgBusinessDateSql } from "../../directory/employment-query";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ScopedRead, type OwnershipScope } from "../../access/scoped-read";
import { AccessService } from "../../access/access.service";

export const TS_ENTRIES_VIEW_PERMISSION = "timesheets:entries:view";
export const TS_TEAM_VIEW_PERMISSION = "timesheets:team:view";
export const TS_APPROVALS_VIEW_PERMISSION = "timesheets:approvals:view";
export const TS_APPROVALS_MANAGE_PERMISSION = "timesheets:approvals:manage";
export const TS_REPORTS_VIEW_PERMISSION = "timesheets:reports:view";
export const TS_PAYROLL_VIEW_PERMISSION = "timesheets:payroll:view";

export async function resolveEntriesScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  const [own, widened] = await Promise.all([
    ScopedRead.for(access, u, TS_ENTRIES_VIEW_PERMISSION),
    ScopedRead.for(access, u, TS_TEAM_VIEW_PERMISSION),
  ]);
  return ScopedRead.broadest(own, widened);
}

export async function resolveApprovalScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.for(access, u, TS_APPROVALS_VIEW_PERMISSION);
}

/**
 * Team visibility must come from the team key the team controller gates on.
 * Deriving it from `timesheets:reports:view` leaked coworkers' hours whenever
 * the reports grant was wider than the team grant, and emptied the team
 * surface for a principal who held team:view without reports:view.
 */
export async function resolveTeamScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.for(access, u, TS_TEAM_VIEW_PERMISSION);
}

export async function resolveReportsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.for(access, u, TS_REPORTS_VIEW_PERMISSION);
}

export async function resolvePayrollScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.for(access, u, TS_PAYROLL_VIEW_PERMISSION);
}

export async function resolveRatePreviewSubject(
  access: AccessService,
  u: CurrentUserContext,
  requestedUserId: string | undefined,
): Promise<string | undefined> {
  if (!requestedUserId || requestedUserId === u.userId) return requestedUserId;
  const read = await resolveEntriesScope(access, u);
  return read.unrestricted ? requestedUserId : u.userId;
}

export function membershipScope(membershipId: number | null, ownerColumn: PgColumn): OwnershipScope {
  return { own: membershipId !== null ? eq(ownerColumn, membershipId) : sql`false` };
}

/**
 * Own rows plus the rows of everyone who currently reports to the actor.
 *
 * Timesheet tables key ownership on an `organization_members.id`, while the HR
 * reporting graph keys on `hr_people.user_id`, so the subquery bridges the two
 * through `organization_members` (`rm`) before it can compare an owner column to
 * a reporting line.
 *
 * Deliberately a separate helper rather than a `team` arm on `membershipScope`:
 * `membershipScope` is also imported by `modules/build`, whose resolver can hand
 * it a `team` scope from `build:timesheets:manage`. Widening the shared helper
 * would change that module's rows as a side effect, so a team arm is opted into
 * per call site instead.
 *
 * Raw aliases are written into the template on purpose. Drizzle's `alias()`
 * renders only the alias inside a `sql` fragment, never the table it stands for.
 */
export function membershipTeamScope(
  orgId: string,
  actorUserId: string,
  membershipId: number | null,
  ownerColumn: PgColumn,
): OwnershipScope {
  const base = membershipScope(membershipId, ownerColumn);
  if (membershipId === null) return base;

  const directReportRow = sql`EXISTS (
    SELECT 1
    FROM ${hrReportingLines} rl
    INNER JOIN ${hrEmployments} me ON me.id = rl.manager_employment_id
      AND me.org_id = ${orgId} AND me.is_primary = true AND me.deleted_at IS NULL
    INNER JOIN ${hrPeople} mp ON mp.id = me.person_id
      AND mp.org_id = ${orgId} AND mp.deleted_at IS NULL AND mp.user_id = ${actorUserId}
    INNER JOIN ${hrEmployments} ee ON ee.id = rl.employment_id
      AND ee.org_id = ${orgId} AND ee.is_primary = true AND ee.deleted_at IS NULL
    INNER JOIN ${hrPeople} ep ON ep.id = ee.person_id
      AND ep.org_id = ${orgId} AND ep.deleted_at IS NULL
    INNER JOIN ${organizationMembers} rm ON rm.org_id = ${orgId}
      AND rm.user_id = ep.user_id AND rm.id = ${ownerColumn}
    WHERE rl.org_id = ${orgId}
      AND rl.line_type = 'primary'
      AND rl.effective_from <= ${orgBusinessDateSql(orgId)}
      AND rl.effective_to >= ${orgBusinessDateSql(orgId)}
  )`;

  return { own: base.own, team: or(base.own, directReportRow) ?? base.own };
}

export function approvalQueueScope(membershipId: number | null): OwnershipScope {
  if (membershipId === null) return { own: sql`false` };
  return {
    own: or(eq(timesheetPeriods.userMembershipId, membershipId), eq(timesheetPeriods.currentApproverMembershipId, membershipId)) ?? sql`false`,
  };
}

/**
 * Everything `timesheets:approvals:view` reaches, at whichever scope it is held.
 *
 * The overdue queue lists unsettled periods, which are generally unsubmitted and
 * so carry no `current_approver_membership_id` at all: `approvalQueueScope`
 * alone matches none of them, and the queue reaches a team-scoped holder's
 * direct reports through the reporting graph instead. Both predicates therefore
 * belong to this one key, and composing them here is what keeps the queue's rows
 * and the single-period read from disagreeing.
 *
 * The `own` arm is `approvalQueueScope`'s, unchanged, so an `own`-scoped holder -
 * which is what `MANAGER_AUTHORITY_GRANTS` hands a reporting manager - gains
 * nothing from the team arm.
 */
export function approvalQueueTeamScope(
  orgId: string,
  actorUserId: string,
  membershipId: number | null,
): OwnershipScope {
  const queue = approvalQueueScope(membershipId);
  const { team } = membershipTeamScope(orgId, actorUserId, membershipId, timesheetPeriods.userMembershipId);
  if (!team) return queue;
  return { own: queue.own, team: or(team, queue.own) ?? queue.own };
}
