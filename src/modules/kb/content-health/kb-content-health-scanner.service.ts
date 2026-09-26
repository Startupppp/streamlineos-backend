import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import { kbPageLinks, kbPageReviews, kbPages } from "../../../db/schema";
import { kbHealthItems, KB_HEALTH_ITEM_KINDS } from "../../../db/schema/kb/health-items";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { KbHealthItemKind } from "../../../db/schema/kb/health-items";

const STALE_THRESHOLD_DAYS = 90;
const SCAN_PAGE_LIMIT = 500;

const CONTRADICTION_PAIR_PREDICATE = sql`
  o.org_id = p.org_id
  AND o.id <> p.id
  AND o.deleted_at IS NULL
  AND o.status = 'published'
  AND o.space_id IS NOT DISTINCT FROM p.space_id
  AND (
    lower(split_part(trim(p.title), ' ', 1)) = lower(split_part(trim(o.title), ' ', 1))
    AND lower(split_part(trim(p.title), ' ', 2)) = lower(split_part(trim(o.title), ' ', 2))
    AND lower(split_part(trim(p.title), ' ', 3)) = lower(split_part(trim(o.title), ' ', 3))
    AND length(trim(p.title)) >= 10
  )
  AND md5(coalesce(p.content_text,'')) <> md5(coalesce(o.content_text,''))
  AND coalesce(p.content_text, '') <> ''
  AND coalesce(o.content_text, '') <> ''
`;

@Injectable()
export class KbContentHealthScannerService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async scan(orgId: string): Promise<void> {
    const dynamicKinds: KbHealthItemKind[] = [
      "unowned",
      "stale",
      "unverified",
      "empty",
      "overdue_review",
      "broken_link",
      "overexposed",
      "duplicate_candidate",
    ];

    await Promise.all([
      ...dynamicKinds.map((kind) => this.scanKind(orgId, kind)),
      this.scanContradictions(orgId),
    ]);
  }

  private async scanContradictions(orgId: string): Promise<void> {
    const rows = await this.db.execute<{
      page_id: number;
      other_id: number;
      title: string;
      space_id: number | null;
    }>(sql`
      SELECT p.id AS page_id, o.id AS other_id, p.title, p.space_id
      FROM kb_pages p
      JOIN kb_pages o ON ${CONTRADICTION_PAIR_PREDICATE}
      WHERE p.org_id = ${orgId}
        AND p.deleted_at IS NULL
        AND p.status = 'published'
      ORDER BY p.id
      LIMIT ${SCAN_PAGE_LIMIT}
    `);

    const seen = new Set<number>();
    for (const row of rows) {
      if (seen.has(row.page_id)) continue;
      seen.add(row.page_id);
      await this.recordContradiction(orgId, row.page_id, {
        detectionMethod: "title_prefix_content_divergence",
        conflictingPageId: row.other_id,
        spaceId: row.space_id,
        titlePrefix: row.title?.slice(0, 60) ?? "",
      });
    }

    await this.resolveStaleItems(orgId, "contradictory_claim");
  }

  async recordContradiction(
    orgId: string,
    pageId: number,
    evidence: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date();
    const computedImpact = await this.computePageImpact(orgId, pageId);

    await this.db
      .insert(kbHealthItems)
      .values({
        orgId,
        pageId,
        kind: "contradictory_claim",
        ruleVersion: 1,
        state: "open",
        evidence,
        impact: computedImpact,
        detectedAt: now,
      })
      .onConflictDoUpdate({
        target: [kbHealthItems.orgId, kbHealthItems.pageId, kbHealthItems.kind, kbHealthItems.ruleVersion],
        set: {
          state: "open",
          evidence,
          impact: computedImpact,
          resolvedAt: null,
          updatedAt: now,
        },
      })
      .catch(() => {
        return this.db
          .update(kbHealthItems)
          .set({ state: "open", evidence, impact: computedImpact, updatedAt: now })
          .where(
            and(
              eq(kbHealthItems.orgId, orgId),
              eq(kbHealthItems.pageId, pageId),
              eq(kbHealthItems.kind, "contradictory_claim"),
            ),
          );
      });
  }

  private async scanKind(orgId: string, kind: KbHealthItemKind): Promise<void> {
    const matchingPageIds = await this.queryMatchingPages(orgId, kind);

    await this.upsertOpenItems(orgId, kind, matchingPageIds);
    await this.resolveStaleItems(orgId, kind);
  }

  private async queryMatchingPages(orgId: string, kind: KbHealthItemKind): Promise<number[]> {
    const kindCondition = this.buildKindCondition(kind);
    if (kindCondition === undefined) return [];

    const rows = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(
        and(eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt), kindCondition),
      )
      .limit(SCAN_PAGE_LIMIT);

    return rows.map((r) => r.id);
  }

  private buildKindCondition(kind: KbHealthItemKind): SQL | undefined {
    switch (kind) {
      case "unowned":
        return isNull(kbPages.ownerMembershipId);

      case "stale": {
        const threshold = new Date();
        threshold.setDate(threshold.getDate() - STALE_THRESHOLD_DAYS);
        return lt(kbPages.updatedAt, threshold);
      }

      case "unverified":
        return sql`(${kbPages.trustState} = 'unverified' OR ${kbPages.trustState} = 'verification_expired')`;

      case "empty":
        return sql`(${kbPages.contentText} IS NULL OR trim(${kbPages.contentText}) = '')`;

      case "overdue_review":
        return exists(
          this.db
            .select({ present: sql<number>`1` })
            .from(kbPageReviews)
            .where(
              and(
                eq(kbPageReviews.orgId, kbPages.orgId),
                eq(kbPageReviews.pageId, kbPages.id),
                sql`${kbPageReviews.status} = 'pending'`,
                lt(kbPageReviews.dueAt, new Date()),
              ),
            ),
        );

      case "broken_link":
        return exists(
          this.db
            .select({ present: sql<number>`1` })
            .from(kbPageLinks)
            .where(
              and(
                eq(kbPageLinks.orgId, kbPages.orgId),
                eq(kbPageLinks.sourcePageId, kbPages.id),
                sql`${kbPageLinks.targetType} = 'page'`,
                isNull(kbPageLinks.targetPageId),
              ),
            ),
        );

      case "overexposed":
        return sql`(
          ${kbPages.visibility} = 'public'
          AND ${kbPages.spaceId} IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM kb_spaces s
            WHERE s.org_id = ${kbPages.orgId}
              AND s.id = ${kbPages.spaceId}
              AND s.is_public_help_center = false
              AND s.deleted_at IS NULL
          )
        )`;

      case "duplicate_candidate":
        return sql`(
          ${kbPages.contentText} IS NOT NULL
          AND trim(${kbPages.contentText}) <> ''
          AND EXISTS (
            SELECT 1 FROM kb_pages other
            WHERE other.org_id = ${kbPages.orgId}
              AND other.id <> ${kbPages.id}
              AND other.deleted_at IS NULL
              AND other.content_text IS NOT NULL
              AND md5(other.content_text) = md5(${kbPages.contentText})
          )
        )`;

      case "contradictory_claim":
        return undefined;
    }
  }

  private async upsertOpenItems(
    orgId: string,
    kind: KbHealthItemKind,
    pageIds: number[],
  ): Promise<void> {
    if (pageIds.length === 0) return;
    const now = new Date();

    const impacts = await this.computeBatchImpacts(orgId, pageIds);

    for (const pageId of pageIds) {
      const impact = impacts.get(pageId) ?? 0;

      await this.db
        .insert(kbHealthItems)
        .values({
          orgId,
          pageId,
          kind,
          ruleVersion: 1,
          state: "open",
          impact,
          detectedAt: now,
        })
        .onConflictDoNothing()
        .catch(() => undefined);

      await this.db
        .update(kbHealthItems)
        .set({ state: "open", impact, resolvedAt: null, updatedAt: now })
        .where(
          and(
            eq(kbHealthItems.orgId, orgId),
            eq(kbHealthItems.pageId, pageId),
            eq(kbHealthItems.kind, kind),
            eq(kbHealthItems.state, "dismissed"),
            sql`${kbHealthItems.dismissalExpiresAt} IS NOT NULL AND ${kbHealthItems.dismissalExpiresAt} < NOW()`,
          ),
        )
        .catch(() => undefined);
    }
  }

  private async resolveStaleItems(
    orgId: string,
    kind: KbHealthItemKind,
  ): Promise<void> {
    const now = new Date();

    await this.db
      .update(kbHealthItems)
      .set({ state: "resolved", resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(kbHealthItems.orgId, orgId),
          eq(kbHealthItems.kind, kind),
          eq(kbHealthItems.state, "open"),
          this.pageNoLongerMatches(orgId, kind),
        ),
      );
  }

  private pageNoLongerMatches(orgId: string, kind: KbHealthItemKind): SQL {
    if (kind === "contradictory_claim") {
      return sql`NOT EXISTS (
        SELECT 1
        FROM kb_pages p
        JOIN kb_pages o ON ${CONTRADICTION_PAIR_PREDICATE}
        WHERE p.org_id = ${orgId}
          AND p.id = ${kbHealthItems.pageId}
          AND p.deleted_at IS NULL
          AND p.status = 'published'
      )`;
    }

    const kindCondition = this.buildKindCondition(kind);

    return notExists(
      this.db
        .select({ present: sql<number>`1` })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            eq(kbPages.id, kbHealthItems.pageId),
            isNull(kbPages.deletedAt),
            kindCondition,
          ),
        ),
    );
  }

  private async computePageImpact(orgId: string, pageId: number): Promise<number> {
    const impacts = await this.computeBatchImpacts(orgId, [pageId]);
    return impacts.get(pageId) ?? 0;
  }

  private async computeBatchImpacts(orgId: string, pageIds: number[]): Promise<Map<number, number>> {
    if (pageIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        id: kbPages.id,
        impact: sql<number>`LEAST(100,
          LEAST(60, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - ${kbPages.updatedAt})) / 86400 / 30)::integer * 20)
          + CASE ${kbPages.visibility} WHEN 'public' THEN 40 WHEN 'org' THEN 20 ELSE 0 END
        )`,
      })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          inArray(kbPages.id, pageIds),
        ),
      );

    return new Map(rows.map((r) => [r.id, r.impact]));
  }
}

export { KB_HEALTH_ITEM_KINDS };
