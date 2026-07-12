import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  purchaseBills,
  finApprovalRequests,
  journalEntries,
} from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { FinancePostingService } from "../accounting/finance-posting.service";
import { JournalPostingService } from "../accounting/journal-posting.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  checkApprovalPolicy,
  insertApprovalRequest,
  getApprovalRequest,
} from "./ap-approval.helper";
import type { BillApprovalNote, BillCancel } from "./dto/finance-ap.schemas";

@Injectable()
export class BillsWorkflowService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly financePosting: FinancePostingService,
    private readonly journalPosting: JournalPostingService,
  ) {}

  async submitForApproval(u: CurrentUserContext, billId: number, input: BillApprovalNote) {
    const { orgId, userId } = u;

    const rows = await this.db
      .select()
      .from(purchaseBills)
      .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)))
      .limit(1);
    const bill = rows[0];
    if (!bill) throw new NotFoundException("Purchase bill not found");

    if (bill.status !== "DRAFT") {
      throw new ConflictException(`Bill is in status ${bill.status}; only DRAFT bills can be submitted`);
    }

    const total = Number(bill.total ?? 0);
    const check = await checkApprovalPolicy(this.db, orgId, "PURCHASE_BILL", total);

    if (!check.needsApproval) {
      await this.db
        .update(purchaseBills)
        .set({ status: "PENDING_APPROVAL", updatedAt: new Date() })
        .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)));

      this.audit.log({
        action: "accounting.bill.submit_approval_skipped",
        userId,
        orgId,
        resourceType: "purchase_bill",
        resourceId: String(billId),
        result: "SUCCESS",
      });

      return { id: billId, status: "PENDING_APPROVAL", approvalRequired: false };
    }

    const existing = await getApprovalRequest(this.db, orgId, "PURCHASE_BILL", billId);
    if (existing && existing.status === "PENDING") {
      throw new ConflictException("An approval request is already pending for this bill");
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(purchaseBills)
        .set({ status: "PENDING_APPROVAL", updatedAt: new Date() })
        .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)));

      await tx.insert(finApprovalRequests).values({
        orgId,
        recordType: "PURCHASE_BILL",
        recordId: billId,
        status: "PENDING",
        requestedBy: userId,
        note: input.note ?? null,
      });
    });

    if (check.approverUserId) {
      void this.dispatch.emit({
        eventKey: "accounting.bill.approval_requested",
        orgId,
        actorUserId: userId,
        targetUserIds: [check.approverUserId],
        entityType: "purchase_bill",
        entityId: String(billId),
        variables: { billNumber: bill.billNumber, amount: total, note: input.note },
      });
    }

    this.audit.log({
      action: "accounting.bill.submit_approval",
      userId,
      orgId,
      resourceType: "purchase_bill",
      resourceId: String(billId),
      result: "SUCCESS",
    });

    return { id: billId, status: "PENDING_APPROVAL", approvalRequired: true };
  }

  async approveBill(u: CurrentUserContext, billId: number) {
    const { orgId, userId } = u;

    const rows = await this.db
      .select()
      .from(purchaseBills)
      .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)))
      .limit(1);
    const bill = rows[0];
    if (!bill) throw new NotFoundException("Purchase bill not found");

    if (bill.status !== "PENDING_APPROVAL" && bill.status !== "DRAFT") {
      throw new ConflictException(`Bill status ${bill.status} cannot be approved`);
    }

    const approvalReq = await getApprovalRequest(this.db, orgId, "PURCHASE_BILL", billId);
    if (approvalReq && approvalReq.status !== "PENDING" && approvalReq.status !== "APPROVED") {
      throw new ConflictException("Approval request is not in a state that allows approval");
    }

    await this.journalPosting.seedChartOfAccountsForOrg(orgId);

    const subtotal = Number(bill.subtotal ?? 0);
    const discount = Number(bill.discount ?? 0);
    const cgst = Number(bill.cgstAmount ?? 0);
    const sgst = Number(bill.sgstAmount ?? 0);
    const igst = Number(bill.igstAmount ?? 0);
    const taxPool = Math.round((cgst + sgst + igst) * 100) / 100;
    const total = Number(bill.total ?? 0);
    const supplierStateCode =
      bill.supplierGstin && bill.supplierGstin.length >= 2
        ? bill.supplierGstin.slice(0, 2)
        : bill.placeOfSupply ?? "";
    const placeOfSupplyStateCode = bill.placeOfSupply ?? supplierStateCode;

    await this.db.transaction(async (tx) => {
      if (approvalReq) {
        await tx
          .update(finApprovalRequests)
          .set({ status: "APPROVED", decidedBy: userId, decidedAt: new Date() })
          .where(and(
            eq(finApprovalRequests.orgId, orgId),
            eq(finApprovalRequests.recordType, "PURCHASE_BILL"),
            eq(finApprovalRequests.recordId, billId),
          ));
      }

      await tx
        .update(purchaseBills)
        .set({ status: "POSTED", approvedBy: userId, approvedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)));

      await this.journalPosting.postPurchaseBill(
        {
          orgId,
          billId: bill.id,
          billNumber: bill.billNumber,
          billDate: bill.billDate,
          supplierStateCode,
          placeOfSupplyStateCode,
          subtotal,
          discount,
          taxPool,
          total,
          expenseAccountCode: bill.expenseAccountCode ?? "5990",
          createdBy: userId,
        },
        tx,
      );
    });

    this.audit.log({
      action: "accounting.bill.approve",
      userId,
      orgId,
      resourceType: "purchase_bill",
      resourceId: String(billId),
      result: "SUCCESS",
    });

    return { id: billId, status: "POSTED" };
  }

  async cancelBill(u: CurrentUserContext, billId: number, input: BillCancel) {
    const { orgId, userId } = u;

    const rows = await this.db
      .select()
      .from(purchaseBills)
      .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)))
      .limit(1);
    const bill = rows[0];
    if (!bill) throw new NotFoundException("Purchase bill not found");

    const paid = Number(bill.amountPaid ?? 0);
    if (paid > 0.005) {
      throw new ConflictException("Cannot cancel a bill that has payments allocated");
    }

    if (bill.status === "CANCELLED") {
      throw new ConflictException("Bill is already cancelled");
    }

    if (bill.status === "POSTED") {
      const postedEntry = await this.db
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.orgId, orgId),
            eq(journalEntries.sourceType, "purchase_bill"),
            eq(journalEntries.sourceId, String(billId)),
            eq(journalEntries.sourceEvent, "post"),
          ),
        )
        .limit(1);

      if (postedEntry[0]) {
        await this.financePosting.reverseJournal(u, postedEntry[0].id, input.reason ?? `Bill ${bill.billNumber} cancelled`);
      }
    }

    await this.db
      .update(purchaseBills)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)));

    this.audit.log({
      action: "accounting.bill.cancel",
      userId,
      orgId,
      resourceType: "purchase_bill",
      resourceId: String(billId),
      metadata: { reason: input.reason },
      result: "SUCCESS",
    });

    return { id: billId, status: "CANCELLED" };
  }
}
