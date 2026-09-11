import { NotFoundException } from "@nestjs/common";
import { and, eq, isNotNull, isNull, lte, type SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { businessParties, deals, issueRecords } from "../../db/schema";
import { ISSUE_LAYOUTS, issueRecordRow } from "./issue-record-types";
import type { IssueTransitionsService } from "./issue-transitions.service";
import type { ListIssuesQuery } from "./dto/issues.schemas";

export function issueProjection() {
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

export function issueFilters(
  organizationId: string,
  query: ListIssuesQuery,
): (SQL | undefined)[] {
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

/**
 * One record, its layout, and every move it has made, with the scope predicate
 * passed in.
 *
 * The ledger travels with the record rather than behind a second call: "who
 * escalated this and why" is the first question anyone opening a complaint
 * asks, and a surface that has to fetch it separately is one that will render
 * the record without it.
 *
 * A writer reads back what they just wrote through an unconditional predicate rather than
 * their own view scope: a member who files a complaint and assigns it to
 * somebody else would otherwise get a 404 for the record they had just
 * created, which reads as the write having failed.
 */
export async function readIssueRecord(
  db: Db,
  transitions: IssueTransitionsService,
  organizationId: string,
  issueRecordId: string,
  scope: SQL,
) {
  const [row] = await db
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
    transitions: await transitions.list(organizationId, issueRecordId, 100),
  };
}
