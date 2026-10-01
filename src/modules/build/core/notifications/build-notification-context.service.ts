import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { organizationMembers, projectApprovals, projectReleases, projects, tickets, users } from "../../../../db/schema";
import { MembershipStateService } from "../../../../common/auth/membership-state.service";
import { accountableMembershipId, humanSessionPrincipal, type Principal } from "../../../../common/auth/principal";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { AccessService } from "../../../access/access.service";
import type { NotificationTicketContext } from "../../../notifications/notifications.types";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { resolveProjectReach, resolveTicketVisibility } from "../project-crud/project-access";

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
    const recipient = await this.recipient(orgId, userId, requestPrincipal);
    if (recipient === null) return new Map();
    const visible = await resolveTicketVisibility(this.access, recipient);

    const rows = await runInTenantTransaction(this.db, async (tx) => tx
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
      .where(and(visible, isNull(tickets.deletedAt), inArray(tickets.id, ids)))
      .limit(ids.length), { orgId });

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

  async canSeeRelease(orgId: string, userId: string, releaseId: number): Promise<boolean> {
    const recipient = await this.recipient(orgId, userId);
    if (recipient === null) return false;
    const reach = await resolveProjectReach(this.access, recipient);
    if (reach.empty) return false;
    const rows = await runInTenantTransaction(this.db, async (tx) => tx
      .select({ id: projectReleases.id })
      .from(projectReleases)
      .innerJoin(projects, and(eq(projects.id, projectReleases.projectId), eq(projects.orgId, projectReleases.orgId)))
      .where(and(
        eq(projectReleases.orgId, orgId), eq(projectReleases.id, releaseId),
        isNull(projectReleases.deletedAt), isNull(projects.deletedAt), reach.where,
      ))
      .limit(1), { orgId });
    return rows.length > 0;
  }

  async canSeeApproval(orgId: string, userId: string, approvalId: number): Promise<boolean> {
    const recipient = await this.recipient(orgId, userId);
    if (recipient === null) return false;
    const reach = await resolveProjectReach(this.access, recipient);
    const rows = await runInTenantTransaction(this.db, async (tx) => tx
      .select({ id: projectApprovals.id })
      .from(projectApprovals)
      .innerJoin(projects, and(eq(projects.id, projectApprovals.projectId), eq(projects.orgId, projectApprovals.orgId)))
      .where(and(
        eq(projectApprovals.orgId, orgId), eq(projectApprovals.id, approvalId),
        isNull(projectApprovals.deletedAt), isNull(projects.deletedAt),
        or(eq(projectApprovals.approverMembershipId, accountableMembershipId(recipient.principal) ?? -1), reach.where),
      ))
      .limit(1), { orgId });
    return rows.length > 0;
  }

  private async recipient(
    orgId: string,
    userId: string,
    requestPrincipal?: Principal,
  ): Promise<CurrentUserContext | null> {
    const state = await this.membership.resolve(userId, orgId);
    if (!state.active || state.membershipId === null) return null;
    if (requestPrincipal && accountableMembershipId(requestPrincipal) !== state.membershipId) return null;
    const principal = requestPrincipal
      ? requestPrincipal.kind === "human-session" || requestPrincipal.kind === "personal-token"
        ? { ...requestPrincipal, isOrgOwner: state.isOwner }
        : requestPrincipal
      : humanSessionPrincipal(state.membershipId, state.isOwner);
    return {
      userId, orgId, role: state.role, isOrgOwner: state.isOwner,
      sessionId: `notify:${userId}`, tokenScopes: null, principal,
    };
  }
}
