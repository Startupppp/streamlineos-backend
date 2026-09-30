import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { AccessService } from "../../../access/access.service";
import { ScopedRead } from "../../../access/scoped-read";

export const PROJECTS_MANAGE_PERMISSION = "build:manage";
export const PROJECTS_VIEW_PERMISSION = "build:view";

export async function resolveProjectsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  const manage = await ScopedRead.for(access, u, PROJECTS_MANAGE_PERMISSION);
  if (manage.unrestricted) return manage;
  const view = await ScopedRead.for(access, u, PROJECTS_VIEW_PERMISSION);
  if (manage.denied && view.denied) return ScopedRead.of(u.orgId, u.userId, "none");
  return ScopedRead.of(u.orgId, u.userId, "own");
}
