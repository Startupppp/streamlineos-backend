import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  projects,
  ticketCommentReactions,
  ticketComments,
  tickets,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import { ProjectsActivityService } from "./projects-activity.service";
import { resolveTicketsScope } from "./tickets-scope";
import {
  ProjectsCommentNotFoundException,
  ProjectsForbiddenTicketException,
} from "../../common/http/api-exceptions";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import type { CommentInput } from "./dto/projects.schemas";

@Injectable()
export class ProjectsTicketCommentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly activity: ProjectsActivityService,
    private readonly access: AccessService,
    private readonly webhooksDispatch: ProjectsWebhooksDispatchService,
  ) {}

  private async resolveTicketForComment(u: CurrentUserContext, ticketId: number) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, u.orgId)),
      with: { assignees: { columns: { userId: true } } },
      columns: { id: true, assigneeId: true, reporterId: true, ticketNumber: true, title: true, projectId: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const scope = await resolveTicketsScope(this.access, u);
    if (scope !== "all") {
      const isAssignee = ticket.assigneeId === u.userId || ticket.assignees.some((a) => a.userId === u.userId);
      const isReporter = ticket.reporterId === u.userId;
      if (!isAssignee && !isReporter) throw new ProjectsForbiddenTicketException();
    }

    return ticket;
  }

  async addComment(u: CurrentUserContext, ticketId: number, body: CommentInput) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, u.orgId)),
      columns: { id: true, title: true, projectId: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    if (body.parentCommentId !== undefined) {
      const parent = await this.db.query.ticketComments.findFirst({
        where: and(
          eq(ticketComments.id, body.parentCommentId),
          eq(ticketComments.ticketId, ticketId),
          eq(ticketComments.orgId, u.orgId),
        ),
        columns: { id: true, parentCommentId: true },
      });
      if (!parent) throw new NotFoundException("Parent comment not found");
      if (parent.parentCommentId !== null) {
        throw new BadRequestException("Replies can only be one level deep");
      }
    }

    const [comment] = await this.db
      .insert(ticketComments)
      .values({
        orgId: u.orgId,
        ticketId,
        userId: u.userId,
        content: body.content,
        parentCommentId: body.parentCommentId ?? null,
      })
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

    if (ticket.projectId) {
      this.webhooksDispatch.dispatch(u.orgId, ticket.projectId, "comment.created", {
        id: comment.id,
        projectId: ticket.projectId,
        ticketId,
        parentCommentId: body.parentCommentId ?? null,
        actor: u.userId,
        timestamp: new Date().toISOString(),
      });
    }

    return comment;
  }

  async getComment(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number) {
    const ticket = await this.resolveTicketForComment(u, ticketId);
    if (ticket.projectId !== projectId) throw new NotFoundException("Ticket not found");

    const rows = await this.db
      .select({
        id: ticketComments.id,
        content: ticketComments.content,
        createdAt: ticketComments.createdAt,
        updatedAt: ticketComments.updatedAt,
        parentCommentId: ticketComments.parentCommentId,
        authorId: users.id,
        authorName: users.name,
        authorImage: users.image,
        projectKey: projects.key,
      })
      .from(ticketComments)
      .leftJoin(users, eq(users.id, ticketComments.userId))
      .leftJoin(projects, and(eq(projects.id, projectId), eq(projects.orgId, u.orgId)))
      .where(
        and(
          eq(ticketComments.id, commentId),
          eq(ticketComments.ticketId, ticketId),
          eq(ticketComments.orgId, u.orgId),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) throw new ProjectsCommentNotFoundException();

    return {
      id: row.id,
      content: row.content,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      parentCommentId: row.parentCommentId,
      author: {
        id: row.authorId,
        name: row.authorName,
        image: row.authorImage,
      },
      ticket: {
        id: ticket.id,
        ticketNumber: ticket.ticketNumber,
        title: ticket.title,
        projectKey: row.projectKey ?? null,
        projectId,
      },
    };
  }

  async editComment(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number, content: string) {
    const ticket = await this.resolveTicketForComment(u, ticketId);
    if (ticket.projectId !== projectId) throw new NotFoundException("Ticket not found");

    const comment = await this.db.query.ticketComments.findFirst({
      where: and(
        eq(ticketComments.id, commentId),
        eq(ticketComments.ticketId, ticketId),
        eq(ticketComments.orgId, u.orgId),
      ),
      columns: { id: true, userId: true },
    });
    if (!comment) throw new ProjectsCommentNotFoundException();
    if (comment.userId !== u.userId) throw new ForbiddenException("Only the comment author can edit this comment");

    await this.db
      .update(ticketComments)
      .set({ content, updatedAt: new Date() })
      .where(eq(ticketComments.id, commentId));

    try {
      await this.activity.logTicketActivity(u.orgId, ticketId, u.userId, "comment_updated");
    } catch (error) {
      logger.error("Failed to log comment edit activity", { error });
    }

    return { updated: true };
  }

  async deleteComment(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number) {
    const ticket = await this.resolveTicketForComment(u, ticketId);
    if (ticket.projectId !== projectId) throw new NotFoundException("Ticket not found");

    const comment = await this.db.query.ticketComments.findFirst({
      where: and(
        eq(ticketComments.id, commentId),
        eq(ticketComments.ticketId, ticketId),
        eq(ticketComments.orgId, u.orgId),
      ),
      columns: { id: true, userId: true },
    });
    if (!comment) throw new ProjectsCommentNotFoundException();

    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const canManage = u.isOrgOwner || u.isPlatformAdmin || perms.has("projects:manage");
    if (comment.userId !== u.userId && !canManage) {
      throw new ForbiddenException("Only the comment author or a project manager can delete this comment");
    }

    await this.db.delete(ticketComments).where(eq(ticketComments.id, commentId));

    try {
      await this.activity.logTicketActivity(u.orgId, ticketId, u.userId, "comment_deleted");
    } catch (error) {
      logger.error("Failed to log comment delete activity", { error });
    }

    return { deleted: true };
  }

  async addReaction(commentId: number, userId: string, orgId: string, emoji: string) {
    const comment = await this.db.query.ticketComments.findFirst({
      where: and(eq(ticketComments.id, commentId), eq(ticketComments.orgId, orgId)),
      columns: { id: true },
    });
    if (!comment) throw new NotFoundException("Comment not found");

    const [reaction] = await this.db
      .insert(ticketCommentReactions)
      .values({ commentId, userId, orgId, emoji })
      .onConflictDoNothing()
      .returning();
    return reaction ?? { commentId, userId, emoji };
  }

  async removeReaction(commentId: number, userId: string, orgId: string, emoji: string) {
    await this.db
      .delete(ticketCommentReactions)
      .where(
        and(
          eq(ticketCommentReactions.commentId, commentId),
          eq(ticketCommentReactions.userId, userId),
          eq(ticketCommentReactions.orgId, orgId),
          eq(ticketCommentReactions.emoji, emoji),
        ),
      );
  }

  getCommentReactions(commentId: number, orgId: string) {
    return this.db
      .select()
      .from(ticketCommentReactions)
      .where(and(eq(ticketCommentReactions.commentId, commentId), eq(ticketCommentReactions.orgId, orgId)));
  }
}
