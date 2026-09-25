import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { kbPages, kbArticleChunks } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { MovePageInput } from "./dto/kb-pages.schemas";
import type { ListPageTreeChildrenInput } from "./dto/kb-page-tree.dto";
import { KB_PAGE_COLUMNS, type KbPageRow } from "./kb-page-columns";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { collectSubtreeIds } from "./kb-page-subtree.util";
import { resolveProjectAccess } from "../../build/core/project-access";
import {
  buildCursorPage,
  decodeCursor,
  type CursorPage,
} from "../../../common/pagination/cursor";
import { keysetAfterIntValue } from "../../../common/pagination/keyset";

type PageRow = KbPageRow;

type KbPageTreeItem = {
  id: number;
  parentPageId: number | null;
  spaceId: number | null;
  projectId: number | null;
  title: string;
  icon: string | null;
  coverImage: string | null;
  sortOrder: number;
  visibility: string;
  createdById: string | null;
  status: string;
  updatedAt: Date;
  hasChildren: boolean;
};

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
    private readonly auth: KnowledgeAuthorizationService,
    private readonly access: AccessService,
  ) {}

  async getTreeLevel(
    user: CurrentUserContext,
    input: ListPageTreeChildrenInput,
  ): Promise<CursorPage<KbPageTreeItem>> {
    if (input.projectId !== undefined) {
      const { hasAccess } = await resolveProjectAccess(
        this.db,
        this.access,
        user,
        input.projectId,
      );
      if (!hasAccess) throw new NotFoundException("Project not found");
    }
    const orgId = user.orgId;
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const filters: SQL[] = [
      eq(kbPages.orgId, orgId),
      isNull(kbPages.deletedAt),
      predicate,
    ];

    if (input.parentId !== undefined) {
      filters.push(eq(kbPages.parentPageId, input.parentId));
    } else {
      filters.push(isNull(kbPages.parentPageId));
    }

    if (input.spaceId !== undefined) {
      filters.push(eq(kbPages.spaceId, input.spaceId));
    }
    if (input.projectId !== undefined) {
      filters.push(eq(kbPages.projectId, input.projectId));
    }

    const position = decodeCursor(input.cursor);
    if (position) {
      filters.push(
        keysetAfterIntValue(kbPages.sortOrder, kbPages.id, position),
      );
    }

    const limit = input.limit;
    const rows = await this.db
      .select({
        id: kbPages.id,
        parentPageId: kbPages.parentPageId,
        spaceId: kbPages.spaceId,
        projectId: kbPages.projectId,
        title: kbPages.title,
        icon: kbPages.icon,
        coverImage: kbPages.coverImage,
        sortOrder: kbPages.sortOrder,
        visibility: kbPages.visibility,
        createdById: kbPages.createdById,
        status: kbPages.status,
        updatedAt: kbPages.updatedAt,
      })
      .from(kbPages)
      .where(and(...filters))
      .orderBy(kbPages.sortOrder, kbPages.id)
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: String(row.sortOrder),
      id: String(row.id),
    }));

    const returnedIds = page.data.map((r) => r.id);
    const childParentSet = new Set<number>();
    if (returnedIds.length > 0) {
      const childRows = await this.db
        .select({ parentPageId: kbPages.parentPageId })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            isNull(kbPages.deletedAt),
            sql`${kbPages.parentPageId} = ANY(ARRAY[${sql.join(
              returnedIds.map((id) => sql`${id}`),
              sql`, `,
            )}]::int[])`,
          ),
        );
      childRows.forEach((r) => {
        if (r.parentPageId !== null) childParentSet.add(r.parentPageId);
      });
    }

    return {
      data: page.data.map((r) => ({
        ...r,
        sortOrder: r.sortOrder ?? 0,
        hasChildren: childParentSet.has(r.id),
      })),
      pagination: page.pagination,
    };
  }

  async softDelete(
    user: CurrentUserContext,
    pageId: number,
  ): Promise<{ deletedCount: number }> {
    await this.auth.assertPageAccess(user, pageId, "manage");
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
      const ids = await collectSubtreeIds(tx, orgId, pageId);
      await tx
        .update(kbPages)
        .set({ deletedAt, deletedById })
        .where(
          and(
            eq(kbPages.orgId, orgId),
            sql`${kbPages.id} = ANY(ARRAY[${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )}]::int[])`,
          ),
        );
      if (ids.length > 0)
        await tx
          .delete(kbArticleChunks)
          .where(
            and(
              eq(kbArticleChunks.orgId, orgId),
              inArray(kbArticleChunks.pageId, ids),
            ),
          );
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
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), predicate),
      columns: { id: true, parentPageId: true, deletedAt: true, title: true },
    });
    if (!page) throw new NotFoundException("Page not found");
    if (!page.deletedAt) throw new ConflictException("Page is not in trash");

    const restored = await this.db.transaction(async (tx) => {
      const subtreeIds = await collectSubtreeIds(tx, orgId, pageId);

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
            sql`${kbPages.id} = ANY(ARRAY[${sql.join(
              subtreeIds.map((id) => sql`${id}`),
              sql`, `,
            )}]::int[])`,
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
      await OutboxWriter.emitMany(
        tx,
        pagesToIndex
          .filter((p) => Boolean(p.contentText?.trim()))
          .map((p) => ({
            eventId: randomUUID(),
            organizationId: orgId,
            aggregateType: "kb_page",
            aggregateId: String(p.id),
            aggregateVersion: Date.now(),
            eventType: "kb.content.index",
            payload: {
              contentType: "page",
              contentId: p.id,
              contentRevision: p.contentRevision,
              aclRevision: p.aclRevision,
            },
            occurredAt: new Date(),
          })),
      );

      const [restoredPage] = await tx
        .select(KB_PAGE_COLUMNS)
        .from(kbPages)
        .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)));
      if (!restoredPage)
        throw new NotFoundException("Page not found after restore");
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

  async move(
    user: CurrentUserContext,
    pageId: number,
    input: MovePageInput,
  ): Promise<PageRow> {
    await this.auth.assertPageAccess(user, pageId, "edit");
    const orgId = user.orgId;

    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, orgId),
        isNull(kbPages.deletedAt),
      ),
      columns: { id: true, parentPageId: true },
    });
    if (!page) throw new NotFoundException("Page not found");

    const targetParentId = input.parentPageId;

    if (targetParentId !== null) {
      if (targetParentId === pageId)
        throw new BadRequestException("A page cannot be its own parent");
      await this.auth.assertPageAccess(user, targetParentId, "edit");

      const allPages = await this.db
        .select({ id: kbPages.id, parentPageId: kbPages.parentPageId })
        .from(kbPages)
        .where(and(eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)));

      if (isDescendant(allPages, pageId, targetParentId)) {
        throw new BadRequestException(
          "Cannot move a page into one of its own descendants",
        );
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
            targetParentId === null
              ? isNull(kbPages.parentPageId)
              : eq(kbPages.parentPageId, targetParentId),
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
        .returning(KB_PAGE_COLUMNS);
      if (!updated) throw new NotFoundException("Page not found");
      return updated;
    });
  }
}
