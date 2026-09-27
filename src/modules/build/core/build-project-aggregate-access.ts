import { ForbiddenException } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { systemJobCovers } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.types";
import type { AccessService } from "../../access/access.service";
import { assertProjectInOrg, resolveProjectAccess } from "./project-crud/project-access";
import { ticketsScopeIsUnrestricted } from "./tickets/tickets-scope";

export async function assertProjectAggregateAccess(db: Db, access: AccessService, actor: CurrentUserContext, projectId: number): Promise<void> {
  if (actor.principal.kind === "system-job") {
    if (!systemJobCovers(actor.principal, "build:manage")) throw new ForbiddenException("Job cannot read project aggregates");
    await assertProjectInOrg(db, actor.orgId, projectId);
    return;
  }
  const project = await resolveProjectAccess(db, access, actor, projectId);
  if (!project.hasAccess) throw new ForbiddenException("Not authorized to view this project");
  if (!(await ticketsScopeIsUnrestricted(access, actor)))
    throw new ForbiddenException("Project-wide reports require access to all project tickets");
}
