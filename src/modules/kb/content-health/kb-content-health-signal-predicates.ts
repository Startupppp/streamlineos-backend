import { and, eq, exists, isNull, lt, sql, type SQL } from "drizzle-orm";
import { isVerifiedNow } from "../core/kb-page-trust-predicates";
import { kbPageLinks, kbPageReviews, kbPages } from "../../../db/schema";
import { kbHealthItems } from "../../../db/schema/kb/health-items";
import type { Db } from "../../../db/drizzle.module";
import type { ContentHealthSignalType } from "./dto/kb-content-health.schemas";

export const STALE_THRESHOLD_DAYS = 90;

export const IMPACT_SQL = sql<number>`LEAST(100,
  LEAST(60, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - ${kbPages.updatedAt})) / 86400 / 30)::integer * 20)
  + CASE ${kbPages.visibility} WHEN 'public' THEN 40 WHEN 'org' THEN 20 ELSE 0 END
)`;

export function impactKeysetAfterAnchor(orgId: string, afterId: number): SQL {
  const anchorImpact = sql`(SELECT ${IMPACT_SQL} FROM ${kbPages} WHERE ${kbPages.orgId} = ${sql.param(
    orgId,
    kbPages.orgId,
  )} AND ${kbPages.id} = ${sql.param(afterId, kbPages.id)})`;

  return sql`(${IMPACT_SQL}, -${kbPages.id}) < (${anchorImpact}, -${sql.param(
    afterId,
    kbPages.id,
  )}::int)`;
}

export const PAGE_BASE_COLUMNS = {
  id: kbPages.id,
  title: kbPages.title,
  status: kbPages.status,
  spaceId: kbPages.spaceId,
  updatedAt: kbPages.updatedAt,
  nextReviewAt: kbPages.nextReviewAt,
  ownerMembershipId: kbPages.ownerMembershipId,
  impact: IMPACT_SQL,
};

export function buildSignalPredicate(db: Db, signalType: ContentHealthSignalType): SQL {
  switch (signalType) {
    case "unowned":
      return isNull(kbPages.ownerMembershipId);

    case "stale": {
      const threshold = new Date();
      threshold.setDate(threshold.getDate() - STALE_THRESHOLD_DAYS);
      return lt(kbPages.updatedAt, threshold);
    }

    case "unverified":
      return sql`NOT (${isVerifiedNow()})`;

    case "empty":
      return sql`(${kbPages.contentText} IS NULL OR trim(${kbPages.contentText}) = '')`;

    case "overdue_review":
      return exists(
        db
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
        db
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
      return exists(
        db
          .select({ present: sql<number>`1` })
          .from(kbHealthItems)
          .where(
            and(
              eq(kbHealthItems.orgId, kbPages.orgId),
              eq(kbHealthItems.pageId, kbPages.id),
              eq(kbHealthItems.kind, "contradictory_claim"),
              eq(kbHealthItems.state, "open"),
            ),
          ),
      );
  }
}
