import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { kbPages, kbPageLinks } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertPageAccessible } from "../retrieval/kb-page-access.util";
import { extractPageLinkIds } from "./kb-page-content.util";
import { KB_PAGE_COLUMNS, type KbPageRow } from "./kb-page-columns";

type PageRow = KbPageRow;
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
      columns: { id: true },
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
    });
    if (!root) throw new NotFoundException("Page not found");

    await this.planLimits.assertWithinLimit(orgId, "kbPages");

    return this.db.transaction(async (tx) => {
      const subtreeMap = await this.buildSubtreeMap(tx, orgId, pageId);
      const idMapping = new Map<number, number>();

      const rootPage = subtreeMap.get(pageId);
      if (!rootPage) throw new NotFoundException("Page not found");
      const rootParentId = rootPage.parentPageId;

      const [rootSibRow] = await tx
        .select({ sortOrder: kbPages.sortOrder })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            isNull(kbPages.deletedAt),
            rootParentId === null
              ? isNull(kbPages.parentPageId)
              : eq(kbPages.parentPageId, rootParentId),
          ),
        )
        .orderBy(desc(kbPages.sortOrder))
        .limit(1);
      const rootNextSort = (rootSibRow?.sortOrder ?? 0) + 100;

      let newRoot: PageRow | undefined;

      for (const level of this.levelsOf(subtreeMap, pageId)) {
        const childSortCounters = new Map<number, number>();
        const plan = level.map(function planNode(original) {
          const isRoot = original.id === pageId;
          const newParentId = isRoot
            ? original.parentPageId
            : (idMapping.get(original.parentPageId ?? -1) ?? null);
          const counterKey = newParentId ?? -1;
          const counter = (childSortCounters.get(counterKey) ?? 0) + 1;
          childSortCounters.set(counterKey, counter);
          return {
            originalId: original.id,
            values: {
              orgId,
              spaceId: original.spaceId,
              parentPageId: newParentId,
              title: isRoot ? `${original.title} (copy)` : original.title,
              icon: original.icon,
              coverImage: original.coverImage,
              content: original.content ?? null,
              contentText: original.contentText,
              sortOrder: isRoot ? rootNextSort : counter * 100,
              isLocked: false,
              createdById: user.userId,
              lastEditedById: user.userId,
            },
          };
        });

        const created = await tx
          .insert(kbPages)
          .values(plan.map((entry) => entry.values))
          .returning(KB_PAGE_COLUMNS);
        if (created.length !== plan.length) throw new Error("Failed to duplicate page");
        const createdByPosition = new Map<string, PageRow>(
          created.map(function keyRow(row) {
            return [`${row.parentPageId ?? "root"}:${row.sortOrder}`, row];
          }),
        );
        for (const entry of plan) {
          const row = createdByPosition.get(
            `${entry.values.parentPageId ?? "root"}:${entry.values.sortOrder}`,
          );
          if (!row) throw new Error("Failed to duplicate page");
          idMapping.set(entry.originalId, row.id);
          if (entry.originalId === pageId) newRoot = row;
        }
      }

      if (!newRoot) throw new NotFoundException("Duplicated page not found");

      const linkIdsByOriginal = new Map<number, number[]>();
      const allLinkIds = new Set<number>();
      for (const original of subtreeMap.values()) {
        const linkIds = extractPageLinkIds(original.content);
        if (linkIds.length === 0) continue;
        linkIdsByOriginal.set(original.id, linkIds);
        for (const linkId of linkIds) allLinkIds.add(linkId);
      }

      if (allLinkIds.size > 0) {
        const validLinks = await tx
          .select({ id: kbPages.id })
          .from(kbPages)
          .where(and(eq(kbPages.orgId, orgId), inArray(kbPages.id, [...allLinkIds])));
        const validIds = new Set(validLinks.map((l) => l.id));
        const linkRows: Array<{ orgId: string; sourcePageId: number; targetPageId: number }> = [];
        for (const [originalId, linkIds] of linkIdsByOriginal) {
          const sourcePageId = idMapping.get(originalId);
          if (sourcePageId === undefined) continue;
          for (const targetPageId of linkIds)
            if (validIds.has(targetPageId)) linkRows.push({ orgId, sourcePageId, targetPageId });
        }
        if (linkRows.length > 0)
          await tx.insert(kbPageLinks).values(linkRows).onConflictDoNothing();
      }

      return newRoot;
    });
  }

  /**
   * Breadth-first levels of the subtree: every node at one depth is inserted in a single
   * statement, so the copy costs one round trip per depth instead of one per node. A child
   * also cannot be planned before its parent's generated id exists, which the previous
   * map-order walk did not guarantee — a child seen first was grafted to the space root.
   */
  private levelsOf(subtreeMap: Map<number, PageRow>, rootId: number): PageRow[][] {
    const childrenByParent = new Map<number, PageRow[]>();
    for (const page of subtreeMap.values()) {
      if (page.id === rootId || page.parentPageId === null) continue;
      const siblings = childrenByParent.get(page.parentPageId) ?? [];
      siblings.push(page);
      childrenByParent.set(page.parentPageId, siblings);
    }
    for (const siblings of childrenByParent.values())
      siblings.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

    const root = subtreeMap.get(rootId);
    const levels: PageRow[][] = [];
    let current = root ? [root] : [];
    while (current.length > 0) {
      levels.push(current);
      const next: PageRow[] = [];
      for (const node of current) next.push(...(childrenByParent.get(node.id) ?? []));
      current = next;
    }
    return levels;
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
    const ids = idRows.map((row) => Number(row.id));
    if (ids.length === 0) return new Map();
    const pages = await tx
      .select(KB_PAGE_COLUMNS)
      .from(kbPages)
      .where(and(eq(kbPages.orgId, orgId), inArray(kbPages.id, ids), isNull(kbPages.deletedAt)));
    return new Map(pages.map((p) => [p.id, p]));
  }
}
