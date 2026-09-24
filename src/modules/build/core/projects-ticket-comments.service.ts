import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  organizationPeople,
  ticketCommentReactions,
  ticketComments,
  tickets,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { ProjectsActivityService } from "./projects-activity.service";
import { resolveTicketsScope } from "./tickets-scope";
import {
  ProjectsCommentNotFoundException,
  ProjectsForbiddenTicketException,
} from "../../../common/http/api-exceptions";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import type { CommentInput } from "./dto/projects.schemas";
import { resolvePersonDisplayName } from "../../../common/organization/person-display-name";
import { assertTicketReadAccess } from "./build-ticket-read-access";
import { actingMembershipId } from "../../../common/auth/principal";

@Injectable()
export class ProjectsTicketCommentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly activity: ProjectsActivityService,
    private readonly access: AccessService,
    private readonly webhooksDispatch: ProjectsWebhooksDispatchService,
  ) {}

  private async resolveTicketForComment(
    u: CurrentUserContext,
    projectId: number | null,
    ticketId: number,
  ) {
    if (projectId !== null)
      await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    const ticket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, ticketId),
        ...(projectId === null ? [] : [eq(tickets.projectId, projectId)]),
        eq(tickets.orgId, u.orgId),
        isNull(tickets.deletedAt),
      ),
      with: {
        assignee: { with: { user: { columns: { id: true } } } },
        assignees: { with: { user: { columns: { userId: true } } } },
      },
      columns: { id: true, assigneeMembershipId: true, reporterId: true, ticketNumber: true, title: true, projectId: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    if (projectId === null && ticket.projectId !== null) {
      await assertTicketReadAccess(
        this.db,
        this.access,
        u,
        ticket.projectId,
        ticketId,
      );
    } else if (ticket.projectId === null) {
      const read = await resolveTicketsScope(this.access, u);
      if (!read.unrestricted) {
        const isAssignee =
          ticket.assignee?.user?.id === u.userId ||
          ticket.assignees.some((a) => a.user.userId === u.userId);
        const isReporter = ticket.reporterId === u.userId;
        if (!isAssignee && !isReporter)
          throw new ProjectsForbiddenTicketException();
      }
    }

    return ticket;
  }

  private async loadCommentRow(orgId: string, ticketId: number, commentId: number) {
    const rows = await this.db
      .select({
        id: ticketComments.id,
        orgId: ticketComments.orgId,
        ticketId: ticketComments.ticketId,
        body: ticketComments.content,
        clientVisible: ticketComments.clientVisible,
        isEdited: sql<boolean>`${ticketComments.updatedAt} > ${ticketComments.createdAt}`,
        createdAt: ticketComments.createdAt,
        updatedAt: ticketComments.updatedAt,
        authorId: ticketComments.userId,
        authorDisplayName: organizationPeople.displayName,
        authorFirstName: organizationPeople.firstName,
        authorLastName: organizationPeople.lastName,
        authorImage: organizationPeople.avatarUrl,
        authorEmail: users.email,
      })
      .from(ticketComments)
      .leftJoin(
        organizationPeople,
        and(
          eq(organizationPeople.userId, ticketComments.userId),
          eq(organizationPeople.organizationId, orgId),
        ),
      )
      .leftJoin(users, eq(users.id, ticketComments.userId))
      .where(
        and(
          eq(ticketComments.id, commentId),
          eq(ticketComments.ticketId, ticketId),
          eq(ticketComments.orgId, orgId),
          isNull(ticketComments.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    const authorName = resolvePersonDisplayName({
      displayName: row.authorDisplayName,
      firstName: row.authorFirstName,
      lastName: row.authorLastName,
      email: row.authorEmail,
    });

    return {
      id: row.id,
      orgId: row.orgId,
      ticketId: row.ticketId,
      body: row.body,
      clientVisible: row.clientVisible,
      isEdited: row.isEdited,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      author: {
        id: row.authorId,
        name: authorName,
        image: row.authorImage ?? null,
        email: row.authorEmail ?? null,
      },
    };
  }

  async addComment(
    u: CurrentUserContext,
    projectId: number | null,
    ticketId: number,
    body: CommentInput,
  ) {
    const ticket = await this.resolveTicketForComment(u, projectId, ticketId);

    if (body.parentCommentId !== undefined) {
      const parent = await this.db.query.ticketComments.findFirst({
        where: and(
          eq(ticketComments.id, body.parentCommentId),
          eq(ticketComments.ticketId, ticketId),
          eq(ticketComments.orgId, u.orgId),
          isNull(ticketComments.deletedAt),
        ),
        columns: { id: true, parentCommentId: true },
      });
      if (!parent) throw new NotFoundException("Parent comment not found");
      if (parent.parentCommentId !== null) {
        throw new BadRequestException("Replies can only be one level deep");
      }
    }

    const comment = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(ticketComments)
        .values({
          orgId: u.orgId,
          ticketId,
          userId: u.userId,
          content: body.content,
          parentCommentId: body.parentCommentId ?? null,
        })
        .returning();
      if (ticket.projectId) {
        await this.webhooksDispatch.enqueue(tx, u.orgId, ticket.projectId, "comment.created", {
          id: created.id,
          projectId: ticket.projectId,
          ticketId,
          parentCommentId: body.parentCommentId ?? null,
          actor: u.userId,
          timestamp: new Date().toISOString(),
        });
      }
      return created;
    });

    try {
      await this.activity.logTicketActivity(u.orgId, ticketId, u.userId, "comment_added");
    } catch (error) {
      logger.error("Failed to log comment activity", { error });
    }

    try {
      await this.activity.processCommentMentions({
        orgId: u.orgId,
        ticketId,
        ticketNumber: ticket.ticketNumber,
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

    const saved = await this.loadCommentRow(u.orgId, ticketId, comment.id);
    if (!saved) throw new NotFoundException("Comment not found after creation");
    return saved;
  }

  async getComment(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number) {
    await this.resolveTicketForComment(u, projectId, ticketId);
    const comment = await this.loadCommentRow(u.orgId, ticketId, commentId);
    if (!comment) throw new ProjectsCommentNotFoundException();
    return comment;
  }

  async editComment(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number, content: string) {
    await this.resolveTicketForComment(u, projectId, ticketId);

    const comment = await this.db.query.ticketComments.findFirst({
      where: and(
        eq(ticketComments.id, commentId),
        eq(ticketComments.ticketId, ticketId),
        eq(ticketComments.orgId, u.orgId),
        isNull(ticketComments.deletedAt),
      ),
      columns: { id: true, userId: true },
    });
    if (!comment) throw new ProjectsCommentNotFoundException();
    if (comment.userId !== u.userId) throw new ForbiddenException("Only the comment author can edit this comment");

    await this.db
      .update(ticketComments)
      .set({ content, updatedAt: new Date() })
      .where(and(eq(ticketComments.id, commentId), eq(ticketComments.orgId, u.orgId)));

    try {
      await this.activity.logTicketActivity(u.orgId, ticketId, u.userId, "comment_updated");
    } catch (error) {
      logger.error("Failed to log comment edit activity", { error });
    }

    return { updated: true };
  }

  async deleteComment(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number) {
    await this.resolveTicketForComment(u, projectId, ticketId);

    const comment = await this.db.query.ticketComments.findFirst({
      where: and(
        eq(ticketComments.id, commentId),
        eq(ticketComments.ticketId, ticketId),
        eq(ticketComments.orgId, u.orgId),
        isNull(ticketComments.deletedAt),
      ),
      columns: { id: true, userId: true },
    });
    if (!comment) throw new ProjectsCommentNotFoundException();
    if (comment.userId !== u.userId) {
      throw new ForbiddenException("Only the comment author can delete this comment");
    }

    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.update(ticketComments).set({ deletedAt: now }).where(
        and(eq(ticketComments.orgId, u.orgId), sql`${ticketComments.parentCommentId} = ${commentId}`),
      );
      await tx.update(ticketComments).set({ deletedAt: now }).where(
        and(eq(ticketComments.id, commentId), eq(ticketComments.orgId, u.orgId)),
      );
    });

    try {
      await this.activity.logTicketActivity(u.orgId, ticketId, u.userId, "comment_deleted");
    } catch (error) {
      logger.error("Failed to log comment delete activity", { error });
    }

    return { deleted: true };
  }

  async addReaction(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number, emoji: string) {
    const { orgId, userId } = u;
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    const membershipId = actingMembershipId(u.principal);
    const comment = await this.db.query.ticketComments.findFirst({
      where: and(
        eq(ticketComments.id, commentId),
        eq(ticketComments.ticketId, ticketId),
        eq(ticketComments.orgId, orgId),
        isNull(ticketComments.deletedAt),
      ),
      columns: { id: true },
    });
    if (!comment) throw new NotFoundException("Comment not found");

    if (membershipId === null) throw new ForbiddenException("Organization membership required");
    await this.db
      .insert(ticketCommentReactions)
      .values({ commentId, orgId, emoji, membershipId })
      .onConflictDoNothing();
    return { commentId, userId, emoji };
  }

  async removeReaction(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number, emoji: string) {
    const { orgId } = u;
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    const membershipId = actingMembershipId(u.principal);
    const comment = await this.db.query.ticketComments.findFirst({
      where: and(
        eq(ticketComments.id, commentId),
        eq(ticketComments.ticketId, ticketId),
        eq(ticketComments.orgId, orgId),
        isNull(ticketComments.deletedAt),
      ),
      columns: { id: true },
    });
    if (!comment) throw new NotFoundException("Comment not found");
    if (membershipId === null) throw new ForbiddenException("Organization membership required");
    await this.db
      .delete(ticketCommentReactions)
      .where(
        and(
          eq(ticketCommentReactions.commentId, commentId),
          eq(ticketCommentReactions.membershipId, membershipId),
          eq(ticketCommentReactions.orgId, orgId),
          eq(ticketCommentReactions.emoji, emoji),
        ),
      );
  }

  getCommentReactions(commentId: number, orgId: string) {
    return this.db
      .select()
      .from(ticketCommentReactions)
      .where(and(eq(ticketCommentReactions.commentId, commentId), eq(ticketCommentReactions.orgId, orgId)))
      .limit(100);
  }
}
