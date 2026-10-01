import { sql, type Column, type SQL } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { projects, timesheets } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { ScopedRead } from "../../access/scoped-read";
import { resolveProjectReach } from "../core/project-crud/project-access";

export const TIMESHEETS_VIEW_PERMISSION = "build:timesheets:view";
export const TIMESHEETS_MANAGE_PERMISSION = "build:timesheets:manage";

export async function resolveTimesheetsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  const manageScope = await access.scopeFor(u, TIMESHEETS_MANAGE_PERMISSION);
  if (manageScope !== "none") return ScopedRead.of(u.orgId, u.userId, manageScope);
  if (await access.holds(u, TIMESHEETS_VIEW_PERMISSION)) return ScopedRead.of(u.orgId, u.userId, "own");
  return ScopedRead.of(u.orgId, u.userId, "none");
}

export async function timesheetProjectReachSql(
  access: AccessService,
  u: CurrentUserContext,
  projectColumn: Column = timesheets.projectId,
): Promise<SQL> {
  const reach = await resolveProjectReach(access, u);
  const membershipId = actingMembershipId(u.principal);
  const ownEntry = membershipId === null ? sql`false` : sql`${timesheets.userMembershipId} = ${membershipId}`;
  return sql`(${ownEntry} OR ${projectColumn} IS NULL OR ${projectColumn} IN (SELECT ${projects.id} FROM ${projects} WHERE ${projects.orgId} = ${u.orgId} AND ${reach.where}))`;
}
