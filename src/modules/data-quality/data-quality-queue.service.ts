import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { keysetAfter, keysetBefore } from "../../common/pagination/keyset";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { businessParties, dataQualityFindings, dataQualityResolutions } from "../../db/schema";
import type { FindingSeverity, FindingStatus } from "../../db/schema/crm/data-quality";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { SEVERITY_WEIGHTS, weightedOpenCount } from "./finding-vocabulary";
import { MAX_BULK, type FindingSelection } from "./dto/data-quality.schemas";
import type {
  AssignFindingsInput,
  HealthQuery,
  ListFindingsQuery,
  ListGroupsQuery,
  ListResolutionsQuery,
} from "./dto/data-quality.schemas";

const DAY_MS = 24 * 60 * 60 * 1000;

const ageInDays = (from: Date, now: number): number =>
  Math.max(0, Math.floor((now - from.getTime()) / DAY_MS));

/**
 * Reading the queue, and handing an item to somebody.
 *
 * Separate from resolution because the two have different shapes: this is all
 * reads and one narrow write, while resolving is a transaction with an executor
 * behind it. Keeping them apart is also what stops the read path acquiring the
 * resolution path's dependencies.
 */
@Injectable()
export class DataQualityQueueService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  // ── The queue ─────────────────────────────────────────────────────────────

  async listFindings(organizationId: string, query: ListFindingsQuery) {
    const position = decodeCursor(query.cursor);
    const conditions = and(
      ...this.filters(organizationId, query).filter((c): c is SQL => c !== undefined),
    );

    const ascending = query.order === "oldest";

    /**
     * Row-value comparison over exactly the index's leading columns, so the scan
     * starts at the cursor instead of reading and discarding. The identifier is
     * in the comparison rather than beside it because a sweep files hundreds of
     * findings in the same instant — with the timestamp alone, every page after
     * the first would skip some of them and repeat others.
     */
    const keyset = position
      ? and(
          conditions,
          ascending
            ? keysetAfter(dataQualityFindings.firstDetectedAt, dataQualityFindings.findingId, position)
            : keysetBefore(dataQualityFindings.firstDetectedAt, dataQualityFindings.findingId, position),
        )
      : conditions;

    const rows = await this.db
      .select({
        findingId: dataQualityFindings.findingId,
        producer: dataQualityFindings.producer,
        findingKind: dataQualityFindings.findingKind,
        groupKey: dataQualityFindings.groupKey,
        severity: dataQualityFindings.severity,
        status: dataQualityFindings.status,
        partyId: dataQualityFindings.partyId,
        relatedPartyId: dataQualityFindings.relatedPartyId,
        evidence: dataQualityFindings.evidence,
        score: dataQualityFindings.score,
        proposedAction: dataQualityFindings.proposedAction,
        proposedPatch: dataQualityFindings.proposedPatch,
        reversibility: dataQualityFindings.reversibility,
        assignedToUserId: dataQualityFindings.assignedToUserId,
        assignedAt: dataQualityFindings.assignedAt,
        firstDetectedAt: dataQualityFindings.firstDetectedAt,
        lastSeenAt: dataQualityFindings.lastSeenAt,
        resolvedAt: dataQualityFindings.resolvedAt,
        resolutionId: dataQualityFindings.resolutionId,
        lastError: dataQualityFindings.lastError,
        /** Named, so a reviewer opens a record rather than an identifier. */
        partyName: businessParties.name,
      })
      .from(dataQualityFindings)
      .leftJoin(
        businessParties,
        and(
          eq(businessParties.organizationId, dataQualityFindings.organizationId),
          eq(businessParties.partyId, dataQualityFindings.partyId),
        ),
      )
      .where(keyset)
      .orderBy(
        ascending
          ? asc(dataQualityFindings.firstDetectedAt)
          : desc(dataQualityFindings.firstDetectedAt),
        ascending ? asc(dataQualityFindings.findingId) : desc(dataQualityFindings.findingId),
      )
      .limit(query.limit + 1);

    const now = Date.now();
    const page = buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.firstDetectedAt.toISOString(),
      id: row.findingId,
    }));

    return {
      ...page,
      /**
       * Age is computed here rather than in SQL so the projection stays typed
       * columns. It is the same information as `firstDetectedAt`; it is spelled
       * out because "how long has this been nobody's job" is the question the
       * queue exists to answer, and a caller should not have to derive it.
       */
      data: page.data.map((row) => ({ ...row, ageDays: ageInDays(row.firstDetectedAt, now) })),
    };
  }

  private filters(organizationId: string, query: ListFindingsQuery): (SQL | undefined)[] {
    return [
      eq(dataQualityFindings.organizationId, organizationId),
      eq(dataQualityFindings.status, query.status),
      query.producer ? eq(dataQualityFindings.producer, query.producer) : undefined,
      query.findingKind ? eq(dataQualityFindings.findingKind, query.findingKind) : undefined,
      query.severity ? eq(dataQualityFindings.severity, query.severity) : undefined,
      query.groupKey ? eq(dataQualityFindings.groupKey, query.groupKey) : undefined,
      query.partyId ? eq(dataQualityFindings.partyId, query.partyId) : undefined,
      query.assignedToId ? eq(dataQualityFindings.assignedToUserId, query.assignedToId) : undefined,
      query.unassignedOnly ? isNull(dataQualityFindings.assignedToUserId) : undefined,
      query.olderThanDays !== undefined
        ? lt(dataQualityFindings.firstDetectedAt, new Date(Date.now() - query.olderThanDays * DAY_MS))
        : undefined,
    ];
  }

  async getFinding(organizationId: string, findingId: string) {
    const [row] = await this.db
      .select()
      .from(dataQualityFindings)
      .where(
        and(
          eq(dataQualityFindings.organizationId, organizationId),
          eq(dataQualityFindings.findingId, findingId),
        ),
      )
      .limit(1);

    // Another organisation's identifier reads as absent. A 403 here would
    // confirm the record exists, which turns a probe into an existence oracle.
    if (!row) throw new NotFoundException("Finding not found");

    return { ...row, ageDays: ageInDays(row.firstDetectedAt, Date.now()) };
  }

  // ── The grouped view ──────────────────────────────────────────────────────

  /**
   * The open queue as *shapes of problem* rather than instances.
   *
   * This is the screen a bulk decision is made from. Producers are required to
   * make `groupKey` determine `severity`, `proposedAction` and `reversibility` —
   * asserted in `producer-grouping.spec.ts` — which is what lets this be a
   * single `GROUP BY` returning one row per group. If severity varied inside a
   * group, this would return the same group several times and a person would be
   * asked to make the same decision twice.
   */
  async listGroups(organizationId: string, query: ListGroupsQuery) {
    const rows = await this.db
      .select({
        producer: dataQualityFindings.producer,
        findingKind: dataQualityFindings.findingKind,
        groupKey: dataQualityFindings.groupKey,
        severity: dataQualityFindings.severity,
        proposedAction: dataQualityFindings.proposedAction,
        reversibility: dataQualityFindings.reversibility,
        openCount: count(),
        oldestDetectedAt: sql<Date>`min(${dataQualityFindings.firstDetectedAt})`,
      })
      .from(dataQualityFindings)
      .where(
        and(
          eq(dataQualityFindings.organizationId, organizationId),
          eq(dataQualityFindings.status, "open"),
          query.producer ? eq(dataQualityFindings.producer, query.producer) : undefined,
        ),
      )
      .groupBy(
        dataQualityFindings.producer,
        dataQualityFindings.findingKind,
        dataQualityFindings.groupKey,
        dataQualityFindings.severity,
        dataQualityFindings.proposedAction,
        dataQualityFindings.reversibility,
      )
      .orderBy(desc(count()))
      .limit(query.limit);

    const now = Date.now();
    return {
      data: rows.map((row) => {
        const oldest = new Date(row.oldestDetectedAt);
        return {
          ...row,
          openCount: Number(row.openCount),
          oldestDetectedAt: oldest,
          oldestAgeDays: ageInDays(oldest, now),
          /** What clearing this one group would take off the health number. */
          weight: SEVERITY_WEIGHTS[row.severity] * Number(row.openCount),
          /**
           * Whether one decision can cover the whole group, or the caller has to
           * repeat. Said out loud so nobody assumes a single click finished it.
           */
          resolvableInOneDecision: Number(row.openCount) <= MAX_BULK,
        };
      }),
    };
  }

  // ── Is it getting better or worse ─────────────────────────────────────────

  /**
   * The dataset's health, and its direction.
   *
   * A standing number alone cannot answer the question the ticket asks — a
   * tenant with 400 open findings that were 900 last month is winning, and one
   * with 40 that were 4 is not. So the window's opened and closed counts sit
   * beside the total, and their difference is the only figure that says which.
   */
  async health(organizationId: string, query: HealthQuery) {
    const since = new Date(Date.now() - query.days * DAY_MS);

    const [bySeverity, byProducer, opened, closed, oldest] = await Promise.all([
      this.db
        .select({ severity: dataQualityFindings.severity, n: count() })
        .from(dataQualityFindings)
        .where(
          and(
            eq(dataQualityFindings.organizationId, organizationId),
            eq(dataQualityFindings.status, "open"),
          ),
        )
        .groupBy(dataQualityFindings.severity),

      this.db
        .select({
          producer: dataQualityFindings.producer,
          severity: dataQualityFindings.severity,
          n: count(),
        })
        .from(dataQualityFindings)
        .where(
          and(
            eq(dataQualityFindings.organizationId, organizationId),
            eq(dataQualityFindings.status, "open"),
          ),
        )
        .groupBy(dataQualityFindings.producer, dataQualityFindings.severity),

      this.db
        .select({ n: count() })
        .from(dataQualityFindings)
        .where(
          and(
            eq(dataQualityFindings.organizationId, organizationId),
            gte(dataQualityFindings.firstDetectedAt, since),
          ),
        ),

      this.db
        .select({ status: dataQualityFindings.status, n: count() })
        .from(dataQualityFindings)
        .where(
          and(
            eq(dataQualityFindings.organizationId, organizationId),
            gte(dataQualityFindings.resolvedAt, since),
          ),
        )
        .groupBy(dataQualityFindings.status),

      this.db
        .select({ firstDetectedAt: dataQualityFindings.firstDetectedAt })
        .from(dataQualityFindings)
        .where(
          and(
            eq(dataQualityFindings.organizationId, organizationId),
            eq(dataQualityFindings.status, "open"),
          ),
        )
        .orderBy(asc(dataQualityFindings.firstDetectedAt))
        .limit(1),
    ]);

    const severityCounts = bySeverity.map((row) => ({
      severity: row.severity,
      count: Number(row.n),
    }));

    const openTotal = severityCounts.reduce((total, row) => total + row.count, 0);
    const openedInWindow = Number(opened[0]?.n ?? 0);
    const closedInWindow = closed.reduce((total, row) => total + Number(row.n), 0);
    const oldestOpenAt = oldest[0]?.firstDetectedAt ?? null;

    const producers = new Map<string, { producer: string; count: number; weight: number }>();
    for (const row of byProducer) {
      const entry = producers.get(row.producer) ?? {
        producer: row.producer,
        count: 0,
        weight: 0,
      };
      entry.count += Number(row.n);
      entry.weight += SEVERITY_WEIGHTS[row.severity] * Number(row.n);
      producers.set(row.producer, entry);
    }

    return {
      windowDays: query.days,
      open: {
        total: openTotal,
        weighted: weightedOpenCount(severityCounts),
        bySeverity: this.severityMap(severityCounts),
        byProducer: [...producers.values()].sort((a, b) => b.weight - a.weight),
      },
      trend: {
        openedInWindow,
        closedInWindow,
        resolvedInWindow: Number(closed.find((row) => row.status === "resolved")?.n ?? 0),
        dismissedInWindow: Number(closed.find((row) => row.status === "dismissed")?.n ?? 0),
        /** Positive means the backlog grew. The only number worth a graph. */
        net: openedInWindow - closedInWindow,
      },
      oldestOpenAt,
      oldestOpenAgeDays: oldestOpenAt ? ageInDays(oldestOpenAt, Date.now()) : null,
    };
  }

  /** Every severity present, so a caller never has to decide what a gap means. */
  private severityMap(
    counts: readonly { severity: FindingSeverity; count: number }[],
  ): Record<FindingSeverity, number> {
    const map: Record<FindingSeverity, number> = { high: 0, medium: 0, low: 0 };
    for (const row of counts) map[row.severity] = row.count;
    return map;
  }

  // ── Making it somebody's work ─────────────────────────────────────────────

  /**
   * Hand a selection to a person, or hand it back to the queue.
   *
   * One statement whatever the size of the selection. Assignment is the cheapest
   * bulk action there is and it would be perverse to make it the one that loops.
   */
  async assign(organizationId: string, actorUserId: string, input: AssignFindingsInput) {
    const candidates = await this.selectCandidateIds(organizationId, input.selection, "open");
    if (candidates.length === 0) return { assigned: 0, findingIds: [] as string[] };

    const assigning = input.assigneeUserId !== null;

    const updated = await this.db
      .update(dataQualityFindings)
      .set({
        assignedToUserId: input.assigneeUserId,
        // Cleared together with the assignee: "assigned to nobody, by Dave, last
        // Tuesday" is a state that reads as a bug every time somebody sees it.
        assignedByUserId: assigning ? actorUserId : null,
        assignedAt: assigning ? new Date() : null,
      })
      .where(
        and(
          eq(dataQualityFindings.organizationId, organizationId),
          eq(dataQualityFindings.status, "open"),
          inArray(dataQualityFindings.findingId, candidates),
        ),
      )
      .returning({ findingId: dataQualityFindings.findingId });

    return { assigned: updated.length, findingIds: updated.map((row) => row.findingId) };
  }

  /**
   * The identifiers a selection names, bounded, oldest first.
   *
   * A group selection never becomes a list of identifiers on the client, and it
   * is resolved to one exactly once here — which is what makes "one decision"
   * true no matter how the caller expressed it. Oldest first so a group larger
   * than one decision is worked down from its oldest end rather than churning
   * the same arbitrary slice.
   */
  async selectCandidateIds(
    organizationId: string,
    selection: FindingSelection,
    status: FindingStatus,
  ): Promise<string[]> {
    const rows = await this.selectCandidates(organizationId, selection, status);
    return rows.map((row) => row.findingId);
  }

  async selectCandidates(
    organizationId: string,
    selection: FindingSelection,
    status: FindingStatus,
  ) {
    const scope =
      selection.kind === "ids"
        ? inArray(dataQualityFindings.findingId, selection.findingIds)
        : eq(dataQualityFindings.groupKey, selection.groupKey);

    return this.db
      .select({
        findingId: dataQualityFindings.findingId,
        proposedAction: dataQualityFindings.proposedAction,
        reversibility: dataQualityFindings.reversibility,
        partyId: dataQualityFindings.partyId,
        relatedPartyId: dataQualityFindings.relatedPartyId,
        groupKey: dataQualityFindings.groupKey,
      })
      .from(dataQualityFindings)
      .where(
        and(
          eq(dataQualityFindings.organizationId, organizationId),
          eq(dataQualityFindings.status, status),
          scope,
        ),
      )
      .orderBy(asc(dataQualityFindings.firstDetectedAt), asc(dataQualityFindings.findingId))
      .limit(MAX_BULK);
  }

  /** How much of a group one decision left behind. */
  async countOpenInGroup(organizationId: string, groupKey: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(dataQualityFindings)
      .where(
        and(
          eq(dataQualityFindings.organizationId, organizationId),
          eq(dataQualityFindings.status, "open"),
          eq(dataQualityFindings.groupKey, groupKey),
        ),
      );

    return Number(row?.n ?? 0);
  }

  // ── The decision ledger ───────────────────────────────────────────────────

  async listResolutions(organizationId: string, query: ListResolutionsQuery) {
    const position = decodeCursor(query.cursor);
    const conditions = eq(dataQualityResolutions.organizationId, organizationId);

    const keyset = position
      ? and(
          conditions,
          keysetBefore(dataQualityResolutions.decidedAt, dataQualityResolutions.resolutionId, position),
        )
      : conditions;

    const rows = await this.db
      .select()
      .from(dataQualityResolutions)
      .where(keyset)
      .orderBy(desc(dataQualityResolutions.decidedAt), desc(dataQualityResolutions.resolutionId))
      .limit(query.limit + 1);

    return buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.decidedAt.toISOString(),
      id: row.resolutionId,
    }));
  }
}
