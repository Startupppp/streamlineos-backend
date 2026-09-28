import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { organizationMembers, projects, tickets, users } from "../../../../db/schema";
import { MembershipStateService } from "../../../../common/auth/membership-state.service";
import { accountableMembershipId, humanSessionPrincipal, type Principal } from "../../../../common/auth/principal";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { AccessService } from "../../../access/access.service";
import type { NotificationTicketContext } from "../../../notifications/notifications.types";
import { resolveTicketsScope, ticketScope } from "../lib/tickets-scope";

@Injectable()
export class BuildNotificationContextService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly membership: MembershipStateService,
  ) {}

  async resolve(
    orgId: string,
    userId: string,
    ticketIds: readonly number[],
    requestPrincipal?: Principal,
  ): Promise<ReadonlyMap<number, NotificationTicketContext>> {
    const ids = [...new Set(ticketIds)];
    if (ids.length === 0) return new Map();
    if (ids.length > 100 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
      throw new Error("Ticket notification context must be a bounded page of valid ids");
    const state = await this.membership.resolve(userId, orgId);
    if (!state.active || state.membershipId === null) return new Map();
    if (requestPrincipal && accountableMembershipId(requestPrincipal) !== state.membershipId) return new Map();
    const principal = requestPrincipal
      ? requestPrincipal.kind === "human-session" || requestPrincipal.kind === "personal-token"
        ? { ...requestPrincipal, isOrgOwner: state.isOwner }
        : requestPrincipal
      : humanSessionPrincipal(state.membershipId, state.isOwner);
    const read = await resolveTicketsScope(this.access, {
      userId, orgId, role: state.role, isOrgOwner: state.isOwner,
      sessionId: `notify:${userId}`, tokenScopes: null,
      principal,
    });
    if (read.denied) return new Map();

    const rows = await read.read(
      {
        tenant: tickets.orgId,
        scope: ticketScope(read.orgId, read.actorId),
        and: [isNull(tickets.deletedAt), inArray(tickets.id, ids)],
      },
      ({ sql: where }) => runInTenantTransaction(this.db, async (tx) => tx
        .select({
          id: tickets.id, ticketNumber: tickets.ticketNumber, priority: tickets.priority,
          status: tickets.status, type: tickets.type, projectKey: projects.key,
          assigneeId: organizationMembers.userId, assigneeName: users.name,
          assigneeFirstName: users.firstName, assigneeLastName: users.lastName,
          assigneeImage: users.image,
        })
        .from(tickets)
        .innerJoin(projects, and(
          eq(projects.id, tickets.projectId), eq(projects.orgId, tickets.orgId), isNull(projects.deletedAt),
        ))
        .leftJoin(organizationMembers, and(
          eq(organizationMembers.orgId, tickets.orgId),
          eq(organizationMembers.id, tickets.assigneeMembershipId),
        ))
        .leftJoin(users, eq(users.id, organizationMembers.userId))
        .where(where)
        .limit(ids.length), { orgId }),
      () => [],
    );

    return new Map(rows.map((ticket) => [ticket.id, {
      ticketId: ticket.id,
      ticketKey: ticket.projectKey ? `${ticket.projectKey}-${ticket.ticketNumber}` : String(ticket.ticketNumber),
      priority: ticket.priority ?? null, status: ticket.status, type: ticket.type,
      assignee: ticket.assigneeId ? {
        id: ticket.assigneeId, name: ticket.assigneeName, firstName: ticket.assigneeFirstName,
        lastName: ticket.assigneeLastName, image: ticket.assigneeImage,
      } : null,
    }]));
  }
}
