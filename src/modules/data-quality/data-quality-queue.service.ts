import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, desc, eq, isNull, lt, sql, type SQL } from "drizzle-orm";
import { keysetAfter, keysetBefore } from "../../common/pagination/keyset";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { businessParties, dataQualityFindings, dataQualityResolutions } from "../../db/schema";
import type { FindingStatus } from "../../db/schema/crm/data-quality";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { SEVERITY_WEIGHTS } from "./finding-vocabulary";
import { MAX_BULK, type FindingSelection } from "./dto/data-quality.schemas";
import {
  assign,
  countOpenInGroup,
  selectCandidateIds,
  selectCandidates,
  type FindingSelectionDeps,
} from "./lib/finding-selection";
import { queueHealth } from "./lib/queue-health-window";
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
 * Reading the queue: a page of it at a time.
 *
 * Separate from resolution because the two have different shapes: this is all
 * reads and one narrow write, while resolving is a transaction with an executor
 * behind it. Keeping them apart is also what stops the read path acquiring the
 * resolution path's dependencies.
 *
 * What is left here is the paged half — a keyset window over the findings, the
 * `GROUP BY` behind the bulk-decision screen, and the decision ledger. The two
 * things that are not paged moved out: `lib/queue-health-window.ts` aggregates
 * over every row a tenant has and cannot be paged at all, and
 * `lib/finding-selection.ts` collapses a selection into a bounded list of
 * identifiers, which is the only part of this service another service calls.
 */
@Injectable()
export class DataQualityQueueService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private get deps(): FindingSelectionDeps {
    return { db: this.db };
  }

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

  /** The whole-queue aggregate; see `lib/queue-health-window.ts`. */
  health(organizationId: string, query: HealthQuery) {
    return queueHealth(this.deps, organizationId, query);
  }

  // ── Making it somebody's work ─────────────────────────────────────────────

  /** One statement whatever the size of the selection. */
  assign(organizationId: string, actorUserId: string, input: AssignFindingsInput) {
    return assign(this.deps, organizationId, actorUserId, input);
  }

  /** See `lib/finding-selection.ts`: the one place a selection becomes rows. */
  selectCandidateIds(
    organizationId: string,
    selection: FindingSelection,
    status: FindingStatus,
  ): Promise<string[]> {
    return selectCandidateIds(this.deps, organizationId, selection, status);
  }

  selectCandidates(organizationId: string, selection: FindingSelection, status: FindingStatus) {
    return selectCandidates(this.deps, organizationId, selection, status);
  }

  /** How much of a group one decision left behind. */
  countOpenInGroup(organizationId: string, groupKey: string): Promise<number> {
    return countOpenInGroup(this.deps, organizationId, groupKey);
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
