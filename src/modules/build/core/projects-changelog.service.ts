import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { changelogEntries } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { ChangelogListQuery, CreateChangelogInput, UpdateChangelogInput } from "./dto/projects.schemas";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { assertLinkedRoadmapItemInOrg } from "./roadmap-references";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";

@Injectable()
export class ProjectsChangelogService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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
    await assertLinkedRoadmapItemInOrg(this.db, orgId, input.linkedRoadmapItemId);
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
    await assertLinkedRoadmapItemInOrg(this.db, orgId, input.linkedRoadmapItemId);
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
