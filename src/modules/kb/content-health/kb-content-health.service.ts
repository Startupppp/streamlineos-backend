import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import { kbPages } from "../../../db/schema";
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
  ContentHealthTrend,
  DismissHealthItemBody,
  AssignHealthItemBody,
  BulkRepairBody,
  BulkRepairResponse,
  EvidenceQuery,
} from "./dto/kb-content-health.schemas";
import {
  IMPACT_SQL,
  PAGE_BASE_COLUMNS,
  impactKeysetAfterAnchor,
  buildSignalPredicate,
} from "./kb-content-health-signal-predicates";

export { impactKeysetAfterAnchor };

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
    const signalPredicate = buildSignalPredicate(this.db, query.signalType);

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
      conditions.push(impactKeysetAfterAnchor(user.orgId, query.afterId));
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
      "contradictory_claim",
    ];

    const counts = await Promise.all(
      signalTypes.map(async (signalType) => {
        const signalPredicate = buildSignalPredicate(this.db, signalType);
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
        state: "dismissed",
        dismissedAt: now,
        dismissedReason: body.reason,
        dismissalExpiresAt: body.dismissalExpiresAt ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(kbHealthItems.orgId, user.orgId),
          eq(kbHealthItems.pageId, body.pageId),
          eq(kbHealthItems.kind, body.kind),
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
        kind: body.kind,
        ruleVersion,
        state: "dismissed",
        dismissedAt: now,
        dismissedReason: body.reason,
        dismissalExpiresAt: body.dismissalExpiresAt ?? null,
        detectedAt: now,
      })
      .returning();

    return inserted!;
  }

  async assign(
    user: CurrentUserContext,
    body: AssignHealthItemBody,
  ): Promise<typeof kbHealthItems.$inferSelect> {
    const visibilityPredicate = await this.auth.visiblePagePredicate(user, "view");
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
    const ruleVersion = 1;

    const updated = await this.db
      .update(kbHealthItems)
      .set({
        assigneeMembershipId: body.assigneeMembershipId,
        dueAt: body.dueAt ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(kbHealthItems.orgId, user.orgId),
          eq(kbHealthItems.pageId, body.pageId),
          eq(kbHealthItems.kind, body.kind),
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
        kind: body.kind,
        ruleVersion,
        state: "open",
        assigneeMembershipId: body.assigneeMembershipId,
        dueAt: body.dueAt ?? null,
        detectedAt: now,
      })
      .returning();

    return inserted!;
  }

  async bulkRepair(
    user: CurrentUserContext,
    body: BulkRepairBody,
  ): Promise<BulkRepairResponse> {
    const visibilityPredicate = await this.auth.visiblePagePredicate(user, "view");

    const visiblePages = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, user.orgId),
          inArray(kbPages.id, body.pageIds),
          isNull(kbPages.deletedAt),
          visibilityPredicate,
        ),
      );

    const visibleIds = new Set(visiblePages.map((p) => p.id));

    const existingItems = await this.db
      .select({
        pageId: kbHealthItems.pageId,
        state: kbHealthItems.state,
      })
      .from(kbHealthItems)
      .where(
        and(
          eq(kbHealthItems.orgId, user.orgId),
          inArray(kbHealthItems.pageId, body.pageIds),
          eq(kbHealthItems.kind, body.kind),
        ),
      );

    const resolvedIds = new Set(
      existingItems.filter((i) => i.state === "resolved").map((i) => i.pageId),
    );
    const existingPageIds = new Set(existingItems.map((i) => i.pageId));

    const results: BulkRepairResponse["results"] = [];

    for (const pageId of body.pageIds) {
      if (!visibleIds.has(pageId)) {
        results.push({ pageId, outcome: "skipped" });
        continue;
      }
      if (resolvedIds.has(pageId)) {
        results.push({ pageId, outcome: "already_resolved" });
        continue;
      }

      const now = new Date();

      if (body.repairAction === "assign_owner" && body.assigneeMembershipId !== undefined) {
        if (existingPageIds.has(pageId)) {
          await this.db
            .update(kbHealthItems)
            .set({ assigneeMembershipId: body.assigneeMembershipId, updatedAt: now })
            .where(
              and(
                eq(kbHealthItems.orgId, user.orgId),
                eq(kbHealthItems.pageId, pageId),
                eq(kbHealthItems.kind, body.kind),
              ),
            );
        } else {
          await this.db
            .insert(kbHealthItems)
            .values({
              orgId: user.orgId,
              pageId,
              kind: body.kind,
              ruleVersion: 1,
              state: "open",
              assigneeMembershipId: body.assigneeMembershipId,
              detectedAt: now,
            });
        }
      }

      results.push({ pageId, outcome: "applied" });
    }

    return { results };
  }

  async getEvidence(
    user: CurrentUserContext,
    query: EvidenceQuery,
  ): Promise<{ pageId: number; kind: string; ruleVersion: number; evidence: Record<string, unknown>; detectedAt: Date }> {
    const visibilityPredicate = await this.auth.visiblePagePredicate(user, "view");
    const [page] = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, user.orgId),
          eq(kbPages.id, query.pageId),
          isNull(kbPages.deletedAt),
          visibilityPredicate,
        ),
      );
    if (!page) throw new NotFoundException("Page not found");

    const [item] = await this.db
      .select({
        pageId: kbHealthItems.pageId,
        kind: kbHealthItems.kind,
        ruleVersion: kbHealthItems.ruleVersion,
        evidence: kbHealthItems.evidence,
        detectedAt: kbHealthItems.detectedAt,
      })
      .from(kbHealthItems)
      .where(
        and(
          eq(kbHealthItems.orgId, user.orgId),
          eq(kbHealthItems.pageId, query.pageId),
          eq(kbHealthItems.kind, query.kind),
        ),
      );

    if (!item) {
      return {
        pageId: query.pageId,
        kind: query.kind,
        ruleVersion: 1,
        evidence: {},
        detectedAt: new Date(0),
      };
    }

    return {
      pageId: item.pageId,
      kind: item.kind,
      ruleVersion: item.ruleVersion,
      evidence: item.evidence ?? {},
      detectedAt: item.detectedAt,
    };
  }

  async trend(user: CurrentUserContext): Promise<ContentHealthTrend> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [beforeRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(kbHealthItems)
      .where(
        and(
          eq(kbHealthItems.orgId, user.orgId),
          eq(kbHealthItems.state, "open"),
          lt(kbHealthItems.detectedAt, thirtyDaysAgo),
        ),
      );

    const [afterRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(kbHealthItems)
      .where(
        and(
          eq(kbHealthItems.orgId, user.orgId),
          eq(kbHealthItems.state, "open"),
        ),
      );

    const pointRows = await this.db
      .select({
        date: sql<string>`date_trunc('day', ${kbHealthItems.detectedAt})::text`,
        openCount: sql<number>`count(*) filter (where ${kbHealthItems.state} = 'open')::int`,
        resolvedCount: sql<number>`count(*) filter (where ${kbHealthItems.state} = 'resolved')::int`,
      })
      .from(kbHealthItems)
      .where(
        and(
          eq(kbHealthItems.orgId, user.orgId),
          sql`${kbHealthItems.detectedAt} >= current_date - interval '30 days'`,
        ),
      )
      .groupBy(sql`date_trunc('day', ${kbHealthItems.detectedAt})`)
      .orderBy(sql`date_trunc('day', ${kbHealthItems.detectedAt})`);

    return {
      points: pointRows.map((r) => ({
        date: new Date(r.date),
        openCount: r.openCount,
        resolvedCount: r.resolvedCount,
      })),
      beforeCount: beforeRow?.count ?? 0,
      afterCount: afterRow?.count ?? 0,
    };
  }

}
