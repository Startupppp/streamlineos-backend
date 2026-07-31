import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  finApprovalRequests,
  users,
  purchaseBills,
  expenses,
  creditNotes,
  journalEntries,
  journalLines,
  vendorPayments,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { buildListResponse, paginateOffset } from "../../../common/pagination/pagination";
import type { ListApprovalsQuery, ApprovalDecisionInput } from "./dto/finance-controls.schemas";

type FinApprovalRecordType =
  | "MANUAL_JOURNAL"
  | "PURCHASE_BILL"
  | "VENDOR_PAYMENT"
  | "EXPENSE"
  | "CREDIT_NOTE"
  | "PERIOD_REOPEN"
  | "BANK_ADJUSTMENT";

interface RecordContext {
  label: string;
  amount: string | null;
}

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async list(orgId: string, query: ListApprovalsQuery) {
    const { limit, offset } = paginateOffset(query);
    const conditions = [eq(finApprovalRequests.orgId, orgId)];
    if (query.status) conditions.push(eq(finApprovalRequests.status, query.status));
    if (query.recordType) conditions.push(eq(finApprovalRequests.recordType, query.recordType));

    const [rows, [{ count }]] = await Promise.all([
      this.db
        .select()
        .from(finApprovalRequests)
        .where(and(...conditions))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(finApprovalRequests)
        .where(and(...conditions)),
    ]);

    const requesterIds = [...new Set(rows.map((r) => r.requestedBy))];
    const requesterRows =
      requesterIds.length > 0
        ? await this.db
            .select({
              id: users.id,
              name: users.name,
              firstName: users.firstName,
              lastName: users.lastName,
              email: users.email,
            })
            .from(users)
            .where(inArray(users.id, requesterIds))
        : [];

    const userMap = new Map(
      requesterRows.map((u) => [u.id, { name: u.name, firstName: u.firstName, lastName: u.lastName, email: u.email }]),
    );

    const contextMap = await this.batchEnrichRecords(orgId, rows);

    const enriched = rows.map((row) => {
      const requester = userMap.get(row.requestedBy);
      const ctx = contextMap.get(`${row.recordType}:${row.recordId}`);
      return {
        ...row,
        requesterDisplayName: buildDisplayName(requester),
        recordLabel: ctx?.label ?? null,
        recordAmount: ctx?.amount ?? null,
      };
    });

    return buildListResponse(enriched, count, query);
  }

  async counts(orgId: string) {
    const rows = await this.db
      .select({
        status: finApprovalRequests.status,
        count: sql<number>`count(*)::int`,
      })
      .from(finApprovalRequests)
      .where(eq(finApprovalRequests.orgId, orgId))
      .groupBy(finApprovalRequests.status);

    return {
      PENDING: 0,
      APPROVED: 0,
      REJECTED: 0,
      ...Object.fromEntries(rows.map((r) => [r.status, r.count])),
    };
  }

  async approve(orgId: string, userId: string, requestId: number, input: ApprovalDecisionInput) {
    return this.decide(orgId, userId, requestId, "APPROVED", input.comment);
  }

  async reject(orgId: string, userId: string, requestId: number, input: ApprovalDecisionInput) {
    return this.decide(orgId, userId, requestId, "REJECTED", input.comment);
  }

  private async decide(
    orgId: string,
    userId: string,
    requestId: number,
    decision: "APPROVED" | "REJECTED",
    comment: string | undefined,
  ) {
    const rows = await this.db
      .select()
      .from(finApprovalRequests)
      .where(
        and(
          eq(finApprovalRequests.id, requestId),
          eq(finApprovalRequests.orgId, orgId),
        ),
      )
      .limit(1);

    const request = rows[0];
    if (!request) throw new NotFoundException("Approval request not found");
    if (request.status !== "PENDING") {
      throw new ForbiddenException(`Approval request is already ${request.status.toLowerCase()}`);
    }
    if (request.requestedBy === userId) {
      throw new ForbiddenException("Separation of duties: you cannot approve your own request");
    }

    const [updated] = await this.db
      .update(finApprovalRequests)
      .set({
        status: decision,
        decidedBy: userId,
        decidedAt: new Date(),
        decisionComment: comment ?? null,
      })
      .where(
        and(
          eq(finApprovalRequests.id, requestId),
          eq(finApprovalRequests.orgId, orgId),
        ),
      )
      .returning();

    if (!updated) throw new NotFoundException("Approval request not found");

    this.audit.log({
      action: `accounting.approval.${decision.toLowerCase()}`,
      userId,
      orgId,
      resourceType: "approval_request",
      resourceId: String(requestId),
      metadata: { recordType: request.recordType, recordId: request.recordId, comment },
      result: "SUCCESS",
    });

    void this.dispatchDecisionNotification(orgId, userId, request.requestedBy, requestId, decision);

    return updated;
  }

  private dispatchDecisionNotification(
    orgId: string,
    actorUserId: string,
    requestedBy: string,
    requestId: number,
    decision: "APPROVED" | "REJECTED",
  ) {
    return this.dispatch
      .emit({
        eventKey: "accounting.approval.decided",
        orgId,
        actorUserId,
        targetUserIds: [requestedBy],
        entityType: "approval_request",
        entityId: String(requestId),
        variables: { decision },
      })
      .catch(() => undefined);
  }

  private async batchEnrichRecords(
    orgId: string,
    rows: Array<{ recordType: FinApprovalRecordType; recordId: number }>,
  ): Promise<Map<string, RecordContext>> {
    const byType = groupBy(rows, (r) => r.recordType);
    const result = new Map<string, RecordContext>();

    const enrichBatch = async <T extends { id: number }>(
      recordType: FinApprovalRecordType,
      fetcher: (ids: number[]) => Promise<T[]>,
      mapper: (row: T) => RecordContext,
    ) => {
      const items = byType.get(recordType);
      if (!items || items.length === 0) return;
      const ids = items.map((r) => r.recordId);
      const fetchedRows = await fetcher(ids);
      for (const row of fetchedRows) {
        result.set(`${recordType}:${row.id}`, mapper(row));
      }
    };

    await Promise.all([
      enrichBatch(
        "MANUAL_JOURNAL",
        (ids) =>
          this.db
            .select({
              id: journalEntries.id,
              entryNumber: journalEntries.entryNumber,
              description: journalEntries.description,
              total: sql<string>`COALESCE(SUM(${journalLines.debit}), '0')`,
            })
            .from(journalEntries)
            .leftJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
            .where(and(eq(journalEntries.orgId, orgId), inArray(journalEntries.id, ids)))
            .groupBy(journalEntries.id, journalEntries.entryNumber, journalEntries.description),
        (r) => ({
          label: r.description ?? r.entryNumber,
          amount: r.total,
        }),
      ),

      enrichBatch(
        "PURCHASE_BILL",
        (ids) =>
          this.db
            .select({
              id: purchaseBills.id,
              billNumber: purchaseBills.billNumber,
              total: purchaseBills.total,
            })
            .from(purchaseBills)
            .where(and(eq(purchaseBills.orgId, orgId), inArray(purchaseBills.id, ids))),
        (r) => ({ label: r.billNumber, amount: r.total }),
      ),

      enrichBatch(
        "EXPENSE",
        (ids) =>
          this.db
            .select({
              id: expenses.id,
              description: expenses.description,
              amount: expenses.amount,
            })
            .from(expenses)
            .where(and(eq(expenses.orgId, orgId), inArray(expenses.id, ids))),
        (r) => ({ label: r.description ?? `Expense #${r.id}`, amount: r.amount }),
      ),

      enrichBatch(
        "CREDIT_NOTE",
        (ids) =>
          this.db
            .select({
              id: creditNotes.id,
              creditNoteNumber: creditNotes.creditNoteNumber,
              total: creditNotes.total,
            })
            .from(creditNotes)
            .where(and(eq(creditNotes.orgId, orgId), inArray(creditNotes.id, ids))),
        (r) => ({ label: r.creditNoteNumber, amount: r.total }),
      ),

      enrichBatch(
        "VENDOR_PAYMENT",
        (ids) =>
          this.db
            .select({
              id: vendorPayments.id,
              amount: vendorPayments.amount,
            })
            .from(vendorPayments)
            .where(and(eq(vendorPayments.orgId, orgId), inArray(vendorPayments.id, ids))),
        (r) => ({ label: `Vendor Payment #${r.id}`, amount: r.amount }),
      ),
    ]);

    return result;
  }
}

function buildDisplayName(
  u: { name?: string | null; firstName?: string | null; lastName?: string | null; email: string } | undefined,
): string {
  if (!u) return "Unknown";
  if (u.name) return u.name;
  const parts = [u.firstName, u.lastName].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  return u.email;
}

function groupBy<T>(arr: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const key = keyFn(item);
    const existing = map.get(key);
    if (existing) {
      existing.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}
