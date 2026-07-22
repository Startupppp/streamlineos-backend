import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { commentDrafts } from "../../db/schema/comment-drafts";
import { tickets } from "../../db/schema/projects/tasks";
import { projects } from "../../db/schema/projects/core";
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
        ticketId: commentDrafts.ticketId,
        body: commentDrafts.body,
        createdAt: commentDrafts.createdAt,
        updatedAt: commentDrafts.updatedAt,
        ticketNumber: tickets.ticketNumber,
        ticketTitle: tickets.title,
        projectId: tickets.projectId,
        projectKey: projects.key,
      })
      .from(commentDrafts)
      .innerJoin(tickets, eq(tickets.id, commentDrafts.ticketId))
      .leftJoin(projects, and(eq(projects.id, tickets.projectId), eq(projects.orgId, orgId)))
      .where(and(eq(commentDrafts.orgId, orgId), eq(commentDrafts.userId, userId)))
      .orderBy(commentDrafts.updatedAt);

    return rows.map((r) => ({
      id: r.id,
      ticketId: r.ticketId,
      body: r.body,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ticket: {
        id: r.ticketId,
        ticketNumber: r.ticketNumber,
        title: r.ticketTitle,
        projectId: r.projectId,
        projectKey: r.projectKey ?? null,
      },
    }));
  }

  async upsert(orgId: string, userId: string, ticketId: number, input: UpsertCommentDraftInput) {
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
        target: [commentDrafts.orgId, commentDrafts.userId, commentDrafts.ticketId],
        set: { body: input.body, updatedAt: new Date() },
      })
      .returning();

    return row;
  }

  async deleteOne(orgId: string, userId: string, id: number) {
    const [draft] = await this.db
      .select({ id: commentDrafts.id })
      .from(commentDrafts)
      .where(and(eq(commentDrafts.id, id), eq(commentDrafts.orgId, orgId), eq(commentDrafts.userId, userId)))
      .limit(1);

    if (!draft) throw new NotFoundException("Draft not found");

    await this.db.delete(commentDrafts).where(
      and(eq(commentDrafts.id, id), eq(commentDrafts.orgId, orgId), eq(commentDrafts.userId, userId)),
    );

    return { deleted: true };
  }

  async deleteByTicket(orgId: string, userId: string, ticketId: number) {
    await this.db.delete(commentDrafts).where(
      and(eq(commentDrafts.orgId, orgId), eq(commentDrafts.userId, userId), eq(commentDrafts.ticketId, ticketId)),
    );
    return { deleted: true };
  }

  async deleteAllMine(orgId: string, userId: string) {
    await this.db.delete(commentDrafts).where(
      and(eq(commentDrafts.orgId, orgId), eq(commentDrafts.userId, userId)),
    );
    return { deleted: true };
  }
}
