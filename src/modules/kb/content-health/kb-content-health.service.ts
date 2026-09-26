import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import { kbPageLinks, kbPageReviews, kbPages } from "../../../db/schema";
import { kbHealthItems } from "../../../db/schema/kb/health-items";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import {
  buildIdCursorPage,
  type IdCursorPage,
} from "../../../common/pagination/cursor";
import type {
  ContentHealthSignalsQuery,
  ContentHealthSignalItem,
  ContentHealthSignalType,
  ContentHealthCounts,
  DismissHealthItemBody,
} from "./dto/kb-content-health.schemas";
import type { KbHealthItemState, KbHealthItemKind } from "../../../db/schema/kb/health-items";

const STALE_THRESHOLD_DAYS = 90;

const IMPACT_SQL = sql<number>`LEAST(100,
  LEAST(60, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - ${kbPages.updatedAt})) / 86400 / 30)::integer * 20)
  + CASE ${kbPages.visibility} WHEN 'public' THEN 40 WHEN 'org' THEN 20 ELSE 0 END
)`;

const PAGE_BASE_COLUMNS = {
  id: kbPages.id,
  title: kbPages.title,
  status: kbPages.status,
  spaceId: kbPages.spaceId,
  updatedAt: kbPages.updatedAt,
  nextReviewAt: kbPages.nextReviewAt,
  ownerMembershipId: kbPages.ownerMembershipId,
  impact: IMPACT_SQL,
};

@Injectable()
export class KbContentHealthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  async signals(
    user: CurrentUserContext,
    query: ContentHealthSignalsQuery,
  ): Promise<IdCursorPage<ContentHealthSignalItem>> {
    const visibilityPredicate = await this.auth.visiblePagePredicate(
      user,
      "view",
    );
    const signalPredicate = this.buildSignalPredicate(query.signalType);

    const conditions: (SQL | undefined)[] = [
      eq(kbPages.orgId, user.orgId),
      isNull(kbPages.deletedAt),
      visibilityPredicate,
      signalPredicate,
    ];

    if (query.spaceId !== undefined) {
      conditions.push(eq(kbPages.spaceId, query.spaceId));
    }
    if (query.afterId !== undefined) {
      conditions.push(gt(kbPages.id, query.afterId));
    }
    if (query.ownerMembershipId !== undefined) {
      conditions.push(eq(kbPages.ownerMembershipId, query.ownerMembershipId));
    }

    const rows = await this.db
      .select(PAGE_BASE_COLUMNS)
      .from(kbPages)
      .where(and(...conditions))
      .orderBy(desc(IMPACT_SQL), asc(kbPages.id))
      .limit(query.limit + 1);

    return buildIdCursorPage(rows, query.limit, (row) => row.id);
  }

  async counts(user: CurrentUserContext): Promise<ContentHealthCounts> {
    const visibilityPredicate = await this.auth.visiblePagePredicate(
      user,
      "view",
    );
    const baseConditions: (SQL | undefined)[] = [
      eq(kbPages.orgId, user.orgId),
      isNull(kbPages.deletedAt),
      visibilityPredicate,
    ];

    const signalTypes: ContentHealthSignalType[] = [
      "unowned",
      "stale",
      "unverified",
      "empty",
      "overdue_review",
      "broken_link",
      "overexposed",
      "duplicate_candidate",
    ];

    const counts = await Promise.all(
      signalTypes.map(async (signalType) => {
        const signalPredicate = this.buildSignalPredicate(signalType);
        const [result] = await this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(kbPages)
          .where(and(...baseConditions, signalPredicate));
        return { signalType, count: result?.count ?? 0 };
      }),
    );

    return { counts };
  }

  async dismiss(
    user: CurrentUserContext,
    body: DismissHealthItemBody,
  ): Promise<typeof kbHealthItems.$inferSelect> {
    const visibilityPredicate = await this.auth.visiblePagePredicate(
      user,
      "view",
    );
    const [page] = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, user.orgId),
          eq(kbPages.id, body.pageId),
          isNull(kbPages.deletedAt),
          visibilityPredicate,
        ),
      );
    if (!page) throw new NotFoundException("Page not found");

    const now = new Date();
    const ruleVersion = body.ruleVersion ?? 1;

    const updated = await this.db
      .update(kbHealthItems)
      .set({
        state: "dismissed" as KbHealthItemState,
        dismissedAt: now,
        dismissedReason: body.reason,
        dismissalExpiresAt: body.dismissalExpiresAt ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(kbHealthItems.orgId, user.orgId),
          eq(kbHealthItems.pageId, body.pageId),
          eq(kbHealthItems.kind, body.kind as KbHealthItemKind),
          eq(kbHealthItems.ruleVersion, ruleVersion),
          eq(kbHealthItems.state, "open"),
        ),
      )
      .returning();

    if (updated.length > 0) return updated[0]!;

    const [inserted] = await this.db
      .insert(kbHealthItems)
      .values({
        orgId: user.orgId,
        pageId: body.pageId,
        kind: body.kind as KbHealthItemKind,
        ruleVersion,
        state: "dismissed" as KbHealthItemState,
        dismissedAt: now,
        dismissedReason: body.reason,
        dismissalExpiresAt: body.dismissalExpiresAt ?? null,
        detectedAt: now,
      })
      .returning();

    return inserted!;
  }

  private buildSignalPredicate(signalType: ContentHealthSignalType): SQL {
    switch (signalType) {
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
    }
  }
}
