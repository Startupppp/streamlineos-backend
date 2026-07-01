import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, or } from "drizzle-orm";
import {
  gitTicketLinks,
  projectMembers,
  projects,
  ticketActivityLog,
  ticketAttachments,
  ticketChecklistItems,
  ticketChecklists,
  ticketCommentReactions,
  ticketComments,
  ticketLabelMappings,
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
import type { AddLabelInput, AddRelationInput, AddWatcherInput, AttachmentInput, CommentInput } from "./dto/projects.schemas";

const ACTION_LABELS: Record<string, string> = {
  created: "created this ticket",
  status_changed: "changed status",
  priority_changed: "changed priority",
  assignee_changed: "changed assignee",
  title_changed: "renamed the ticket",
  sprint_changed: "changed sprint",
  due_date_changed: "changed due date",
  comment_added: "added a comment",
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
  ) {}

  async getActivity(orgId: string, projectId: number, ticketId: number) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

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
      .where(and(eq(ticketActivityLog.ticketId, ticketId), eq(ticketActivityLog.orgId, orgId)))
      .orderBy(desc(ticketActivityLog.createdAt), desc(ticketActivityLog.id));

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

  async addComment(u: CurrentUserContext, ticketId: number, body: CommentInput) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, u.orgId)),
      columns: { id: true, title: true, projectId: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const [comment] = await this.db
      .insert(ticketComments)
      .values({ orgId: u.orgId, ticketId, userId: u.userId, content: body.content })
      .returning();

    try {
      await this.activity.logTicketActivity(u.orgId, ticketId, u.userId, "comment_added");
    } catch (error) {
      logger.error("Failed to log comment activity", { error });
    }

    try {
      await this.activity.processCommentMentions({
        orgId: u.orgId,
        ticketId,
        ticketTitle: ticket.title,
        projectId: ticket.projectId,
        commentId: comment.id,
        content: body.content,
        authorId: u.userId,
        authorName: "A teammate",
      });
    } catch (error) {
      logger.error("Failed to process comment mentions", { error });
    }

    return comment;
  }

  getSubtasks(orgId: string, ticketId: number) {
    return this.db.query.tickets.findMany({
      where: and(eq(tickets.parentTicketId, ticketId), eq(tickets.orgId, orgId)),
      with: { assignee: true },
    });
  }

  private async requireMember(projectId: number, userId: string): Promise<void> {
    const member = await this.db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)),
    });
    if (!member) throw new ForbiddenException("Not a project member.");
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
      where: and(eq(tickets.id, body.relatedTicketId), eq(tickets.projectId, projectId)),
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

  private async requireTicket(orgId: string, ticketId: number): Promise<void> {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
  }

  async getWatchers(orgId: string, ticketId: number) {
    await this.requireTicket(orgId, ticketId);
    return this.db.query.ticketWatchers.findMany({
      where: eq(ticketWatchers.ticketId, ticketId),
      with: { user: true },
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

  async addLabel(orgId: string, ticketId: number, body: AddLabelInput) {
    await this.requireTicket(orgId, ticketId);
    await this.db
      .insert(ticketLabelMappings)
      .values({ ticketId, labelId: body.labelId })
      .onConflictDoNothing();
    return { success: true };
  }

  async removeLabel(orgId: string, ticketId: number, labelId: number) {
    await this.requireTicket(orgId, ticketId);
    await this.db
      .delete(ticketLabelMappings)
      .where(and(eq(ticketLabelMappings.ticketId, ticketId), eq(ticketLabelMappings.labelId, labelId)));
    return { success: true };
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
    const [item] = await this.db.update(ticketChecklistItems)
      .set(data)
      .where(eq(ticketChecklistItems.id, itemId))
      .returning();
    if (!item) throw new NotFoundException("Checklist item not found");
    return item;
  }

  async deleteChecklistItem(orgId: string, itemId: number) {
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
      .orderBy(desc(gitTicketLinks.createdAt));
  }

  async addReaction(commentId: number, userId: string, orgId: string, emoji: string) {
    const [reaction] = await this.db
      .insert(ticketCommentReactions)
      .values({ commentId, userId, orgId, emoji })
      .onConflictDoNothing()
      .returning();
    return reaction ?? { commentId, userId, emoji };
  }

  async removeReaction(commentId: number, userId: string, emoji: string) {
    await this.db
      .delete(ticketCommentReactions)
      .where(
        and(
          eq(ticketCommentReactions.commentId, commentId),
          eq(ticketCommentReactions.userId, userId),
          eq(ticketCommentReactions.emoji, emoji),
        ),
      );
  }

  getCommentReactions(commentId: number) {
    return this.db
      .select()
      .from(ticketCommentReactions)
      .where(eq(ticketCommentReactions.commentId, commentId));
  }
}
