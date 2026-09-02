import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { projectMilestones, ticketAttachments, ticketComments, tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertProjectAccess } from "../core/project-access";

@Injectable()
export class ClientVisibilityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async getVisibilitySummary(u: CurrentUserContext, projectId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const orgId = u.orgId;
    const [ticketList, milestoneList] = await Promise.all([
      this.db
        .select({
          id: tickets.id,
          ticketNumber: tickets.ticketNumber,
          title: tickets.title,
          type: tickets.type,
          clientVisible: tickets.clientVisible,
        })
        .from(tickets)
        .where(and(eq(tickets.orgId, orgId), eq(tickets.projectId, projectId), isNull(tickets.deletedAt)))
        .orderBy(tickets.ticketNumber)
        .limit(500),

      this.db
        .select({
          id: projectMilestones.id,
          name: projectMilestones.name,
          clientVisible: projectMilestones.clientVisible,
        })
        .from(projectMilestones)
        .where(and(eq(projectMilestones.orgId, orgId), eq(projectMilestones.projectId, projectId), isNull(projectMilestones.deletedAt)))
        .orderBy(projectMilestones.id)
        .limit(200),
    ]);
    return { tickets: ticketList, milestones: milestoneList };
  }

  async toggleTicketVisibility(orgId: string, userId: string, projectId: number, ticketId: number, clientVisible: boolean) {
    const existing = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId), eq(tickets.projectId, projectId), isNull(tickets.deletedAt)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Ticket not found");
    await this.db
      .update(tickets)
      .set({ clientVisible })
      .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)));
    this.audit.log({
      action: "client_visibility.changed",
      userId,
      orgId,
      resourceType: "ticket",
      resourceId: String(ticketId),
      metadata: { ticketId, projectId, clientVisible },
    });
    return { id: ticketId, clientVisible };
  }

  async toggleMilestoneVisibility(orgId: string, userId: string, projectId: number, milestoneId: number, clientVisible: boolean) {
    const existing = await this.db.query.projectMilestones.findFirst({
      where: and(
        eq(projectMilestones.id, milestoneId),
        eq(projectMilestones.orgId, orgId),
        eq(projectMilestones.projectId, projectId),
        isNull(projectMilestones.deletedAt),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Milestone not found");
    await this.db
      .update(projectMilestones)
      .set({ clientVisible })
      .where(and(eq(projectMilestones.id, milestoneId), eq(projectMilestones.orgId, orgId)));
    this.audit.log({
      action: "client_visibility.changed",
      userId,
      orgId,
      resourceType: "milestone",
      resourceId: String(milestoneId),
      metadata: { milestoneId, projectId, clientVisible },
    });
    return { id: milestoneId, clientVisible };
  }

  async toggleCommentVisibility(orgId: string, userId: string, projectId: number, commentId: number, clientVisible: boolean) {
    const [row] = await this.db
      .select({ id: ticketComments.id })
      .from(ticketComments)
      .innerJoin(tickets, and(
        eq(tickets.id, ticketComments.ticketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
      ))
      .where(and(eq(ticketComments.id, commentId), eq(ticketComments.orgId, orgId), isNull(ticketComments.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException("Comment not found");
    await this.db
      .update(ticketComments)
      .set({ clientVisible })
      .where(and(eq(ticketComments.id, commentId), eq(ticketComments.orgId, orgId)));
    this.audit.log({
      action: "client_visibility.changed",
      userId,
      orgId,
      resourceType: "ticket_comment",
      resourceId: String(commentId),
      metadata: { commentId, projectId, clientVisible },
    });
    return { id: commentId, clientVisible };
  }

  async toggleAttachmentVisibility(orgId: string, userId: string, projectId: number, attachmentId: number, clientVisible: boolean) {
    const [row] = await this.db
      .select({ id: ticketAttachments.id })
      .from(ticketAttachments)
      .innerJoin(tickets, and(
        eq(tickets.id, ticketAttachments.ticketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
      ))
      .where(and(eq(ticketAttachments.id, attachmentId), eq(ticketAttachments.orgId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundException("Attachment not found");
    await this.db
      .update(ticketAttachments)
      .set({ clientVisible })
      .where(and(eq(ticketAttachments.id, attachmentId), eq(ticketAttachments.orgId, orgId)));
    this.audit.log({
      action: "client_visibility.changed",
      userId,
      orgId,
      resourceType: "ticket_attachment",
      resourceId: String(attachmentId),
      metadata: { attachmentId, projectId, clientVisible },
    });
    return { id: attachmentId, clientVisible };
  }
}
