import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { keysetAfter, keysetBefore } from "../../common/pagination/keyset";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { businessParties, deals, issueRecords } from "../../db/schema";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import type { ScopedRead } from "../access/scoped-read";
import { ISSUE_LAYOUTS, issueRecordRow } from "./issue-record-types";
import { issueFilters, issueProjection, readIssueRecord } from "./issue-record-queries";
import { IssueTransitionsService } from "./issue-transitions.service";
import type { CreateIssueInput, ListIssuesQuery, UpdateIssueInput } from "./dto/issues.schemas";
import { createIssueRecord, updateIssueRecord, type IssueWriteDeps } from "./lib/issue-writes";

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
 *
 * Reads are gated by the caller's view scope and live here. Writes are gated by
 * the record's anchors (party and deal, inside the org) and live in
 * `lib/issue-writes.ts`; this file keeps only the read-back each write ends with.
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

  async list(read: ScopedRead, query: ListIssuesQuery) {
    const organizationId = read.orgId;
    const conditions = read.compose(
      {
        tenant: issueRecords.organizationId,
        scope: { columns: { ownerColumn: issueRecords.ownerUserId } },
        and: issueFilters(organizationId, query),
      },
      (where) => where.sql,
      () => null,
    );
    if (conditions === null)
      return {
        layout: ISSUE_LAYOUTS[query.recordType],
        ...buildCursorPage([], query.limit, () => ({ sortValue: "", id: "" })),
        data: [],
      };

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
            ? keysetAfter(issueRecords.openedAt, issueRecords.issueRecordId, position)
            : keysetBefore(issueRecords.openedAt, issueRecords.issueRecordId, position),
        )
      : conditions;

    const rows = await this.db
      .select(issueProjection())
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
  async get(read: ScopedRead, issueRecordId: string) {
    return read.read(
      { tenant: issueRecords.organizationId, scope: { columns: { ownerColumn: issueRecords.ownerUserId } } },
      ({ sql: where }) => readIssueRecord(this.db, this.transitions, read.orgId, issueRecordId, where),
      () => null,
    );
  }

  private get writeDeps(): IssueWriteDeps {
    return { db: this.db, transitions: this.transitions };
  }

  /**
   * Files the record under the anchor rules in `lib/issue-writes.ts`, then reads it back.
   *
   * The read-back is unconditional rather than the writer's own view scope: a
   * member who files a complaint and assigns it to somebody else would otherwise
   * get a 404 for the record they had just created, which reads as the write
   * having failed.
   */
  async create(organizationId: string, userId: string, input: CreateIssueInput) {
    const issueRecordId = await createIssueRecord(this.writeDeps, organizationId, userId, input);
    return readIssueRecord(this.db, this.transitions, organizationId, issueRecordId, sql`true`);
  }

  /** Edits the record under the same anchor rules, then reads it back. */
  async update(organizationId: string, issueRecordId: string, input: UpdateIssueInput) {
    await updateIssueRecord(this.writeDeps, organizationId, issueRecordId, input);
    return readIssueRecord(this.db, this.transitions, organizationId, issueRecordId, sql`true`);
  }
}
