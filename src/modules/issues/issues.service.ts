import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { businessParties, deals, issueRecords } from "../../db/schema";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import { ISSUE_LAYOUTS, issueRecordRow } from "./issue-record-types";
import { IssueTransitionsService } from "./issue-transitions.service";
import type { CreateIssueInput, ListIssuesQuery, UpdateIssueInput } from "./dto/issues.schemas";

/**
 * The three record types, read and written.
 *
 * Every read here projects exactly the columns `issueRecordRow` needs, and the
 * rows it returns are keyed by the field names the served layout declares. That
 * is the entire integration with the renderer: there is no list component, no
 * table and no form in this module or anywhere downstream of it, because a
 * record type is a description plus a row and this file produces both.
 *
 * Stage lives on this table but is not written here. It moves only through
 * `IssueTransitionsService`, so no path exists that changes a stage without
 * leaving a row saying who changed it.
 */
@Injectable()
export class IssuesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly transitions: IssueTransitionsService,
  ) {}

  /** The layout descriptions, which are the whole of what a surface needs to render. */
  layouts() {
    return { recordTypes: Object.values(ISSUE_LAYOUTS) };
  }

  private projection() {
    return {
      issueRecordId: issueRecords.issueRecordId,
      recordType: issueRecords.recordType,
      title: issueRecords.title,
      severity: issueRecords.severity,
      stage: issueRecords.stage,
      ownerUserId: issueRecords.ownerUserId,
      partyId: issueRecords.partyId,
      dealId: issueRecords.dealId,
      dueAt: issueRecords.dueAt,
      openedAt: issueRecords.openedAt,
      acknowledgedAt: issueRecords.acknowledgedAt,
      closedAt: issueRecords.closedAt,
      details: issueRecords.details,
      reference: issueRecords.reference,
      /** Named, so a reader opens a customer rather than an identifier. */
      partyName: businessParties.name,
      dealTitle: deals.name,
    };
  }

  private filters(organizationId: string, query: ListIssuesQuery): (SQL | undefined)[] {
    const openOnly = query.openOnly === true || query.overdueOnly === true;
    return [
      eq(issueRecords.organizationId, organizationId),
      eq(issueRecords.recordType, query.recordType),
      query.stage ? eq(issueRecords.stage, query.stage) : undefined,
      query.severity ? eq(issueRecords.severity, query.severity) : undefined,
      query.ownerUserId ? eq(issueRecords.ownerUserId, query.ownerUserId) : undefined,
      query.partyId ? eq(issueRecords.partyId, query.partyId) : undefined,
      query.dealId !== undefined ? eq(issueRecords.dealId, query.dealId) : undefined,
      openOnly ? isNull(issueRecords.closedAt) : undefined,
      /**
       * Overdue implies open. A closed record that missed its deadline is a fact
       * about the past; the filter exists to find work that is late *now*.
       */
      query.overdueOnly === true
        ? and(isNotNull(issueRecords.dueAt), lte(issueRecords.dueAt, new Date()))
        : undefined,
    ];
  }

  async list(
    organizationId: string,
    userId: string,
    query: ListIssuesQuery,
    scope: DataScope,
  ) {
    const conditions = and(
      ...this.filters(organizationId, query).filter((c): c is SQL => c !== undefined),
      applyScope(scope, organizationId, userId, { ownerColumn: issueRecords.ownerUserId }),
    );

    const position = decodeCursor(query.cursor);
    const ascending = query.order === "oldest";

    /**
     * Row-value comparison over exactly the index's leading columns, so the scan
     * starts at the cursor rather than reading and discarding. The identifier is
     * inside the comparison rather than beside it because a sweep can file many
     * records in the same instant, and a cursor on the timestamp alone would
     * skip some of them and repeat others on every page after the first.
     */
    const keyset = position
      ? and(
          conditions,
          ascending
            ? sql`(${issueRecords.openedAt}, ${issueRecords.issueRecordId}) > (${new Date(position.sortValue)}, ${position.id})`
            : sql`(${issueRecords.openedAt}, ${issueRecords.issueRecordId}) < (${new Date(position.sortValue)}, ${position.id})`,
        )
      : conditions;

    const rows = await this.db
      .select(this.projection())
      .from(issueRecords)
      .leftJoin(
        businessParties,
        and(
          eq(businessParties.organizationId, issueRecords.organizationId),
          eq(businessParties.partyId, issueRecords.partyId),
        ),
      )
      .leftJoin(
        deals,
        and(eq(deals.orgId, issueRecords.organizationId), eq(deals.id, issueRecords.dealId)),
      )
      .where(keyset)
      .orderBy(
        ascending ? asc(issueRecords.openedAt) : desc(issueRecords.openedAt),
        ascending ? asc(issueRecords.issueRecordId) : desc(issueRecords.issueRecordId),
      )
      .limit(query.limit + 1);

    const page = buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.openedAt.toISOString(),
      id: row.issueRecordId,
    }));

    const now = Date.now();
    return {
      layout: ISSUE_LAYOUTS[query.recordType],
      ...page,
      data: page.data.map((row) => issueRecordRow(row, now)),
    };
  }

  /**
   * One record, its layout, and every move it has made.
   *
   * The ledger travels with the record rather than behind a second call: "who
   * escalated this and why" is the first question anyone opening a complaint
   * asks, and a surface that has to fetch it separately is one that will render
   * the record without it.
   */
  async get(organizationId: string, userId: string, issueRecordId: string, scope: DataScope) {
    return this.read(
      organizationId,
      issueRecordId,
      applyScope(scope, organizationId, userId, { ownerColumn: issueRecords.ownerUserId }),
    );
  }

  /**
   * The read itself, with the scope predicate passed in.
   *
   * A writer reads back what they just wrote through an unconditional predicate rather than
   * their own view scope: a member who files a complaint and assigns it to
   * somebody else would otherwise get a 404 for the record they had just
   * created, which reads as the write having failed.
   */
  private async read(organizationId: string, issueRecordId: string, scope: SQL) {
    const [row] = await this.db
      .select(this.projection())
      .from(issueRecords)
      .leftJoin(
        businessParties,
        and(
          eq(businessParties.organizationId, issueRecords.organizationId),
          eq(businessParties.partyId, issueRecords.partyId),
        ),
      )
      .leftJoin(
        deals,
        and(eq(deals.orgId, issueRecords.organizationId), eq(deals.id, issueRecords.dealId)),
      )
      .where(
        and(
          eq(issueRecords.organizationId, organizationId),
          eq(issueRecords.issueRecordId, issueRecordId),
          scope,
        ),
      )
      .limit(1);

    /**
     * 404 rather than 403, for a record in another organisation and for one this
     * caller's scope excludes alike. A 403 confirms the identifier exists, which
     * turns an id-guessing loop into a tenant census.
     */
    if (!row) throw new NotFoundException("Record not found");

    return {
      layout: ISSUE_LAYOUTS[row.recordType],
      record: issueRecordRow(row, Date.now()),
      transitions: await this.transitions.list(organizationId, issueRecordId, 100),
    };
  }

  async create(organizationId: string, userId: string, input: CreateIssueInput) {
    await this.assertAnchors(organizationId, input.partyId, input.dealId);

    const [created] = await this.db
      .insert(issueRecords)
      .values({
        organizationId,
        recordType: input.recordType,
        title: input.title,
        severity: input.severity,
        details: input.details,
        reference: input.reference,
        ownerUserId: input.ownerUserId,
        partyId: input.partyId,
        dealId: input.dealId,
        dueAt: input.dueAt === undefined ? undefined : new Date(input.dueAt),
        createdByUserId: userId,
      })
      .returning({ issueRecordId: issueRecords.issueRecordId });

    if (!created) throw new BadRequestException("Record not created");

    /**
     * The opening row of the ledger, with a null `fromStage` — the same shape
     * `deal_stage_transitions` uses for a deal's first move. Written here rather
     * than left implicit so a record's history starts where the record does; a
     * ledger whose first entry is the second thing that happened cannot say who
     * raised it.
     */
    await this.transitions.recordOpening(organizationId, created.issueRecordId, {
      kind: "human",
      userId,
    });

    return this.read(organizationId, created.issueRecordId, sql`true`);
  }

  async update(organizationId: string, issueRecordId: string, input: UpdateIssueInput) {
    const [existing] = await this.db
      .select({
        partyId: issueRecords.partyId,
        dealId: issueRecords.dealId,
        recordType: issueRecords.recordType,
      })
      .from(issueRecords)
      .where(
        and(
          eq(issueRecords.organizationId, organizationId),
          eq(issueRecords.issueRecordId, issueRecordId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException("Record not found");

    const partyId = input.partyId === undefined ? existing.partyId : input.partyId;
    /**
     * The two anchoring rules re-checked against the record as it will be, not
     * as it was. Clearing a complaint's party is the interesting case: the patch
     * looks innocuous and the resulting row violates criterion 2.
     */
    if (existing.recordType === "complaint" && partyId === null)
      throw new BadRequestException("A complaint must anchor to a party");

    const dealId = input.dealId === undefined ? existing.dealId : input.dealId;
    if (dealId !== null && partyId === null)
      throw new BadRequestException("A deal anchor needs the party it concerns");

    await this.assertAnchors(
      organizationId,
      input.partyId ?? undefined,
      input.dealId ?? undefined,
    );

    await this.db
      .update(issueRecords)
      .set({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.severity === undefined ? {} : { severity: input.severity }),
        ...(input.details === undefined ? {} : { details: input.details }),
        ...(input.reference === undefined ? {} : { reference: input.reference }),
        ...(input.ownerUserId === undefined ? {} : { ownerUserId: input.ownerUserId }),
        ...(input.partyId === undefined ? {} : { partyId: input.partyId }),
        ...(input.dealId === undefined ? {} : { dealId: input.dealId }),
        ...(input.dueAt === undefined
          ? {}
          : { dueAt: input.dueAt === null ? null : new Date(input.dueAt) }),
      })
      .where(
        and(
          eq(issueRecords.organizationId, organizationId),
          eq(issueRecords.issueRecordId, issueRecordId),
        ),
      );

    return this.read(organizationId, issueRecordId, sql`true`);
  }

  /**
   * Both anchors verified inside the caller's organisation before they are
   * written.
   *
   * The party's foreign key is the composite tenant key and would refuse a
   * cross-tenant identifier on its own; this exists so the refusal is a 404
   * naming what was missing rather than a 23503 surfacing as a 500. The deal's
   * key is composite too, and the same applies.
   */
  private async assertAnchors(
    organizationId: string,
    partyId: string | undefined,
    dealId: number | undefined,
  ): Promise<void> {
    if (partyId !== undefined) {
      const [party] = await this.db
        .select({ partyId: businessParties.partyId })
        .from(businessParties)
        .where(
          and(
            eq(businessParties.organizationId, organizationId),
            eq(businessParties.partyId, partyId),
            isNull(businessParties.deletedAt),
          ),
        )
        .limit(1);
      if (!party) throw new NotFoundException("Party not found");
    }

    if (dealId !== undefined) {
      const [deal] = await this.db
        .select({ id: deals.id })
        .from(deals)
        .where(
          and(eq(deals.orgId, organizationId), eq(deals.id, dealId), isNull(deals.deletedAt)),
        )
        .limit(1);
      if (!deal) throw new NotFoundException("Deal not found");
    }
  }
}
