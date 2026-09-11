import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { feedbackPosts, feedbackVotes } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { assertLinkedRoadmapItemInOrg } from "./roadmap-references";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";
import type {
  CreateFeedbackInput,
  FeedbackListQuery,
  MergeFeedbackInput,
  UpdateFeedbackInput,
} from "./dto/projects.schemas";

@Injectable()
export class ProjectsFeedbackService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listFeedback(orgId: string, query: FeedbackListQuery) {
    const { cursor, limit: rawLimit } = query;
    const limit = Math.min(rawLimit, PAGE_SIZE_CAP);
    const position = decodeCursor(cursor);
    const conditions = [eq(feedbackPosts.orgId, orgId), isNull(feedbackPosts.deletedAt)];
    if (!query.includeMerged) conditions.push(isNull(feedbackPosts.duplicateOfId));
    if (query.status) conditions.push(eq(feedbackPosts.status, query.status));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(
        sql`${feedbackPosts.title} ILIKE ${term}`,
        sql`${feedbackPosts.description} ILIKE ${term}`,
      );
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
    await assertLinkedRoadmapItemInOrg(this.db, orgId, input.linkedRoadmapItemId);
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
    await assertLinkedRoadmapItemInOrg(this.db, orgId, input.linkedRoadmapItemId);
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
}
