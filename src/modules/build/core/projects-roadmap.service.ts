import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gt, ilike, isNull, lt, or, sql } from "drizzle-orm";
import { changelogEntries, feedbackPosts, feedbackVotes, roadmapItems } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  ChangelogListQuery,
  CreateChangelogInput,
  CreateFeedbackInput,
  CreateRoadmapInput,
  FeedbackListQuery,
  MergeFeedbackInput,
  RoadmapListQuery,
  UpdateChangelogInput,
  UpdateFeedbackInput,
  UpdateRoadmapInput,
} from "./dto/projects.schemas";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";

@Injectable()
export class ProjectsRoadmapService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listRoadmap(orgId: string, query: RoadmapListQuery) {
    const { cursor, limit: rawLimit } = query;
    const limit = Math.min(rawLimit, PAGE_SIZE_CAP);
    const position = decodeCursor(cursor);
    const conditions = [eq(roadmapItems.orgId, orgId), isNull(roadmapItems.deletedAt)];
    if (query.status) conditions.push(eq(roadmapItems.status, query.status));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(ilike(roadmapItems.title, term), ilike(roadmapItems.description, term));
      if (match) conditions.push(match);
    }
    if (position) {
      const sortVal = Number(position.sortValue);
      const cursorId = Number(position.id);
      conditions.push(
        or(
          gt(roadmapItems.sortOrder, sortVal),
          and(eq(roadmapItems.sortOrder, sortVal), gt(roadmapItems.id, cursorId)),
        )!,
      );
    }
    const where = and(...conditions);
    const rows = await this.db.query.roadmapItems.findMany({
      where,
      orderBy: [asc(roadmapItems.sortOrder), asc(roadmapItems.id)],
      limit: limit + 1,
    });
    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: String(row.sortOrder),
      id: String(row.id),
    }));
    return {
      data: page.data,
      pagination: {
        limit: page.pagination.limit,
        nextCursor: page.pagination.nextCursor,
        hasMore: page.pagination.hasMore,
      },
    };
  }

  async createRoadmap(orgId: string, userId: string, input: CreateRoadmapInput) {
    const [item] = await this.db
      .insert(roadmapItems)
      .values({
        orgId,
        title: input.title,
        description: input.description ?? null,
        status: input.status,
        category: input.category ?? null,
        isPublic: input.isPublic,
        projectId: input.projectId ?? null,
        epicTicketId: input.epicTicketId ?? null,
        targetQuarter: input.targetQuarter ?? null,
        sortOrder: input.sortOrder,
        createdBy: userId,
      })
      .returning();
    return item;
  }

  async getRoadmap(orgId: string, itemId: number) {
    const item = await this.db.query.roadmapItems.findFirst({
      where: and(eq(roadmapItems.id, itemId), eq(roadmapItems.orgId, orgId), isNull(roadmapItems.deletedAt)),
    });
    if (!item) throw new NotFoundException("Roadmap item not found");
    return item;
  }

  async updateRoadmap(orgId: string, itemId: number, input: UpdateRoadmapInput) {
    const [updated] = await this.db
      .update(roadmapItems)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(roadmapItems.id, itemId), eq(roadmapItems.orgId, orgId), isNull(roadmapItems.deletedAt)))
      .returning();
    if (!updated) throw new NotFoundException("Roadmap item not found");
    return updated;
  }

  async deleteRoadmap(orgId: string, itemId: number) {
    const [deleted] = await this.db
      .update(roadmapItems)
      .set({ deletedAt: new Date() })
      .where(and(eq(roadmapItems.id, itemId), eq(roadmapItems.orgId, orgId), isNull(roadmapItems.deletedAt)))
      .returning({ id: roadmapItems.id });
    if (!deleted) throw new NotFoundException("Roadmap item not found");
    return { success: true };
  }

  async listFeedback(orgId: string, query: FeedbackListQuery) {
    const { cursor, limit: rawLimit } = query;
    const limit = Math.min(rawLimit, PAGE_SIZE_CAP);
    const position = decodeCursor(cursor);
    const conditions = [eq(feedbackPosts.orgId, orgId), isNull(feedbackPosts.deletedAt)];
    if (!query.includeMerged) conditions.push(isNull(feedbackPosts.duplicateOfId));
    if (query.status) conditions.push(eq(feedbackPosts.status, query.status));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(ilike(feedbackPosts.title, term), ilike(feedbackPosts.description, term));
      if (match) conditions.push(match);
    }
    if (position) {
      const cursorVotes = Number(position.sortValue);
      const cursorId = Number(position.id);
      conditions.push(
        or(
          lt(feedbackPosts.votes, cursorVotes),
          and(eq(feedbackPosts.votes, cursorVotes), gt(feedbackPosts.id, cursorId)),
        )!,
      );
    }
    const where = and(...conditions);
    const rows = await this.db.query.feedbackPosts.findMany({
      where,
      orderBy: [desc(feedbackPosts.votes), asc(feedbackPosts.id)],
      limit: limit + 1,
    });
    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: String(row.votes),
      id: String(row.id),
    }));
    return {
      data: page.data,
      pagination: {
        limit: page.pagination.limit,
        nextCursor: page.pagination.nextCursor,
        hasMore: page.pagination.hasMore,
      },
    };
  }

  async createFeedback(orgId: string, userId: string, input: CreateFeedbackInput) {
    const [post] = await this.db
      .insert(feedbackPosts)
      .values({
        orgId,
        title: input.title,
        description: input.description ?? null,
        status: input.status,
        category: input.category ?? null,
        submittedByName: input.submittedByName ?? null,
        submittedByEmail: input.submittedByEmail ?? null,
        linkedRoadmapItemId: input.linkedRoadmapItemId ?? null,
        createdBy: userId,
      })
      .returning();
    return post;
  }

  async getFeedback(orgId: string, postId: number) {
    const post = await this.db.query.feedbackPosts.findFirst({
      where: and(eq(feedbackPosts.id, postId), eq(feedbackPosts.orgId, orgId), isNull(feedbackPosts.deletedAt)),
    });
    if (!post) throw new NotFoundException("Feedback post not found");
    return post;
  }

  async updateFeedback(orgId: string, postId: number, input: UpdateFeedbackInput) {
    const [updated] = await this.db
      .update(feedbackPosts)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(feedbackPosts.id, postId), eq(feedbackPosts.orgId, orgId), isNull(feedbackPosts.deletedAt)))
      .returning();
    if (!updated) throw new NotFoundException("Feedback post not found");
    return updated;
  }

  async mergeFeedback(orgId: string, postId: number, input: MergeFeedbackInput) {
    const targetId = input.targetPostId;
    if (targetId === postId)
      throw new BadRequestException("A feedback post cannot be merged into itself");

    return this.db.transaction(async (tx) => {
      const [source, target] = await Promise.all([
        tx.query.feedbackPosts.findFirst({
          where: and(
            eq(feedbackPosts.id, postId),
            eq(feedbackPosts.orgId, orgId),
            isNull(feedbackPosts.deletedAt),
          ),
        }),
        tx.query.feedbackPosts.findFirst({
          where: and(
            eq(feedbackPosts.id, targetId),
            eq(feedbackPosts.orgId, orgId),
            isNull(feedbackPosts.deletedAt),
          ),
        }),
      ]);
      if (!source || !target) throw new NotFoundException("Feedback post not found");
      if (source.duplicateOfId !== null)
        throw new BadRequestException("This post has already been merged");
      if (target.duplicateOfId !== null)
        throw new BadRequestException(
          "The selected post is itself a duplicate — merge into the original instead",
        );

      await tx.execute(sql`
        UPDATE build.feedback_votes v
        SET feedback_post_id = ${targetId}
        WHERE v.feedback_post_id = ${postId}
          AND v.org_id = ${orgId}
          AND NOT EXISTS (
            SELECT 1 FROM build.feedback_votes k
            WHERE k.feedback_post_id = ${targetId} AND k.voter_key = v.voter_key
          )
          AND NOT EXISTS (
            SELECT 1 FROM build.feedback_votes h
            WHERE h.feedback_post_id = ${targetId}
              AND h.voter_ip_hash IS NOT NULL
              AND h.voter_ip_hash = v.voter_ip_hash
          )
      `);

      await tx
        .delete(feedbackVotes)
        .where(and(eq(feedbackVotes.feedbackPostId, postId), eq(feedbackVotes.orgId, orgId)));

      await tx
        .update(feedbackPosts)
        .set({ duplicateOfId: targetId })
        .where(and(eq(feedbackPosts.duplicateOfId, postId), eq(feedbackPosts.orgId, orgId)));

      const now = new Date();
      await tx
        .update(feedbackPosts)
        .set({ duplicateOfId: targetId, mergedAt: now, updatedAt: now })
        .where(and(eq(feedbackPosts.id, postId), eq(feedbackPosts.orgId, orgId)));

      await tx.execute(sql`
        UPDATE build.feedback_posts p
        SET votes = (SELECT count(*) FROM build.feedback_votes v WHERE v.feedback_post_id = p.id)
        WHERE p.org_id = ${orgId} AND p.id IN (${postId}, ${targetId})
      `);

      const [canonical] = await tx
        .select()
        .from(feedbackPosts)
        .where(and(eq(feedbackPosts.id, targetId), eq(feedbackPosts.orgId, orgId)))
        .limit(1);
      return canonical;
    });
  }

  async deleteFeedback(orgId: string, postId: number) {
    const [deleted] = await this.db
      .update(feedbackPosts)
      .set({ deletedAt: new Date() })
      .where(and(eq(feedbackPosts.id, postId), eq(feedbackPosts.orgId, orgId), isNull(feedbackPosts.deletedAt)))
      .returning({ id: feedbackPosts.id });
    if (!deleted) throw new NotFoundException("Feedback post not found");
    return { success: true };
  }

  async listChangelog(orgId: string, query: ChangelogListQuery) {
    const { cursor, limit: rawLimit } = query;
    const limit = Math.min(rawLimit, PAGE_SIZE_CAP);
    const position = decodeCursor(cursor);
    const conditions = [eq(changelogEntries.orgId, orgId)];
    if (query.type) conditions.push(eq(changelogEntries.type, query.type));
    if (position) {
      const cursorDate = new Date(position.sortValue);
      const cursorId = Number(position.id);
      conditions.push(
        or(
          lt(changelogEntries.createdAt, cursorDate),
          and(eq(changelogEntries.createdAt, cursorDate), lt(changelogEntries.id, cursorId)),
        )!,
      );
    }
    const where = and(...conditions);
    const rows = await this.db.query.changelogEntries.findMany({
      where,
      orderBy: [desc(changelogEntries.createdAt), desc(changelogEntries.id)],
      limit: limit + 1,
    });
    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt ?? ""),
      id: String(row.id),
    }));
    return {
      data: page.data,
      pagination: {
        limit: page.pagination.limit,
        nextCursor: page.pagination.nextCursor,
        hasMore: page.pagination.hasMore,
      },
    };
  }

  async createChangelog(orgId: string, userId: string, input: CreateChangelogInput) {
    const [entry] = await this.db
      .insert(changelogEntries)
      .values({
        orgId,
        title: input.title,
        content: input.content,
        version: input.version ?? null,
        type: input.type,
        isPublished: input.isPublished,
        linkedRoadmapItemId: input.linkedRoadmapItemId ?? null,
        publishedAt: input.isPublished ? new Date() : null,
        createdBy: userId,
      })
      .returning();
    return entry;
  }

  async getChangelog(orgId: string, entryId: number) {
    const entry = await this.db.query.changelogEntries.findFirst({
      where: and(eq(changelogEntries.id, entryId), eq(changelogEntries.orgId, orgId)),
    });
    if (!entry) throw new NotFoundException("Changelog entry not found");
    return entry;
  }

  async updateChangelog(orgId: string, entryId: number, input: UpdateChangelogInput) {
    const existing = await this.db.query.changelogEntries.findFirst({
      where: and(eq(changelogEntries.id, entryId), eq(changelogEntries.orgId, orgId)),
      columns: { isPublished: true, publishedAt: true },
    });
    if (!existing) throw new NotFoundException("Changelog entry not found");

    let publishedAt = existing.publishedAt;
    if (input.isPublished === true && !existing.isPublished) publishedAt = new Date();
    if (input.isPublished === false) publishedAt = null;

    const [updated] = await this.db
      .update(changelogEntries)
      .set({ ...input, publishedAt, updatedAt: new Date() })
      .where(and(eq(changelogEntries.id, entryId), eq(changelogEntries.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Changelog entry not found");
    return updated;
  }

  async deleteChangelog(orgId: string, entryId: number) {
    const [deleted] = await this.db
      .delete(changelogEntries)
      .where(and(eq(changelogEntries.id, entryId), eq(changelogEntries.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Changelog entry not found");
    return { success: true };
  }
}
