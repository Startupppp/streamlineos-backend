import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";

export const TIMESHEETS_VIEW_PERMISSION = "build:timesheets:view";
export const TIMESHEETS_MANAGE_PERMISSION = "build:timesheets:manage";

export async function resolveTimesheetsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  const manageScope = await access.scopeFor(u, TIMESHEETS_MANAGE_PERMISSION);
  if (manageScope !== "none") return manageScope;
  if (await access.holds(u, TIMESHEETS_VIEW_PERMISSION)) return "own";
  return "none";
}
