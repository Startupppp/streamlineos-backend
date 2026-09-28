import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  kbEvents,
  kbPages,
  kbSpaces,
  supportKnowledgeGaps,
} from "../../../db/schema";
import { SupportKnowledgeGapStatus } from "../../../db/schema/support/support-kb-gap";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type {
  GapRelatedPagesQuery,
  GapsQueryInput,
  GapAssignBody,
  GapDismissBody,
  GapCreateFixBody,
  RangeInput,
  RangeWithSpaceInput,
} from "./dto/kb-analytics.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import {
  buildTupleCursorPage,
  decodeTupleCursor,
  type CursorPage,
} from "../../../common/pagination/cursor";
import { keysetInteger } from "../../../common/pagination/keyset";

const MIN_COHORT_SIZE = 3;

type ContentGapRow = {
  query: string | null;
  count: number;
  lastOccurredAt: Date;
  gapKind: "search" | "ai_no_context";
};

type NoResultsRow = { query: string | null; count: number };

type GapRow = {
  query: string | null;
  count: number;
  lastOccurredAt: Date;
};

@Injectable()
export class KbContentGapService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  async gaps(
    user: CurrentUserContext,
    range: GapsQueryInput,
  ): Promise<CursorPage<GapRow>> {
    const conditions: SQL[] = [
      eq(kbEvents.orgId, user.orgId),
      eq(kbEvents.eventType, "search_no_results"),
    ];
    if (range.from)
      conditions.push(gte(kbEvents.occurredAt, new Date(range.from)));
    if (range.to) conditions.push(lte(kbEvents.occurredAt, new Date(range.to)));

    const position = decodeTupleCursor(range.cursor, 2);
    const havingConditions: SQL[] = [sql`count(*) >= ${MIN_COHORT_SIZE}`];
    if (position) {
      const afterCount = keysetInteger(position[0] ?? "");
      const afterQuery = position[1] ?? "";
      havingConditions.push(
        sql`(count(*)::int, coalesce(${kbEvents.query}, '')) < (${sql.param(afterCount)}, ${sql.param(afterQuery, kbEvents.query)})`,
      );
    }

    const rows = await this.db
      .select({
        query: kbEvents.query,
        count: sql<number>`count(*)::int`,
        lastOccurredAt: sql<Date>`max(${kbEvents.occurredAt})`,
      })
      .from(kbEvents)
      .where(and(...conditions))
      .groupBy(kbEvents.query)
      .having(and(...havingConditions))
      .orderBy(desc(sql`count(*)`), kbEvents.query)
      .limit(range.limit + 1);

    return buildTupleCursorPage(rows, range.limit, (row) => [
      String(row.count),
      row.query ?? "",
    ]);
  }

  async gapRelatedPages(
    user: CurrentUserContext,
    query: GapRelatedPagesQuery,
  ): Promise<
    CursorPage<{ id: number; title: string; status: string; updatedAt: Date }>
  > {
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const conditions: (SQL | undefined)[] = [
      eq(kbPages.orgId, user.orgId),
      isNull(kbPages.deletedAt),
      predicate,
      sql`${kbPages.fts} @@ websearch_to_tsquery('english', ${query.query})`,
    ];

    const position = decodeTupleCursor(query.cursor, 2);
    const cursorConditions: SQL[] = [];
    if (position) {
      const afterDate = position[0] ?? "";
      const afterId = keysetInteger(position[1] ?? "");
      cursorConditions.push(
        sql`(${kbPages.updatedAt}, ${kbPages.id}) < (${sql.param(afterDate)}::timestamptz, ${sql.param(afterId, kbPages.id)})`,
      );
    }

    const rows = await this.db
      .select({
        id: kbPages.id,
        title: kbPages.title,
        status: kbPages.status,
        updatedAt: kbPages.updatedAt,
      })
      .from(kbPages)
      .where(
        and(
          ...conditions,
          ...(cursorConditions.length > 0 ? cursorConditions : []),
        ),
      )
      .orderBy(desc(kbPages.updatedAt), desc(kbPages.id))
      .limit(query.limit + 1);

    return buildTupleCursorPage(rows, query.limit, (row) => [
      row.updatedAt.toISOString(),
      String(row.id),
    ]);
  }

  async noResults(orgId: string, range: RangeWithSpaceInput): Promise<NoResultsRow[]> {
    const conditions: SQL[] = [
      eq(kbEvents.orgId, orgId),
      eq(kbEvents.eventType, "search_no_results"),
    ];
    if (range.from)
      conditions.push(gte(kbEvents.occurredAt, new Date(range.from)));
    if (range.to) conditions.push(lte(kbEvents.occurredAt, new Date(range.to)));
    if (range.spaceId !== undefined) {
      const spaceId = range.spaceId;
      conditions.push(
        sql`${kbEvents.articleId} IN (SELECT ${kbPages.id} FROM ${kbPages} WHERE ${kbPages.orgId} = ${orgId} AND ${kbPages.spaceId} = ${spaceId} AND ${kbPages.deletedAt} IS NULL)`,
      );
    }

    return this.db
      .select({
        query: kbEvents.query,
        count: sql<number>`count(*)::int`,
      })
      .from(kbEvents)
      .where(and(...conditions))
      .groupBy(kbEvents.query)
      .having(sql`count(*) >= ${MIN_COHORT_SIZE}`)
      .orderBy(desc(sql`count(*)`))
      .limit(20);
  }

  async contentGaps(
    orgId: string,
    range: RangeInput,
  ): Promise<ContentGapRow[]> {
    const conditions: SQL[] = [
      eq(kbEvents.orgId, orgId),
      inArray(kbEvents.eventType, [
        "search_no_results",
        "ai_answer_no_context",
      ]),
    ];
    if (range.from)
      conditions.push(gte(kbEvents.occurredAt, new Date(range.from)));
    if (range.to) conditions.push(lte(kbEvents.occurredAt, new Date(range.to)));

    const rows = await this.db
      .select({
        query: kbEvents.query,
        eventType: kbEvents.eventType,
        count: sql<number>`count(*)::int`,
        lastOccurredAt: sql<Date>`max(${kbEvents.occurredAt})`,
      })
      .from(kbEvents)
      .where(and(...conditions))
      .groupBy(kbEvents.query, kbEvents.eventType)
      .having(sql`count(*) >= ${MIN_COHORT_SIZE}`)
      .orderBy(desc(sql`count(*)`))
      .limit(100);

    return rows.map((row) => ({
      query: row.query,
      count: row.count,
      lastOccurredAt: row.lastOccurredAt,
      gapKind:
        row.eventType === "ai_answer_no_context"
          ? ("ai_no_context" as const)
          : ("search" as const),
    }));
  }

  async assignGap(user: CurrentUserContext, body: GapAssignBody) {
    const now = new Date();
    const [row] = await this.db
      .insert(supportKnowledgeGaps)
      .values({
        orgId: user.orgId,
        clusterKey: body.query,
        representativeQuestion: body.query,
        ticketCount: 0,
        status: SupportKnowledgeGapStatus.OPEN,
        draftedBy: body.assigneeUserId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [supportKnowledgeGaps.orgId, supportKnowledgeGaps.clusterKey],
        set: { draftedBy: body.assigneeUserId, updatedAt: now },
      })
      .returning({
        id: supportKnowledgeGaps.id,
        clusterKey: supportKnowledgeGaps.clusterKey,
        status: supportKnowledgeGaps.status,
        proposedArticleId: supportKnowledgeGaps.proposedArticleId,
        draftedBy: supportKnowledgeGaps.draftedBy,
        dismissalReason: supportKnowledgeGaps.dismissalReason,
        updatedAt: supportKnowledgeGaps.updatedAt,
      });
    if (!row) throw new NotFoundException("Knowledge gap not found");
    return row;
  }

  async dismissGap(user: CurrentUserContext, body: GapDismissBody) {
    const now = new Date();
    const [row] = await this.db
      .insert(supportKnowledgeGaps)
      .values({
        orgId: user.orgId,
        clusterKey: body.query,
        representativeQuestion: body.query,
        ticketCount: 0,
        status: SupportKnowledgeGapStatus.DISMISSED,
        dismissalReason: body.reason,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [supportKnowledgeGaps.orgId, supportKnowledgeGaps.clusterKey],
        set: {
          status: SupportKnowledgeGapStatus.DISMISSED,
          dismissalReason: body.reason,
          updatedAt: now,
        },
      })
      .returning({
        id: supportKnowledgeGaps.id,
        clusterKey: supportKnowledgeGaps.clusterKey,
        status: supportKnowledgeGaps.status,
        proposedArticleId: supportKnowledgeGaps.proposedArticleId,
        draftedBy: supportKnowledgeGaps.draftedBy,
        dismissalReason: supportKnowledgeGaps.dismissalReason,
        updatedAt: supportKnowledgeGaps.updatedAt,
      });
    if (!row) throw new NotFoundException("Knowledge gap not found");
    return row;
  }

  async createFix(user: CurrentUserContext, body: GapCreateFixBody) {
    const now = new Date();

    const spaceId = body.spaceId
      ?? await this.db
        .select({ id: kbSpaces.id })
        .from(kbSpaces)
        .where(and(eq(kbSpaces.orgId, user.orgId), isNull(kbSpaces.deletedAt)))
        .limit(1)
        .then((rows) => rows[0]?.id ?? null);

    const slug = body.query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 200);

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const [page] = await tx
          .insert(kbPages)
          .values({
            orgId: user.orgId,
            spaceId: spaceId ?? null,
            title: body.query,
            slug: `${slug}-${Date.now()}`,
            status: "draft",
            visibility: "org",
            contentText: "",
            createdById: user.userId,
          })
          .returning({ id: kbPages.id });

        if (!page) throw new NotFoundException("Page not found");
        const pageId = page.id;

        const [row] = await tx
          .insert(supportKnowledgeGaps)
          .values({
            orgId: user.orgId,
            clusterKey: body.query,
            representativeQuestion: body.query,
            ticketCount: 0,
            status: SupportKnowledgeGapStatus.DRAFTED,
            proposedArticleId: pageId,
            draftedBy: user.userId,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [supportKnowledgeGaps.orgId, supportKnowledgeGaps.clusterKey],
            set: {
              proposedArticleId: pageId,
              draftedBy: user.userId,
              status: SupportKnowledgeGapStatus.DRAFTED,
              updatedAt: now,
            },
          })
          .returning({
            id: supportKnowledgeGaps.id,
            clusterKey: supportKnowledgeGaps.clusterKey,
            status: supportKnowledgeGaps.status,
            proposedArticleId: supportKnowledgeGaps.proposedArticleId,
            draftedBy: supportKnowledgeGaps.draftedBy,
            dismissalReason: supportKnowledgeGaps.dismissalReason,
            updatedAt: supportKnowledgeGaps.updatedAt,
          });
        if (!row) throw new NotFoundException("Knowledge gap not found");
        return row;
      },
      { orgId: user.orgId },
    );
  }
}
