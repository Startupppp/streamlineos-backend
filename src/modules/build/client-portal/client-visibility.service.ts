import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { projectMilestones, projects, ticketAttachments, ticketComments, tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";

@Injectable()
export class ClientVisibilityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async assertProject(orgId: string, projectId: number) {
    const p = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      columns: { id: true },
    });
    if (!p) throw new NotFoundException("Project not found");
  }

  async getVisibilitySummary(orgId: string, projectId: number) {
    await this.assertProject(orgId, projectId);
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
        .where(and(eq(tickets.orgId, orgId), eq(tickets.projectId, projectId)))
        .orderBy(tickets.ticketNumber),

      this.db
        .select({
          id: projectMilestones.id,
          name: projectMilestones.name,
          clientVisible: projectMilestones.clientVisible,
        })
        .from(projectMilestones)
        .where(and(eq(projectMilestones.orgId, orgId), eq(projectMilestones.projectId, projectId)))
        .orderBy(projectMilestones.id),
    ]);
    return { tickets: ticketList, milestones: milestoneList };
  }

  async toggleTicketVisibility(orgId: string, userId: string, projectId: number, ticketId: number, clientVisible: boolean) {
    const existing = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId), eq(tickets.projectId, projectId)),
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
      ))
      .where(and(eq(ticketComments.id, commentId), eq(ticketComments.orgId, orgId)))
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
