import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.types";
import { tickets } from "../../../../db/schema";
import type { AccessService } from "../../../access/access.service";
import { resolveProjectAccess } from "../project-access";
import { resolveTicketsScope, ticketScope } from "./tickets-scope";

export type TicketReadAccess = Pick<
  AccessService,
  "scopeFor" | "resolveUserPermissions"
>;

export async function assertTicketReadAccess(
  db: Db,
  access: TicketReadAccess,
  actor: CurrentUserContext,
  projectId: number,
  ticketId: number,
) {
  const read = await resolveTicketsScope(access, actor);
  const allowed = read.compose(
    { tenant: tickets.orgId, scope: ticketScope(read.orgId, read.actorId) },
    ({ sql: where }) => where,
    () => sql`false`,
  );
  const [ticket] = await db
    .select({
      id: tickets.id,
      allowed: sql<boolean>`${allowed}`,
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.orgId, actor.orgId),
        eq(tickets.projectId, projectId),
        eq(tickets.id, ticketId),
        isNull(tickets.deletedAt),
      ),
    )
    .limit(1);
  if (!ticket) throw new NotFoundException("Ticket not found");
  const projectAccess = await resolveProjectAccess(
    db,
    access,
    actor,
    projectId,
  );
  if (!projectAccess.hasAccess || !ticket.allowed)
    throw new ForbiddenException("Ticket is outside your access scope");
}
