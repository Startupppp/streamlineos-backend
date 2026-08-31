import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { kbPages, kbPageLinks } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertPageAccessible } from "../retrieval/kb-page-access.util";
import { extractPageLinkIds } from "./kb-page-content.util";

type PageRow = typeof kbPages.$inferSelect;
type KbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class KbPageDuplicateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async duplicate(user: CurrentUserContext, pageId: number): Promise<PageRow> {
    await assertPageAccessible(this.db, user, pageId);
    const orgId = user.orgId;
    const root = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
    });
    if (!root) throw new NotFoundException("Page not found");

    await this.planLimits.assertWithinLimit(orgId, "kbPages");

    return this.db.transaction(async (tx) => {
      const subtreeMap = await this.buildSubtreeMap(tx, orgId, pageId);
      const idMapping = new Map<number, number>();

      for (const [originalId, original] of subtreeMap.entries()) {
        const isRoot = originalId === pageId;
        const newParentId = isRoot
          ? original.parentPageId
          : (idMapping.get(original.parentPageId ?? -1) ?? null);

        const siblings = await tx
          .select({ sortOrder: kbPages.sortOrder })
          .from(kbPages)
          .where(
            and(
              eq(kbPages.orgId, orgId),
              isNull(kbPages.deletedAt),
              newParentId === null ? isNull(kbPages.parentPageId) : eq(kbPages.parentPageId, newParentId),
            ),
          )
          .orderBy(sql`${kbPages.sortOrder} desc`)
          .limit(1);
        const maxSort = siblings[0]?.sortOrder ?? 0;

        const [created] = await tx
          .insert(kbPages)
          .values({
            orgId,
            spaceId: original.spaceId,
            parentPageId: newParentId,
            title: isRoot ? `${original.title} (copy)` : original.title,
            icon: original.icon,
            coverImage: original.coverImage,
            content: original.content ?? null,
            contentText: original.contentText,
            sortOrder: maxSort + 100,
            isLocked: false,
            createdById: user.userId,
            lastEditedById: user.userId,
          })
          .returning();
        if (!created) throw new Error("Failed to duplicate page");
        idMapping.set(originalId, created.id);

        const linkIds = extractPageLinkIds(original.content);
        if (linkIds.length > 0) {
          const validLinks = await tx
            .select({ id: kbPages.id })
            .from(kbPages)
            .where(
              and(
                eq(kbPages.orgId, orgId),
                sql`${kbPages.id} = ANY(ARRAY[${sql.join(linkIds.map((id) => sql`${id}`), sql`, `)}]::int[])`,
              ),
            );
          const validIds = validLinks.map((l) => l.id);
          if (validIds.length > 0) {
            await tx.insert(kbPageLinks).values(
              validIds.map((targetId) => ({ orgId, sourcePageId: created.id, targetPageId: targetId })),
            ).onConflictDoNothing();
          }
        }
      }

      const newRootId = idMapping.get(pageId);
      if (!newRootId) throw new Error("Duplication root lost");
      const [newRoot] = await tx.select().from(kbPages).where(eq(kbPages.id, newRootId));
      if (!newRoot) throw new NotFoundException("Duplicated page not found");
      return newRoot;
    });
  }

  private async buildSubtreeMap(
    tx: KbTransaction,
    orgId: string,
    rootId: number,
  ): Promise<Map<number, PageRow>> {
    const idRows = await tx.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id, parent_page_id, 1 AS depth
        FROM kb_pages
        WHERE id = ${rootId} AND org_id = ${orgId} AND deleted_at IS NULL
        UNION ALL
        SELECT p.id, p.parent_page_id, s.depth + 1
        FROM kb_pages p
        INNER JOIN subtree s ON p.parent_page_id = s.id AND s.depth < 1000
        WHERE p.org_id = ${orgId} AND p.deleted_at IS NULL
      )
      SELECT id FROM subtree
    `);
    const ids = (idRows as Array<Record<string, unknown>>).map((row) => Number(row.id));
    if (ids.length === 0) return new Map();
    const pages = await tx
      .select()
      .from(kbPages)
      .where(and(eq(kbPages.orgId, orgId), inArray(kbPages.id, ids), isNull(kbPages.deletedAt)));
    return new Map(pages.map((p) => [p.id, p]));
  }
}
