import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, ilike, or } from "drizzle-orm";
import { changelogEntries, feedbackPosts, roadmapItems } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  ChangelogListQuery,
  CreateChangelogInput,
  CreateFeedbackInput,
  CreateRoadmapInput,
  FeedbackListQuery,
  RoadmapListQuery,
  UpdateChangelogInput,
  UpdateFeedbackInput,
  UpdateRoadmapInput,
} from "./dto/projects.schemas";

@Injectable()
export class ProjectsRoadmapService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listRoadmap(orgId: string, query: RoadmapListQuery) {
    const { page, limit } = query;
    const effectiveLimit = Math.min(limit, 100);
    const offset = (page - 1) * effectiveLimit;
    const conditions = [eq(roadmapItems.orgId, orgId)];
    if (query.status) conditions.push(eq(roadmapItems.status, query.status));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(ilike(roadmapItems.title, term), ilike(roadmapItems.description, term));
      if (match) conditions.push(match);
    }
    return this.db.query.roadmapItems.findMany({
      where: and(...conditions),
      orderBy: [asc(roadmapItems.sortOrder), asc(roadmapItems.id)],
      limit: effectiveLimit,
      offset,
    });
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
      where: and(eq(roadmapItems.id, itemId), eq(roadmapItems.orgId, orgId)),
    });
    if (!item) throw new NotFoundException("Roadmap item not found");
    return item;
  }

  async updateRoadmap(orgId: string, itemId: number, input: UpdateRoadmapInput) {
    const [updated] = await this.db
      .update(roadmapItems)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(roadmapItems.id, itemId), eq(roadmapItems.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Roadmap item not found");
    return updated;
  }

  async deleteRoadmap(orgId: string, itemId: number) {
    const [deleted] = await this.db
      .delete(roadmapItems)
      .where(and(eq(roadmapItems.id, itemId), eq(roadmapItems.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Roadmap item not found");
    return { success: true };
  }

  listFeedback(orgId: string, query: FeedbackListQuery) {
    const { page, limit } = query;
    const effectiveLimit = Math.min(limit, 100);
    const offset = (page - 1) * effectiveLimit;
    const conditions = [eq(feedbackPosts.orgId, orgId)];
    if (query.status) conditions.push(eq(feedbackPosts.status, query.status));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(ilike(feedbackPosts.title, term), ilike(feedbackPosts.description, term));
      if (match) conditions.push(match);
    }
    return this.db.query.feedbackPosts.findMany({
      where: and(...conditions),
      orderBy: [desc(feedbackPosts.votes), asc(feedbackPosts.id)],
      limit: effectiveLimit,
      offset,
    });
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
      where: and(eq(feedbackPosts.id, postId), eq(feedbackPosts.orgId, orgId)),
    });
    if (!post) throw new NotFoundException("Feedback post not found");
    return post;
  }

  async updateFeedback(orgId: string, postId: number, input: UpdateFeedbackInput) {
    const [updated] = await this.db
      .update(feedbackPosts)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(feedbackPosts.id, postId), eq(feedbackPosts.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Feedback post not found");
    return updated;
  }

  async deleteFeedback(orgId: string, postId: number) {
    const [deleted] = await this.db
      .delete(feedbackPosts)
      .where(and(eq(feedbackPosts.id, postId), eq(feedbackPosts.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Feedback post not found");
    return { success: true };
  }

  listChangelog(orgId: string, query: ChangelogListQuery) {
    const { page, limit } = query;
    const effectiveLimit = Math.min(limit, 100);
    const offset = (page - 1) * effectiveLimit;
    const conditions = [eq(changelogEntries.orgId, orgId)];
    if (query.type) conditions.push(eq(changelogEntries.type, query.type));
    return this.db.query.changelogEntries.findMany({
      where: and(...conditions),
      orderBy: [desc(changelogEntries.createdAt), desc(changelogEntries.id)],
      limit: effectiveLimit,
      offset,
    });
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
