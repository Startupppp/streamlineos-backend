import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { AccessService } from "../../../access/access.service";
import { ScopedRead } from "../../../access/scoped-read";

export const PROJECTS_MANAGE_PERMISSION = "build:manage";

export async function resolveProjectsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.for(access, u, PROJECTS_MANAGE_PERMISSION);
}
