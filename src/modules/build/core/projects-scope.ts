import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";

export const PROJECTS_MANAGE_PERMISSION = "build:manage";

export async function resolveProjectsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  return access.scopeFor(u, PROJECTS_MANAGE_PERMISSION);
}
