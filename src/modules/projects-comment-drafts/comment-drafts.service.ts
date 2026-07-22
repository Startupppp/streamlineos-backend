import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { commentDrafts } from "../../db/schema/comment-drafts";
import { tickets } from "../../db/schema/projects/tasks";
import { projects } from "../../db/schema/projects/core";
import { users } from "../../db/schema/auth";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { UpsertCommentDraftInput } from "./dto/comment-drafts.schemas";

@Injectable()
export class CommentDraftsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listMine(orgId: string, userId: string) {
    const rows = await this.db
      .select({
        id: commentDrafts.id,
        assigneeId: users.id,
        body: commentDrafts.body,
        projectKey: projects.key,
        assigneeName: users.name,
        ticketType: tickets.type,
        assigneeImage: users.image,
        ticketTitle: tickets.title,
        projectName: projects.name,
        projectId: tickets.projectId,
        ticketStatus: tickets.status,
        ticketPriority: tickets.priority,
        assigneeLastName: users.lastName,
        ticketId: commentDrafts.ticketId,
        createdAt: commentDrafts.createdAt,
        updatedAt: commentDrafts.updatedAt,
        ticketNumber: tickets.ticketNumber,
        assigneeFirstName: users.firstName,
      })
      .from(commentDrafts)
      .innerJoin(tickets, eq(tickets.id, commentDrafts.ticketId))
      .leftJoin(
        projects,
        and(eq(projects.id, tickets.projectId), eq(projects.orgId, orgId)),
      )
      .leftJoin(users, eq(users.id, tickets.assigneeId))
      .where(
        and(eq(commentDrafts.orgId, orgId), eq(commentDrafts.userId, userId)),
      )
      .orderBy(commentDrafts.updatedAt);

    return rows.map((r) => ({
      id: r.id,
      ticketId: r.ticketId,
      body: r.body,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ticket: {
        id: r.ticketId,
        type: r.ticketType,
        title: r.ticketTitle,
        projectId: r.projectId,
        status: r.ticketStatus,
        ticketNumber: r.ticketNumber,
        projectKey: r.projectKey ?? null,
        priority: r.ticketPriority ?? null,
        projectName: r.projectName ?? null,
        assignee: r.assigneeId
          ? {
              id: r.assigneeId,
              name: r.assigneeName ?? null,
              image: r.assigneeImage ?? null,
              lastName: r.assigneeLastName ?? null,
              firstName: r.assigneeFirstName ?? null,
            }
          : null,
      },
    }));
  }

  async upsert(
    orgId: string,
    userId: string,
    ticketId: number,
    input: UpsertCommentDraftInput,
  ) {
    const [ticket] = await this.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)))
      .limit(1);

    if (!ticket) throw new NotFoundException("Ticket not found");

    const [row] = await this.db
      .insert(commentDrafts)
      .values({ orgId, userId, ticketId, body: input.body })
      .onConflictDoUpdate({
        target: [
          commentDrafts.orgId,
          commentDrafts.userId,
          commentDrafts.ticketId,
        ],
        set: { body: input.body, updatedAt: new Date() },
      })
      .returning();

    return row;
  }

  async deleteOne(orgId: string, userId: string, id: number) {
    const [draft] = await this.db
      .select({ id: commentDrafts.id })
      .from(commentDrafts)
      .where(
        and(
          eq(commentDrafts.id, id),
          eq(commentDrafts.orgId, orgId),
          eq(commentDrafts.userId, userId),
        ),
      )
      .limit(1);

    if (!draft) throw new NotFoundException("Draft not found");

    await this.db
      .delete(commentDrafts)
      .where(
        and(
          eq(commentDrafts.id, id),
          eq(commentDrafts.orgId, orgId),
          eq(commentDrafts.userId, userId),
        ),
      );

    return { deleted: true };
  }

  async deleteByTicket(orgId: string, userId: string, ticketId: number) {
    await this.db
      .delete(commentDrafts)
      .where(
        and(
          eq(commentDrafts.orgId, orgId),
          eq(commentDrafts.userId, userId),
          eq(commentDrafts.ticketId, ticketId),
        ),
      );
    return { deleted: true };
  }

  async deleteAllMine(orgId: string, userId: string) {
    await this.db
      .delete(commentDrafts)
      .where(
        and(eq(commentDrafts.orgId, orgId), eq(commentDrafts.userId, userId)),
      );
    return { deleted: true };
  }
}
