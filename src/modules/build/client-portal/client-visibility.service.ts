import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import { projectMilestones, ticketAttachments, ticketComments, tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertProjectAccess } from "../core";
import { buildCursorPage, decodeIntegerCursor } from "../../../common/pagination/cursor";
import { keysetAfterIntValue } from "../../../common/pagination/keyset";
import type { VisibilitySummaryQuery } from "./dto/client-portal.schemas";

@Injectable()
export class ClientVisibilityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async getVisibilitySummary(u: CurrentUserContext, projectId: number, query: VisibilitySummaryQuery = { limit: 50 }) {
    const { orgId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
    const { limit, ticketCursor, milestoneCursor } = query;

    const ticketPos = decodeIntegerCursor(ticketCursor);
    const milestonePos = decodeIntegerCursor(milestoneCursor);

    const ticketConds = [
      eq(tickets.orgId, orgId),
      eq(tickets.projectId, projectId),
      isNull(tickets.deletedAt),
    ];
    if (ticketPos) {
      ticketConds.push(keysetAfterIntValue(tickets.ticketNumber, tickets.id, ticketPos));
    }

    const milestoneConds = [
      eq(projectMilestones.orgId, orgId),
      eq(projectMilestones.projectId, projectId),
      isNull(projectMilestones.deletedAt),
    ];
    if (milestonePos) {
      milestoneConds.push(gt(projectMilestones.id, milestonePos.id));
    }

    const [rawTickets, rawMilestones] = await Promise.all([
      this.db
        .select({
          id: tickets.id,
          ticketNumber: tickets.ticketNumber,
          title: tickets.title,
          type: tickets.type,
          clientVisible: tickets.clientVisible,
        })
        .from(tickets)
        .where(and(...ticketConds))
        .orderBy(tickets.ticketNumber)
        .limit(limit + 1),

      this.db
        .select({
          id: projectMilestones.id,
          name: projectMilestones.name,
          clientVisible: projectMilestones.clientVisible,
        })
        .from(projectMilestones)
        .where(and(...milestoneConds))
        .orderBy(projectMilestones.id)
        .limit(limit + 1),
    ]);

    return {
      tickets: buildCursorPage(rawTickets, limit, (row) => ({
        sortValue: String(row.ticketNumber),
        id: String(row.id),
      })),
      milestones: buildCursorPage(rawMilestones, limit, (row) => ({
        sortValue: String(row.id),
        id: String(row.id),
      })),
    };
  }

  async toggleTicketVisibility(u: CurrentUserContext, projectId: number, ticketId: number, clientVisible: boolean) {
    const { orgId, userId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
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

  async toggleMilestoneVisibility(u: CurrentUserContext, projectId: number, milestoneId: number, clientVisible: boolean) {
    const { orgId, userId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
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

  async toggleCommentVisibility(u: CurrentUserContext, projectId: number, commentId: number, clientVisible: boolean) {
    const { orgId, userId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
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

  async toggleAttachmentVisibility(u: CurrentUserContext, projectId: number, attachmentId: number, clientVisible: boolean) {
    const { orgId, userId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
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
