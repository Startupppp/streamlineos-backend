import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { ScopedRead } from "../../access/scoped-read";

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
