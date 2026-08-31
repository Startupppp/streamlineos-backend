import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import {
  organizationPeople,
  ticketActivityLog,
  ticketAttachments,
  ticketLabelMappings,
  tickets,
  ticketWatchers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ProjectsActivityService } from "./projects-activity.service";
import { ProjectsTicketCommentsService } from "./projects-ticket-comments.service";
import { ProjectsTicketChecklistsService } from "./projects-ticket-checklists.service";
import { ProjectsTicketLinksService } from "./projects-ticket-links.service";
import { ProjectsTicketRelationsService } from "./projects-ticket-relations.service";
import type {
  AddLabelInput,
  AddRelatedLinkInput,
  AddRelationInput,
  AddWatcherInput,
  AttachmentInput,
  CommentInput,
  UpdateRelatedLinkInput,
} from "./dto/projects.schemas";

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
    private readonly checklistsService: ProjectsTicketChecklistsService,
    private readonly linksService: ProjectsTicketLinksService,
    private readonly relationsService: ProjectsTicketRelationsService,
  ) {}

  addComment(u: CurrentUserContext, ticketId: number, body: CommentInput) {
    return this.comments.addComment(u, ticketId, body);
  }

  getComment(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    commentId: number,
  ) {
    return this.comments.getComment(u, projectId, ticketId, commentId);
  }

  editComment(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    commentId: number,
    content: string,
  ) {
    return this.comments.editComment(u, projectId, ticketId, commentId, content);
  }

  deleteComment(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    commentId: number,
  ) {
    return this.comments.deleteComment(u, projectId, ticketId, commentId);
  }

  addReaction(
    commentId: number,
    userId: string,
    orgId: string,
    emoji: string,
  ) {
    return this.comments.addReaction(commentId, userId, orgId, emoji);
  }

  removeReaction(
    commentId: number,
    userId: string,
    orgId: string,
    emoji: string,
  ) {
    return this.comments.removeReaction(commentId, userId, orgId, emoji);
  }

  getCommentReactions(commentId: number, orgId: string) {
    return this.comments.getCommentReactions(commentId, orgId);
  }

  async getActivity(
    orgId: string,
    projectId: number,
    ticketId: number,
    opts: { limit: number; cursor?: string },
  ) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, ticketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
      ),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const position = decodeCursor(opts.cursor);
    const rawId = position !== null ? Number(position.sortValue) : NaN;
    const beforeId = isNaN(rawId) ? undefined : rawId;

    const conditions = [
      eq(ticketActivityLog.ticketId, ticketId),
      eq(ticketActivityLog.orgId, orgId),
    ];
    if (beforeId !== undefined)
      conditions.push(lt(ticketActivityLog.id, beforeId));

    const rows = await this.db
      .select({
        id: ticketActivityLog.id,
        action: ticketActivityLog.action,
        fromValue: ticketActivityLog.fromValue,
        toValue: ticketActivityLog.toValue,
        createdAt: ticketActivityLog.createdAt,
        userMembershipId: ticketActivityLog.userMembershipId,
        actorUserId: organizationPeople.userId,
        displayName: organizationPeople.displayName,
        firstName: organizationPeople.firstName,
        lastName: organizationPeople.lastName,
        avatarUrl: organizationPeople.avatarUrl,
      })
      .from(ticketActivityLog)
      .leftJoin(organizationPeople, and(
        eq(organizationPeople.organizationId, ticketActivityLog.orgId),
        eq(organizationPeople.organizationMembershipId, ticketActivityLog.userMembershipId),
      ))
      .where(and(...conditions))
      .orderBy(desc(ticketActivityLog.id))
      .limit(opts.limit + 1);

    const mapped = rows.map((row) => {
      const fallbackName = `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim();
      const resolvedName = row.displayName ?? (fallbackName.length > 0 ? fallbackName : null);
      return {
        id: row.id,
        action: row.action,
        label: actionLabel(row.action),
        fromValue: row.fromValue,
        toValue: row.toValue,
        createdAt: row.createdAt,
        user: row.userMembershipId !== null && row.userMembershipId !== undefined
          ? { id: row.actorUserId ?? null, name: resolvedName ?? "Former Member", image: row.avatarUrl ?? null }
          : null,
      };
    });

    return buildCursorPage(mapped, opts.limit, (r) => ({
      sortValue: String(r.id),
      id: String(r.id),
    }));
  }

  getSubtasks(orgId: string, ticketId: number) {
    return this.db.query.tickets.findMany({
      where: and(eq(tickets.parentTicketId, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)),
      columns: {
        completionPercentage: false,
        clientVisible: false,
        isRecurring: false,
        recurrenceRule: false,
        recurrenceParentId: false,
        recurrenceNextRunAt: false,
      },
      with: {
        assignee: {
          columns: {
            id: true,
            name: true,
            firstName: true,
            lastName: true,
            image: true,
            email: true,
          },
        },
      },
      limit: 200,
    });
  }

  private async requireTicket(orgId: string, ticketId: number): Promise<void> {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
  }

  async getWatchers(orgId: string, ticketId: number) {
    await this.requireTicket(orgId, ticketId);
    return this.db.query.ticketWatchers.findMany({
      where: eq(ticketWatchers.ticketId, ticketId),
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            firstName: true,
            lastName: true,
            image: true,
            email: true,
          },
        },
      },
      limit: 100,
    });
  }

  async addWatcher(
    u: CurrentUserContext,
    ticketId: number,
    body: AddWatcherInput,
  ) {
    await this.requireTicket(u.orgId, ticketId);
    const userId = body.userId ?? u.userId;
    await this.db
      .insert(ticketWatchers)
      .values({ orgId: u.orgId, ticketId, userId })
      .onConflictDoNothing();
    return { success: true };
  }

  async removeWatcher(u: CurrentUserContext, ticketId: number) {
    await this.db
      .delete(ticketWatchers)
      .where(
        and(
          eq(ticketWatchers.ticketId, ticketId),
          eq(ticketWatchers.userId, u.userId),
        ),
      );
    return { success: true };
  }

  async addLabel(
    orgId: string,
    userId: string,
    ticketId: number,
    body: AddLabelInput,
  ) {
    await this.requireTicket(orgId, ticketId);
    const [mapping] = await this.db
      .insert(ticketLabelMappings)
      .values({ orgId, ticketId, labelId: body.labelId })
      .onConflictDoNothing()
      .returning({ id: ticketLabelMappings.id });
    if (mapping) await this.logLabelChange(orgId, ticketId, userId);
    return { success: true };
  }

  async removeLabel(
    orgId: string,
    userId: string,
    ticketId: number,
    labelId: number,
  ) {
    await this.requireTicket(orgId, ticketId);
    const deleted = await this.db
      .delete(ticketLabelMappings)
      .where(
        and(
          eq(ticketLabelMappings.ticketId, ticketId),
          eq(ticketLabelMappings.labelId, labelId),
        ),
      )
      .returning({ id: ticketLabelMappings.id });
    if (deleted.length > 0) await this.logLabelChange(orgId, ticketId, userId);
    return { success: true };
  }

  private async logLabelChange(
    orgId: string,
    ticketId: number,
    userId: string,
  ): Promise<void> {
    try {
      await this.activity.logTicketActivity(orgId, ticketId, userId, "label_changed");
    } catch (error) {
      logger.error("Failed to log label activity", { error });
    }
  }

  async addAttachment(
    u: CurrentUserContext,
    ticketId: number,
    body: AttachmentInput,
  ) {
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

  listRelations(u: CurrentUserContext, projectId: number, ticketId: number) {
    return this.relationsService.listRelations(u, projectId, ticketId);
  }

  addRelation(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    body: AddRelationInput,
  ) {
    return this.relationsService.addRelation(u, projectId, ticketId, body);
  }

  removeRelation(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    relatedId: number,
  ) {
    return this.relationsService.removeRelation(u, projectId, ticketId, relatedId);
  }

  getChecklists(orgId: string, projectId: number, ticketId: number) {
    return this.checklistsService.getChecklists(orgId, projectId, ticketId);
  }

  createChecklist(
    orgId: string,
    projectId: number,
    ticketId: number,
    data: { title: string },
  ) {
    return this.checklistsService.createChecklist(orgId, projectId, ticketId, data);
  }

  updateChecklist(orgId: string, checklistId: number, data: { title: string }) {
    return this.checklistsService.updateChecklist(orgId, checklistId, data);
  }

  deleteChecklist(orgId: string, checklistId: number) {
    return this.checklistsService.deleteChecklist(orgId, checklistId);
  }

  createChecklistItem(
    orgId: string,
    checklistId: number,
    data: {
      text: string;
      assigneeId?: string;
      dueDate?: string | null;
      order: number;
    },
  ) {
    return this.checklistsService.createChecklistItem(orgId, checklistId, data);
  }

  updateChecklistItem(
    orgId: string,
    itemId: number,
    data: {
      text?: string;
      isCompleted?: boolean;
      assigneeId?: string | null;
      dueDate?: string | null;
      order?: number;
    },
  ) {
    return this.checklistsService.updateChecklistItem(orgId, itemId, data);
  }

  deleteChecklistItem(orgId: string, itemId: number) {
    return this.checklistsService.deleteChecklistItem(orgId, itemId);
  }

  getGitLinks(orgId: string, projectId: number, ticketId: number) {
    return this.linksService.getGitLinks(orgId, projectId, ticketId);
  }

  listRelatedLinks(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ) {
    return this.linksService.listRelatedLinks(u, projectId, ticketId);
  }

  addRelatedLink(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    body: AddRelatedLinkInput,
  ) {
    return this.linksService.addRelatedLink(u, projectId, ticketId, body);
  }

  updateRelatedLink(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    linkId: number,
    body: UpdateRelatedLinkInput,
  ) {
    return this.linksService.updateRelatedLink(u, projectId, ticketId, linkId, body);
  }

  deleteRelatedLink(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    linkId: number,
  ) {
    return this.linksService.deleteRelatedLink(u, projectId, ticketId, linkId);
  }
}
