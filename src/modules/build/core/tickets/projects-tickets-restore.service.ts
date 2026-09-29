import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull, ne } from "drizzle-orm";
import { projects, ticketComments, tickets } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { logSideEffectFailure } from "../../../../common/logger/side-effect";
import { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { BuildRestoreResult } from "../dto/build-core-response.schemas";
import {
  assertTicketReadAccess,
  type TicketReadAccess,
} from "./build-ticket-read-access";

@Injectable()
export class ProjectsTicketsRestoreService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: TicketReadAccess,
    private readonly cache: CacheService,
  ) {}

  async restoreTicket(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ): Promise<BuildRestoreResult> {
    const orgId = u.orgId;
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId, {
      includeDeleted: true,
    });

    const ticket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, ticketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, orgId),
      ),
      columns: {
        id: true,
        title: true,
        ticketNumber: true,
        deletedAt: true,
      },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    const deletedAt = ticket.deletedAt;
    if (!deletedAt) throw new ConflictException("Ticket is not deleted");

    const parent = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      columns: { id: true, name: true, deletedAt: true },
    });
    if (!parent) throw new NotFoundException("Ticket not found");
    if (parent.deletedAt)
      throw new ConflictException(
        `Project "${parent.name}" (${String(projectId)}) is still deleted. Restore the project before restoring this ticket.`,
      );

    const occupant = await this.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.orgId, orgId),
          eq(tickets.projectId, projectId),
          eq(tickets.ticketNumber, ticket.ticketNumber),
          ne(tickets.id, ticketId),
          isNull(tickets.deletedAt),
        ),
      )
      .limit(1);
    if (occupant[0])
      throw new ConflictException(
        `Ticket number ${String(ticket.ticketNumber)} is already held by live ticket ${String(occupant[0].id)} in this project. Renumber that ticket before restoring this one.`,
      );

    const restoredChildren = await this.db.transaction(async (tx) => {
      await tx
        .update(tickets)
        .set({ deletedAt: null })
        .where(and(eq(tickets.orgId, orgId), eq(tickets.id, ticketId)));

      const restoredComments = await tx
        .update(ticketComments)
        .set({ deletedAt: null })
        .where(
          and(
            eq(ticketComments.orgId, orgId),
            eq(ticketComments.ticketId, ticketId),
            eq(ticketComments.deletedAt, deletedAt),
          ),
        )
        .returning({ id: ticketComments.id });

      await this.audit.logCritical({
        action: "ticket.restored",
        userId: u.userId,
        orgId,
        targetId: String(ticketId),
        targetType: "ticket",
        metadata: {
          projectId,
          title: ticket.title,
          restoredComments: restoredComments.length,
          deletedAt: deletedAt.toISOString(),
        },
      });

      return restoredComments.length;
    });

    void this.cache
      .invalidateNamespace(`build:analytics:${orgId}`)
      .catch(logSideEffectFailure("analytics cache eviction", { orgId, projectId }));

    return { restored: true, restoredChildren };
  }

  async restoreComment(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    commentId: number,
  ): Promise<BuildRestoreResult> {
    const orgId = u.orgId;
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId, {
      includeDeleted: true,
    });

    const comment = await this.db.query.ticketComments.findFirst({
      where: and(
        eq(ticketComments.id, commentId),
        eq(ticketComments.ticketId, ticketId),
        eq(ticketComments.orgId, orgId),
      ),
      columns: {
        id: true,
        userId: true,
        parentCommentId: true,
        deletedAt: true,
      },
    });
    if (!comment) throw new NotFoundException("Comment not found");
    const deletedAt = comment.deletedAt;
    if (!deletedAt) throw new ConflictException("Comment is not deleted");
    if (comment.userId !== u.userId)
      throw new ForbiddenException(
        "Only the comment author can restore this comment",
      );

    const parentTicket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, ticketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, orgId),
      ),
      columns: { id: true, title: true, deletedAt: true },
    });
    if (!parentTicket) throw new NotFoundException("Comment not found");
    if (parentTicket.deletedAt)
      throw new ConflictException(
        `Ticket "${parentTicket.title}" (${String(ticketId)}) is still deleted. Restore the ticket before restoring this comment.`,
      );

    const parentCommentId = comment.parentCommentId;
    if (parentCommentId !== null) {
      const parentComment = await this.db.query.ticketComments.findFirst({
        where: and(
          eq(ticketComments.id, parentCommentId),
          eq(ticketComments.orgId, orgId),
        ),
        columns: { id: true, deletedAt: true },
      });
      if (parentComment?.deletedAt)
        throw new ConflictException(
          `Parent comment ${String(parentCommentId)} is still deleted. Restore it before restoring this reply.`,
        );
    }

    const restoredChildren = await this.db.transaction(async (tx) => {
      await tx
        .update(ticketComments)
        .set({ deletedAt: null })
        .where(
          and(
            eq(ticketComments.orgId, orgId),
            eq(ticketComments.id, commentId),
          ),
        );

      const restoredReplies = await tx
        .update(ticketComments)
        .set({ deletedAt: null })
        .where(
          and(
            eq(ticketComments.orgId, orgId),
            eq(ticketComments.parentCommentId, commentId),
            eq(ticketComments.deletedAt, deletedAt),
          ),
        )
        .returning({ id: ticketComments.id });

      await this.audit.logCritical({
        action: "ticket.comment.restored",
        userId: u.userId,
        orgId,
        targetId: String(commentId),
        targetType: "ticket_comment",
        metadata: {
          projectId,
          ticketId,
          restoredReplies: restoredReplies.length,
          deletedAt: deletedAt.toISOString(),
        },
      });

      return restoredReplies.length;
    });

    return { restored: true, restoredChildren };
  }
}
