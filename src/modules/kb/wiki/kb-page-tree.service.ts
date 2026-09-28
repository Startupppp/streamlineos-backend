import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { kbPages, kbArticleChunks } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import { actingMembershipId } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { MovePageInput } from "./dto/kb-pages.schemas";
import type { ListPageTreeChildrenInput } from "./dto/kb-page-tree.dto";
import { KB_PAGE_COLUMNS, type KbPageRow } from "./kb-page-columns";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { KbPageWriterService } from "./kb-page-writer.service";
import { collectSubtreeIds } from "./kb-page-subtree.util";
import { resolveProjectAccess } from "../../build/core";
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

export const KB_PAGE_TREE_MAX_ANCESTOR_WALK = 100;

export function ancestorWalkQuery(
  orgId: string,
  pageId: number,
  targetParentId: number,
): SQL {
  return sql`
    WITH RECURSIVE ancestors(id, parent_page_id, depth) AS (
      SELECT id, parent_page_id, 1
      FROM kb_pages
      WHERE id = ${targetParentId} AND org_id = ${orgId} AND deleted_at IS NULL
      UNION ALL
      SELECT p.id, p.parent_page_id, a.depth + 1
      FROM kb_pages p
      JOIN ancestors a ON p.id = a.parent_page_id
      WHERE p.org_id = ${orgId}
        AND p.deleted_at IS NULL
        AND a.depth < ${KB_PAGE_TREE_MAX_ANCESTOR_WALK}
    )
    SELECT 1 AS hit FROM ancestors WHERE id = ${pageId} LIMIT 1
  `;
}

@Injectable()
export class KbPageTreeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly auth: KnowledgeAuthorizationService,
    private readonly access: AccessService,
    private readonly writer: KbPageWriterService,
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
        .selectDistinct({ parentPageId: kbPages.parentPageId })
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
      await this.audit.logCritical({
        action: "kb.page.deleted",
        userId: user.userId,
        orgId,
        resourceType: "kb_page",
        resourceId: String(pageId),
        metadata: { pageTitle: page.title, subtreeSize: ids.length },
      });
      return ids.length;
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
      await this.writer.commitManyPageChanges(tx, {
        orgId,
        pages: pagesToIndex,
      });

      const [restoredPage] = await tx
        .select(KB_PAGE_COLUMNS)
        .from(kbPages)
        .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)));
      if (!restoredPage)
        throw new NotFoundException("Page not found after restore");

      await this.audit.logCritical({
        action: "kb.page.restored",
        userId: user.userId,
        orgId,
        resourceType: "kb_page",
        resourceId: String(pageId),
        metadata: { pageTitle: page.title },
      });

      return restoredPage;
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
      columns: { id: true, parentPageId: true, spaceId: true },
    });
    if (!page) throw new NotFoundException("Page not found");

    const targetParentId = input.parentPageId;
    let targetSpaceId = page.spaceId;

    if (targetParentId !== null) {
      if (targetParentId === pageId)
        throw new BadRequestException("A page cannot be its own parent");
      await this.auth.assertPageAccess(user, targetParentId, "edit");

      const targetParent = await this.db.query.kbPages.findFirst({
        where: and(
          eq(kbPages.id, targetParentId),
          eq(kbPages.orgId, orgId),
          isNull(kbPages.deletedAt),
        ),
        columns: { spaceId: true },
      });
      if (!targetParent)
        throw new NotFoundException("Target parent page not found");
      targetSpaceId = targetParent.spaceId;

      if (await this.targetSitsInsideSubtree(orgId, pageId, targetParentId))
        throw new BadRequestException(
          "Cannot move a page into one of its own descendants",
        );
    }

    if (targetSpaceId !== page.spaceId && targetSpaceId !== null) {
      await this.auth.assertSpaceAccess(user, targetSpaceId, "edit");
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

      const spaceChanged = targetSpaceId !== page.spaceId;
      const [updated] = await tx
        .update(kbPages)
        .set({
          parentPageId: targetParentId,
          sortOrder: newSortOrder,
          spaceId: targetSpaceId,
          ...(spaceChanged
            ? {
                aclRevision: sql`acl_revision + 1`,
                aclRevisionChangedAt: new Date(),
              }
            : {}),
        })
        .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
        .returning(KB_PAGE_COLUMNS);
      if (!updated) throw new NotFoundException("Page not found");

      await this.writer.commitPageChange(tx, {
        orgId,
        actor: {
          userId: user.userId,
          membershipId:
            user.principal !== undefined
              ? actingMembershipId(user.principal)
              : null,
        },
        action: "kb.page.moved",
        page: updated,
        changed: {},
      });

      return updated;
    });
  }

  private async targetSitsInsideSubtree(
    orgId: string,
    pageId: number,
    targetParentId: number,
  ): Promise<boolean> {
    const rows = await this.db.execute(
      ancestorWalkQuery(orgId, pageId, targetParentId),
    );
    return rows.length > 0;
  }
}
