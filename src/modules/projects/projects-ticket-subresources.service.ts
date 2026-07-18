import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, lt, or } from "drizzle-orm";
import {
  gitTicketLinks,
  projectMembers,
  projects,
  ticketActivityLog,
  ticketAttachments,
  ticketChecklistItems,
  ticketChecklists,
  ticketLabelMappings,
  ticketRelatedLinks,
  tickets,
  ticketWatchers,
  users,
  workItemRelations,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ProjectsActivityService } from "./projects-activity.service";
import { ProjectsTicketCommentsService } from "./projects-ticket-comments.service";
import type { AddLabelInput, AddRelatedLinkInput, AddRelationInput, AddWatcherInput, AttachmentInput, CommentInput, UpdateRelatedLinkInput } from "./dto/projects.schemas";

const ACTION_LABELS: Record<string, string> = {
  created: "created this ticket",
  status_changed: "changed status",
  priority_changed: "changed priority",
  assignee_changed: "changed assignee",
  title_changed: "renamed the ticket",
  sprint_changed: "changed sprint",
  due_date_changed: "changed due date",
  comment_added: "added a comment",
  comment_updated: "edited a comment",
  comment_deleted: "deleted a comment",
  label_changed: "changed labels",
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}

@Injectable()
export class ProjectsTicketSubresourcesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly activity: ProjectsActivityService,
    private readonly comments: ProjectsTicketCommentsService,
  ) {}

  addComment(u: CurrentUserContext, ticketId: number, body: CommentInput) {
    return this.comments.addComment(u, ticketId, body);
  }

  getComment(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number) {
    return this.comments.getComment(u, projectId, ticketId, commentId);
  }

  editComment(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number, content: string) {
    return this.comments.editComment(u, projectId, ticketId, commentId, content);
  }

  deleteComment(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number) {
    return this.comments.deleteComment(u, projectId, ticketId, commentId);
  }

  addReaction(commentId: number, userId: string, orgId: string, emoji: string) {
    return this.comments.addReaction(commentId, userId, orgId, emoji);
  }

  removeReaction(commentId: number, userId: string, orgId: string, emoji: string) {
    return this.comments.removeReaction(commentId, userId, orgId, emoji);
  }

  getCommentReactions(commentId: number, orgId: string) {
    return this.comments.getCommentReactions(commentId, orgId);
  }

  async getActivity(
    orgId: string,
    projectId: number,
    ticketId: number,
    opts: { limit: number; before?: number },
  ) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const conditions = [
      eq(ticketActivityLog.ticketId, ticketId),
      eq(ticketActivityLog.orgId, orgId),
    ];
    if (opts.before !== undefined) conditions.push(lt(ticketActivityLog.id, opts.before));

    const rows = await this.db
      .select({
        id: ticketActivityLog.id,
        action: ticketActivityLog.action,
        fromValue: ticketActivityLog.fromValue,
        toValue: ticketActivityLog.toValue,
        createdAt: ticketActivityLog.createdAt,
        userId: ticketActivityLog.userId,
        userName: users.name,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userImage: users.image,
      })
      .from(ticketActivityLog)
      .leftJoin(users, eq(users.id, ticketActivityLog.userId))
      .where(and(...conditions))
      .orderBy(desc(ticketActivityLog.id))
      .limit(opts.limit);

    return rows.map((row) => {
      const fallbackName = `${row.userFirstName ?? ""} ${row.userLastName ?? ""}`.trim();
      const resolvedName = row.userName ?? (fallbackName.length > 0 ? fallbackName : null);
      return {
        id: row.id,
        action: row.action,
        label: actionLabel(row.action),
        fromValue: row.fromValue,
        toValue: row.toValue,
        createdAt: row.createdAt,
        user: row.userId ? { id: row.userId, name: resolvedName, image: row.userImage } : null,
      };
    });
  }

  getSubtasks(orgId: string, ticketId: number) {
    return this.db.query.tickets.findMany({
      where: and(eq(tickets.parentTicketId, ticketId), eq(tickets.orgId, orgId)),
      with: {
        assignee: {
          columns: { id: true, name: true, firstName: true, lastName: true, image: true, email: true },
        },
      },
      limit: 200,
    });
  }

  private async requireMember(projectId: number, userId: string): Promise<void> {
    const member = await this.db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)),
    });
    if (!member) throw new ForbiddenException("Not a project member.");
  }

  private async requireTicket(orgId: string, ticketId: number): Promise<void> {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
  }

  async listRelations(u: CurrentUserContext, projectId: number, ticketId: number) {
    await this.requireMember(projectId, u.userId);

    const relations = await this.db.query.workItemRelations.findMany({
      where: or(
        eq(workItemRelations.workItemId, ticketId),
        eq(workItemRelations.relatedWorkItemId, ticketId),
      ),
      with: {
        workItem: { columns: { id: true, title: true, ticketNumber: true, status: true, priority: true } },
        relatedWorkItem: { columns: { id: true, title: true, ticketNumber: true, status: true, priority: true } },
      },
      limit: 200,
    });

    return relations.map((r) => {
      const isSource = r.workItemId === ticketId;
      return {
        id: r.id,
        relationType: r.relationType,
        relatedTicket: isSource ? r.relatedWorkItem : r.workItem,
        direction: isSource ? "outgoing" : "incoming",
      };
    });
  }

  async addRelation(u: CurrentUserContext, projectId: number, ticketId: number, body: AddRelationInput) {
    await this.requireMember(projectId, u.userId);

    if (body.relatedTicketId === ticketId) {
      throw new BadRequestException("A ticket cannot relate to itself.");
    }

    const relatedTicket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, body.relatedTicketId), eq(tickets.projectId, projectId), eq(tickets.orgId, u.orgId)),
      columns: { id: true },
    });
    if (!relatedTicket) throw new NotFoundException("Related ticket not found in this project.");

    const [created] = await this.db
      .insert(workItemRelations)
      .values({ workItemId: ticketId, relatedWorkItemId: body.relatedTicketId, relationType: body.relationType })
      .onConflictDoNothing()
      .returning();

    if (!created) throw new ConflictException("This relation already exists.");

    return created;
  }

  async removeRelation(u: CurrentUserContext, projectId: number, ticketId: number, relatedId: number) {
    await this.requireMember(projectId, u.userId);

    if (!relatedId) throw new BadRequestException("relatedId query param required.");

    await this.db.delete(workItemRelations).where(
      or(
        and(eq(workItemRelations.workItemId, ticketId), eq(workItemRelations.relatedWorkItemId, relatedId)),
        and(eq(workItemRelations.workItemId, relatedId), eq(workItemRelations.relatedWorkItemId, ticketId)),
      ),
    );

    return { success: true };
  }

  async getWatchers(orgId: string, ticketId: number) {
    await this.requireTicket(orgId, ticketId);
    return this.db.query.ticketWatchers.findMany({
      where: eq(ticketWatchers.ticketId, ticketId),
      with: {
        user: {
          columns: { id: true, name: true, firstName: true, lastName: true, image: true, email: true },
        },
      },
      limit: 200,
    });
  }

  async addWatcher(u: CurrentUserContext, ticketId: number, body: AddWatcherInput) {
    await this.requireTicket(u.orgId, ticketId);
    const userId = body.userId ?? u.userId;
    await this.db.insert(ticketWatchers).values({ ticketId, userId }).onConflictDoNothing();
    return { success: true };
  }

  async removeWatcher(u: CurrentUserContext, ticketId: number) {
    await this.db
      .delete(ticketWatchers)
      .where(and(eq(ticketWatchers.ticketId, ticketId), eq(ticketWatchers.userId, u.userId)));
    return { success: true };
  }

  async addLabel(orgId: string, userId: string, ticketId: number, body: AddLabelInput) {
    await this.requireTicket(orgId, ticketId);
    const [mapping] = await this.db
      .insert(ticketLabelMappings)
      .values({ ticketId, labelId: body.labelId })
      .onConflictDoNothing()
      .returning({ id: ticketLabelMappings.id });
    if (mapping) await this.logLabelChange(orgId, ticketId, userId);
    return { success: true };
  }

  async removeLabel(orgId: string, userId: string, ticketId: number, labelId: number) {
    await this.requireTicket(orgId, ticketId);
    const deleted = await this.db
      .delete(ticketLabelMappings)
      .where(and(eq(ticketLabelMappings.ticketId, ticketId), eq(ticketLabelMappings.labelId, labelId)))
      .returning({ id: ticketLabelMappings.id });
    if (deleted.length > 0) await this.logLabelChange(orgId, ticketId, userId);
    return { success: true };
  }

  private async logLabelChange(orgId: string, ticketId: number, userId: string): Promise<void> {
    try {
      await this.activity.logTicketActivity(orgId, ticketId, userId, "label_changed");
    } catch (error) {
      logger.error("Failed to log label activity", { error });
    }
  }

  async addAttachment(u: CurrentUserContext, ticketId: number, body: AttachmentInput) {
    await this.requireTicket(u.orgId, ticketId);
    const [attachment] = await this.db
      .insert(ticketAttachments)
      .values({
        orgId: u.orgId,
        ticketId,
        fileUrl: body.fileUrl,
        fileName: body.fileName,
        fileSize: body.fileSize,
        mimeType: body.mimeType,
        uploadedBy: u.userId,
      })
      .returning();
    return { id: attachment.id };
  }

  async getChecklists(orgId: string, projectId: number, ticketId: number) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    return this.db.query.ticketChecklists.findMany({
      where: and(eq(ticketChecklists.ticketId, ticketId), eq(ticketChecklists.orgId, orgId)),
      with: { items: { orderBy: (i, { asc }) => [asc(i.order)] } },
      orderBy: (c, { asc }) => [asc(c.createdAt)],
      limit: 100,
    });
  }

  async createChecklist(orgId: string, projectId: number, ticketId: number, data: { title: string }) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const [checklist] = await this.db.insert(ticketChecklists).values({
      orgId,
      ticketId,
      title: data.title,
    }).returning();
    return checklist;
  }

  async updateChecklist(orgId: string, checklistId: number, data: { title: string }) {
    const [updated] = await this.db.update(ticketChecklists)
      .set({ title: data.title })
      .where(and(eq(ticketChecklists.id, checklistId), eq(ticketChecklists.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Checklist not found");
    return updated;
  }

  async deleteChecklist(orgId: string, checklistId: number) {
    const [deleted] = await this.db.delete(ticketChecklists)
      .where(and(eq(ticketChecklists.id, checklistId), eq(ticketChecklists.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Checklist not found");
    return { success: true };
  }

  async createChecklistItem(orgId: string, checklistId: number, data: { text: string; assigneeId?: string; dueDate?: string | null; order: number }) {
    const checklist = await this.db.query.ticketChecklists.findFirst({
      where: and(eq(ticketChecklists.id, checklistId), eq(ticketChecklists.orgId, orgId)),
      columns: { id: true },
    });
    if (!checklist) throw new NotFoundException("Checklist not found");

    const [item] = await this.db.insert(ticketChecklistItems).values({
      checklistId,
      text: data.text,
      assigneeId: data.assigneeId,
      dueDate: data.dueDate,
      order: data.order,
    }).returning();
    return item;
  }

  async updateChecklistItem(orgId: string, itemId: number, data: { text?: string; isCompleted?: boolean; assigneeId?: string | null; dueDate?: string | null; order?: number }) {
    const existing = await this.db.query.ticketChecklistItems.findFirst({
      where: eq(ticketChecklistItems.id, itemId),
      columns: { id: true, checklistId: true },
      with: { checklist: { columns: { orgId: true } } },
    });
    if (!existing || existing.checklist.orgId !== orgId) throw new NotFoundException("Checklist item not found");

    const [item] = await this.db.update(ticketChecklistItems)
      .set(data)
      .where(eq(ticketChecklistItems.id, itemId))
      .returning();
    if (!item) throw new NotFoundException("Checklist item not found");
    return item;
  }

  async deleteChecklistItem(orgId: string, itemId: number) {
    const existing = await this.db.query.ticketChecklistItems.findFirst({
      where: eq(ticketChecklistItems.id, itemId),
      columns: { id: true, checklistId: true },
      with: { checklist: { columns: { orgId: true } } },
    });
    if (!existing || existing.checklist.orgId !== orgId) throw new NotFoundException("Checklist item not found");

    const [deleted] = await this.db.delete(ticketChecklistItems)
      .where(eq(ticketChecklistItems.id, itemId))
      .returning();
    if (!deleted) throw new NotFoundException("Checklist item not found");
    return { success: true };
  }

  async getGitLinks(orgId: string, projectId: number, ticketId: number) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      columns: { id: true },
    });
    if (!project) throw new NotFoundException("Project not found");

    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    return this.db
      .select({
        id: gitTicketLinks.id,
        provider: gitTicketLinks.provider,
        refType: gitTicketLinks.refType,
        externalId: gitTicketLinks.externalId,
        title: gitTicketLinks.title,
        url: gitTicketLinks.url,
        author: gitTicketLinks.author,
        status: gitTicketLinks.status,
        createdAt: gitTicketLinks.createdAt,
      })
      .from(gitTicketLinks)
      .where(and(eq(gitTicketLinks.ticketId, ticketId), eq(gitTicketLinks.orgId, orgId)))
      .orderBy(desc(gitTicketLinks.createdAt))
      .limit(100);
  }

  async listRelatedLinks(u: CurrentUserContext, projectId: number, ticketId: number) {
    await this.assertTicketAccess(u, projectId, ticketId);
    return this.db
      .select({
        id: ticketRelatedLinks.id,
        url: ticketRelatedLinks.url,
        label: ticketRelatedLinks.label,
        createdAt: ticketRelatedLinks.createdAt,
      })
      .from(ticketRelatedLinks)
      .where(eq(ticketRelatedLinks.ticketId, ticketId))
      .orderBy(ticketRelatedLinks.createdAt)
      .limit(50);
  }

  async addRelatedLink(u: CurrentUserContext, projectId: number, ticketId: number, body: AddRelatedLinkInput) {
    await this.assertTicketAccess(u, projectId, ticketId);
    const existing = await this.db
      .select({ id: ticketRelatedLinks.id })
      .from(ticketRelatedLinks)
      .where(eq(ticketRelatedLinks.ticketId, ticketId));
    if (existing.length >= 20) throw new BadRequestException("A ticket can have at most 20 related links");
    const [created] = await this.db
      .insert(ticketRelatedLinks)
      .values({ ticketId, url: body.url, label: body.label ?? null, createdBy: u.userId })
      .returning();
    return created;
  }

  async updateRelatedLink(u: CurrentUserContext, projectId: number, ticketId: number, linkId: number, body: UpdateRelatedLinkInput) {
    await this.assertTicketAccess(u, projectId, ticketId);
    const [link] = await this.db
      .select({ id: ticketRelatedLinks.id, createdBy: ticketRelatedLinks.createdBy })
      .from(ticketRelatedLinks)
      .where(and(eq(ticketRelatedLinks.id, linkId), eq(ticketRelatedLinks.ticketId, ticketId)));
    if (!link) throw new NotFoundException("Related link not found");
    if (link.createdBy !== u.userId && !u.isOrgOwner) throw new ForbiddenException("Cannot edit another user's link");
    const update: { url?: string; label?: string | null } = {};
    if (body.url !== undefined) update.url = body.url;
    if (body.label !== undefined) update.label = body.label;
    const [updated] = await this.db
      .update(ticketRelatedLinks)
      .set(update)
      .where(and(eq(ticketRelatedLinks.id, linkId), eq(ticketRelatedLinks.ticketId, ticketId)))
      .returning();
    return updated;
  }

  async deleteRelatedLink(u: CurrentUserContext, projectId: number, ticketId: number, linkId: number) {
    await this.assertTicketAccess(u, projectId, ticketId);
    const [link] = await this.db
      .select({ id: ticketRelatedLinks.id, createdBy: ticketRelatedLinks.createdBy })
      .from(ticketRelatedLinks)
      .where(and(eq(ticketRelatedLinks.id, linkId), eq(ticketRelatedLinks.ticketId, ticketId)));
    if (!link) throw new NotFoundException("Related link not found");
    if (link.createdBy !== u.userId && !u.isOrgOwner) throw new ForbiddenException("Cannot delete another user's link");
    await this.db.delete(ticketRelatedLinks).where(and(eq(ticketRelatedLinks.id, linkId), eq(ticketRelatedLinks.ticketId, ticketId)));
  }

  private async assertTicketAccess(u: CurrentUserContext, projectId: number, ticketId: number) {
    const [ticket] = await this.db
      .select({ id: tickets.id, projectId: tickets.projectId, orgId: tickets.orgId })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, u.orgId)));
    if (!ticket || ticket.projectId !== projectId) throw new NotFoundException("Ticket not found");
  }
}
