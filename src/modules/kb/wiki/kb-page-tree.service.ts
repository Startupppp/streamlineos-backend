import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, getTableColumns, inArray, isNull, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import { pageVisibleTo } from "../retrieval/kb-page-visibility";
import { getAccessibleProjectIds } from "../retrieval/kb-project-access.util";
import { kbPages, kbPageLinks, kbArticleChunks } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { extractPageLinkIds } from "./kb-page-content.util";
import { AuditService } from "../../../common/audit/audit.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { MovePageInput } from "./dto/kb-pages.schemas";
import { assertPageAccessible } from "../retrieval/kb-page-access.util";

type PageRow = typeof kbPages.$inferSelect;
type KbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const {
  content: _content,
  contentText: _contentText,
  fts: _fts,
  ...KB_PAGE_LIST_COLUMNS
} = getTableColumns(kbPages);
type KbPageListItem = Omit<PageRow, "content" | "contentText" | "fts">;

const MAX_TREE_NODES = 2000;
const EXPIRED_PURGE_BATCH_SIZE = 500;

export function isDescendant(
  allPages: Pick<PageRow, "id" | "parentPageId">[],
  ancestorId: number,
  candidateId: number,
): boolean {
  const parentMap = new Map<number, number | null>(
    allPages.map((p) => [p.id, p.parentPageId]),
  );
  let current: number | null = parentMap.get(candidateId) ?? null;
  const visited = new Set<number>();
  while (current !== null && current !== undefined) {
    if (visited.has(current)) break;
    visited.add(current);
    if (current === ancestorId) return true;
    current = parentMap.get(current) ?? null;
  }
  return false;
}

@Injectable()
export class KbPageTreeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async getTree(user: CurrentUserContext, projectId?: number): Promise<{
    id: number;
    parentPageId: number | null;
    spaceId: number | null;
    projectId: number | null;
    title: string;
    icon: string | null;
    sortOrder: number;
    visibility: string;
    createdById: string | null;
    status: string;
    hasChildren: boolean;
  }[]> {
    const orgId = user.orgId;
    const projectIds = await getAccessibleProjectIds(this.db, user);
    const filters: SQL[] = [eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt), pageVisibleTo(user, projectIds)];
    if (projectId !== undefined) {
      filters.push(eq(kbPages.projectId, projectId));
    }
    const rows = await this.db
      .select({
        id: kbPages.id,
        parentPageId: kbPages.parentPageId,
        spaceId: kbPages.spaceId,
        projectId: kbPages.projectId,
        title: kbPages.title,
        icon: kbPages.icon,
        sortOrder: kbPages.sortOrder,
        visibility: kbPages.visibility,
        createdById: kbPages.createdById,
        status: kbPages.status,
      })
      .from(kbPages)
      .where(and(...filters))
      .orderBy(kbPages.sortOrder)
      .limit(MAX_TREE_NODES);

    const childSet = new Set(rows.map((r) => r.parentPageId).filter((id): id is number => id !== null));
    return rows.map((r) => ({ ...r, hasChildren: childSet.has(r.id) }));
  }

  async softDelete(user: CurrentUserContext, pageId: number): Promise<{ deletedCount: number }> {
    await assertPageAccessible(this.db, user, pageId);
    const orgId = user.orgId;
    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)),
      columns: { id: true, deletedAt: true, title: true },
    });
    if (!page) throw new NotFoundException("Page not found");

    const now = new Date();
    const deletedAt = now;
    const deletedById = user.userId;

    const deleted = await this.db.transaction(async (tx) => {
      const ids = await this.collectSubtreeIds(tx, orgId, pageId);
      await tx
        .update(kbPages)
        .set({ deletedAt, deletedById })
        .where(
          and(
            eq(kbPages.orgId, orgId),
            sql`${kbPages.id} = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::int[])`,
          ),
        );
      if (ids.length > 0)
        await tx
          .delete(kbArticleChunks)
          .where(and(eq(kbArticleChunks.orgId, orgId), inArray(kbArticleChunks.pageId, ids)));
      return ids.length;
    });

    this.audit.log({
      action: "kb.page.deleted",
      userId: user.userId,
      orgId,
      resourceType: "kb_page",
      resourceId: String(pageId),
      metadata: { pageTitle: page.title, subtreeSize: deleted },
    });

    return { deletedCount: deleted };
  }

  async restore(user: CurrentUserContext, pageId: number): Promise<PageRow> {
    const orgId = user.orgId;
    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)),
      columns: { id: true, parentPageId: true, deletedAt: true, title: true },
    });
    if (!page) throw new NotFoundException("Page not found");
    if (!page.deletedAt) throw new ConflictException("Page is not in trash");

    const restored = await this.db.transaction(async (tx) => {
      const subtreeIds = await this.collectSubtreeIds(tx, orgId, pageId);

      let parentPageId = page.parentPageId;
      if (parentPageId !== null) {
        const parent = await tx.query.kbPages.findFirst({
          where: and(eq(kbPages.id, parentPageId), eq(kbPages.orgId, orgId)),
          columns: { deletedAt: true },
        });
        if (parent?.deletedAt) parentPageId = null;
      }

      await tx
        .update(kbPages)
        .set({ deletedAt: null, deletedById: null })
        .where(
          and(
            eq(kbPages.orgId, orgId),
            sql`${kbPages.id} = ANY(ARRAY[${sql.join(subtreeIds.map((id) => sql`${id}`), sql`, `)}]::int[])`,
          ),
        );

      if (parentPageId !== page.parentPageId) {
        await tx
          .update(kbPages)
          .set({ parentPageId })
          .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)));
      }

      const pagesToIndex = await tx
        .select({
          id: kbPages.id,
          contentRevision: kbPages.contentRevision,
          aclRevision: kbPages.aclRevision,
          contentText: kbPages.contentText,
        })
        .from(kbPages)
        .where(and(eq(kbPages.orgId, orgId), inArray(kbPages.id, subtreeIds)));
      for (const p of pagesToIndex) {
        if (!p.contentText?.trim()) continue;
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "kb_page",
          aggregateId: String(p.id),
          aggregateVersion: Date.now(),
          eventType: "kb.content.index",
          payload: { contentType: "page", contentId: p.id, contentRevision: p.contentRevision, aclRevision: p.aclRevision },
          occurredAt: new Date(),
        });
      }

      const [restoredPage] = await tx
        .select()
        .from(kbPages)
        .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)));
      if (!restoredPage) throw new NotFoundException("Page not found after restore");
      return restoredPage;
    });

    this.audit.log({
      action: "kb.page.restored",
      userId: user.userId,
      orgId,
      resourceType: "kb_page",
      resourceId: String(pageId),
      metadata: { pageTitle: page.title },
    });

    return restored;
  }

  async hardDelete(user: CurrentUserContext, pageId: number): Promise<void> {
    const orgId = user.orgId;
    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)),
      columns: { id: true, title: true },
    });
    if (!page) throw new NotFoundException("Page not found");

    await this.db.transaction(async (tx) => {
      const subtreeIds = await this.collectSubtreeIds(tx, orgId, pageId);
      await tx
        .delete(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            sql`${kbPages.id} = ANY(ARRAY[${sql.join(subtreeIds.map((id) => sql`${id}`), sql`, `)}]::int[])`,
          ),
        );
    });

    this.audit.log({
      action: "kb.page.permanently_deleted",
      userId: user.userId,
      orgId,
      resourceType: "kb_page",
      resourceId: String(pageId),
      metadata: { pageTitle: page.title },
    });
  }

  async emptyTrash(user: CurrentUserContext): Promise<{ purgedCount: number }> {
    const orgId = user.orgId;
    const deleted = await this.db
      .delete(kbPages)
      .where(and(eq(kbPages.orgId, orgId), isNotNull(kbPages.deletedAt)))
      .returning({ id: kbPages.id });

    if (deleted.length === 0) return { purgedCount: 0 };

    this.audit.log({
      action: "kb.trash.emptied",
      userId: user.userId,
      orgId,
      resourceType: "kb_page",
      metadata: { purgedCount: deleted.length },
    });

    return { purgedCount: deleted.length };
  }

  async purgeExpired(orgId: string, olderThan: Date): Promise<number> {
    let purgedCount = 0;
    for (;;) {
      const expired = await this.db
        .select({ id: kbPages.id })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            isNotNull(kbPages.deletedAt),
            lt(kbPages.deletedAt, olderThan),
          ),
        )
        .orderBy(kbPages.id)
        .limit(EXPIRED_PURGE_BATCH_SIZE);

      if (expired.length === 0) break;

      const ids = expired.map((p) => p.id);
      await this.db
        .delete(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            sql`${kbPages.id} = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::int[])`,
          ),
        );
      purgedCount += ids.length;
    }

    if (purgedCount === 0) return 0;

    this.audit.log({
      action: "kb.page.auto_purged",
      userId: "system",
      orgId,
      resourceType: "kb_page",
      metadata: { purgedCount, olderThan: olderThan.toISOString() },
    });

    return purgedCount;
  }

  async move(user: CurrentUserContext, pageId: number, input: MovePageInput): Promise<PageRow> {
    await assertPageAccessible(this.db, user, pageId);
    const orgId = user.orgId;

    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
      columns: { id: true, parentPageId: true },
    });
    if (!page) throw new NotFoundException("Page not found");

    const targetParentId = input.parentPageId;

    if (targetParentId !== null) {
      if (targetParentId === pageId) throw new BadRequestException("A page cannot be its own parent");
      const targetParent = await this.db.query.kbPages.findFirst({
        where: and(eq(kbPages.id, targetParentId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
        columns: { id: true },
      });
      if (!targetParent) throw new NotFoundException("Target parent page not found");

      const allPages = await this.db
        .select({ id: kbPages.id, parentPageId: kbPages.parentPageId })
        .from(kbPages)
        .where(and(eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)));

      if (isDescendant(allPages, pageId, targetParentId)) {
        throw new BadRequestException("Cannot move a page into one of its own descendants");
      }
    }

    return this.db.transaction(async (tx) => {
      const siblings = await tx
        .select({ id: kbPages.id, sortOrder: kbPages.sortOrder })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            isNull(kbPages.deletedAt),
            targetParentId === null ? isNull(kbPages.parentPageId) : eq(kbPages.parentPageId, targetParentId),
            sql`${kbPages.id} != ${pageId}`,
          ),
        )
        .orderBy(kbPages.sortOrder);

      const insertAt = Math.min(input.index, siblings.length);
      let counter = 100;
      for (let i = 0; i < siblings.length; i++) {
        if (i === insertAt) counter += 100;
        const sibling = siblings[i];
        if (sibling) {
          await tx
            .update(kbPages)
            .set({ sortOrder: counter })
            .where(and(eq(kbPages.id, sibling.id), eq(kbPages.orgId, orgId)));
        }
        counter += 100;
      }
      const newSortOrder = insertAt * 100 + 100;

      const [updated] = await tx
        .update(kbPages)
        .set({ parentPageId: targetParentId, sortOrder: newSortOrder })
        .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
        .returning();
      if (!updated) throw new NotFoundException("Page not found");
      return updated;
    });
  }

  async getTrash(user: CurrentUserContext): Promise<KbPageListItem[]> {
    const orgId = user.orgId;
    const projectIds = await getAccessibleProjectIds(this.db, user);
    return this.db
      .select(KB_PAGE_LIST_COLUMNS)
      .from(kbPages)
      .where(and(eq(kbPages.orgId, orgId), isNotNull(kbPages.deletedAt), pageVisibleTo(user, projectIds)))
      .orderBy(sql`${kbPages.deletedAt} desc`)
      .limit(100);
  }

  private async collectSubtreeIds(
    tx: KbTransaction,
    orgId: string,
    rootId: number,
  ): Promise<number[]> {
    const rows = await tx.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id, parent_page_id, 1 AS depth
        FROM kb_pages
        WHERE id = ${rootId} AND org_id = ${orgId}
        UNION ALL
        SELECT p.id, p.parent_page_id, s.depth + 1
        FROM kb_pages p
        INNER JOIN subtree s ON p.parent_page_id = s.id AND s.depth < 1000
        WHERE p.org_id = ${orgId}
      )
      SELECT id FROM subtree
    `);
    return (rows as Array<Record<string, unknown>>).map((row) => Number(row.id));
  }

}
