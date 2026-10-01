import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { systemJobCovers } from "../../../../common/auth/principal";
import type { AccessService } from "../../../access/access.service";
import { ScopedRead } from "../../../access/scoped-read";
import { TICKETS_PERMISSION } from "../lib/tickets-scope";

export const PROJECTS_MANAGE_PERMISSION = "build:manage";
export const PROJECTS_VIEW_PERMISSION = "build:view";

export function projectStanding(manage: ScopedRead, view: ScopedRead): ScopedRead {
  if (manage.unrestricted) return manage;
  if (manage.denied && view.denied) return ScopedRead.of(manage.orgId, manage.actorId, "none");
  return ScopedRead.of(manage.orgId, manage.actorId, "own");
}

export async function resolveProjectsScope(
  access: Pick<AccessService, "scopeFor">,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  if (u.principal.kind === "system-job") {
    const reaches =
      systemJobCovers(u.principal, PROJECTS_MANAGE_PERMISSION) ||
      systemJobCovers(u.principal, TICKETS_PERMISSION);
    return ScopedRead.of(u.orgId, u.userId, reaches ? "all" : "none");
  }
  const manage = await ScopedRead.for(access, u, PROJECTS_MANAGE_PERMISSION);
  if (manage.unrestricted) return manage;
  return projectStanding(manage, await ScopedRead.for(access, u, PROJECTS_VIEW_PERMISSION));
}
