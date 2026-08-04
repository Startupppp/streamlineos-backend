import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { createHash } from "crypto";
import {
  expenses,
  finExpensePolicies,
  finApprovalPolicies,
  finApprovalRequests,
  expenseCategories,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { compareDecimals, formatDecimal } from "../accounting/core/money.util";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { FinancePostingService } from "../accounting/core/finance-posting.service";
import type { PostJournalLine } from "../accounting/core/finance-posting.types";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function normalizeMerchant(merchant: string | null | undefined): string {
  if (!merchant) return "";
  return merchant.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildReceiptHash(
  orgId: string,
  amount: string,
  expenseDate: string,
  merchant: string | null | undefined,
): string {
  const raw = `${orgId}|${formatDecimal(amount, 2)}|${expenseDate}|${normalizeMerchant(merchant)}`;
  return createHash("sha256").update(raw).digest("hex");
}

interface PolicyEvalResult {
  policyFlag: string | null;
  blocked: boolean;
  blockReason: string | null;
}

interface ApprovalCheckResult {
  needsApproval: boolean;
  approverUserId: string | null;
  policyId: number | null;
}

@Injectable()
export class ExpenseLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly posting: FinancePostingService,
  ) {}

  computeReceiptHash(
    orgId: string,
    amount: string,
    expenseDate: string,
    merchant: string | null | undefined,
  ): string {
    return buildReceiptHash(orgId, amount, expenseDate, merchant);
  }

  async checkDuplicate(
    orgId: string,
    hash: string,
    excludeExpenseId?: number,
  ): Promise<number | null> {
    const rows = await this.db
      .select({ id: expenses.id })
      .from(expenses)
      .where(and(eq(expenses.orgId, orgId), eq(expenses.receiptHash, hash)))
      .limit(2);

    for (const row of rows) {
      if (excludeExpenseId === undefined || row.id !== excludeExpenseId) {
        return row.id;
      }
    }
    return null;
  }

  async evaluatePolicy(
    orgId: string,
    categoryId: number | null | undefined,
    amount: number,
    hasReceipt: boolean,
  ): Promise<PolicyEvalResult> {
    const conditions = [
      eq(finExpensePolicies.orgId, orgId),
      eq(finExpensePolicies.isActive, true),
    ];

    const policies = await this.db
      .select()
      .from(finExpensePolicies)
      .where(and(...conditions));

    const applicable = policies.filter(
      (p) => p.categoryId === null || p.categoryId === categoryId,
    );

    let policyFlag: string | null = null;

    for (const policy of applicable) {
      if (policy.maxAmount !== null && compareDecimals(amount.toString(), policy.maxAmount) > 0) {
        return { policyFlag: "OVER_LIMIT", blocked: true, blockReason: `Amount exceeds policy limit of ${policy.maxAmount}` };
      }

      if (
        policy.requiresReceiptAbove !== null &&
        compareDecimals(amount.toString(), policy.requiresReceiptAbove) > 0 &&
        !hasReceipt
      ) {
        policyFlag = "RECEIPT_REQUIRED";
      }
    }

    return { policyFlag, blocked: false, blockReason: null };
  }

  async findApplicableApprovalPolicy(
    orgId: string,
    amount: number,
  ): Promise<ApprovalCheckResult> {
    const policies = await this.db
      .select()
      .from(finApprovalPolicies)
      .where(
        and(
          eq(finApprovalPolicies.orgId, orgId),
          eq(finApprovalPolicies.recordType, "EXPENSE"),
          eq(finApprovalPolicies.isActive, true),
        ),
      );

    const applicable = policies.find((p) => {
      if (p.minAmount === null) return true;
      return compareDecimals(amount.toString(), p.minAmount) >= 0;
    });

    if (!applicable) {
      return { needsApproval: false, approverUserId: null, policyId: null };
    }

    return {
      needsApproval: true,
      approverUserId: applicable.approverUserId ?? null,
      policyId: applicable.id,
    };
  }

  async submitExpense(
    u: CurrentUserContext,
    expenseId: number,
  ): Promise<{ success: boolean; approvalRequired: boolean; policyFlag: string | null; duplicateOf: number | null }> {
    const expense = await this.db.query.expenses.findFirst({
      where: and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)),
    });

    if (!expense) throw new NotFoundException("Expense not found");

    const allowedFromStatuses: string[] = ["DRAFT", "PENDING"];
    if (!allowedFromStatuses.includes(expense.status ?? "")) {
      throw new BadRequestException(`Expense in status ${expense.status} cannot be submitted`);
    }

    const amount = Number(expense.amount);
    const hasReceipt = !!expense.receiptUrl;

    const hash = buildReceiptHash(u.orgId, expense.amount, expense.expenseDate, expense.merchant);
    const duplicateOf = await this.checkDuplicate(u.orgId, hash, expenseId);

    const policyResult = await this.evaluatePolicy(
      u.orgId,
      expense.categoryId ?? null,
      amount,
      hasReceipt,
    );

    if (policyResult.blocked) {
      throw new BadRequestException(policyResult.blockReason ?? "Expense blocked by policy");
    }

    const approvalResult = await this.findApplicableApprovalPolicy(u.orgId, amount);

    await this.db.transaction(async (tx) => {
      await tx
        .update(expenses)
        .set({
          status: "SUBMITTED",
          receiptHash: hash,
          policyFlag: policyResult.policyFlag,
          updatedAt: new Date(),
        })
        .where(and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)));

      if (approvalResult.needsApproval) {
        await tx.insert(finApprovalRequests).values({
          orgId: u.orgId,
          recordType: "EXPENSE",
          recordId: expenseId,
          status: "PENDING",
          requestedBy: u.userId,
        });
      }
    });

    this.audit.log({
      action: "expense.submitted",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(expenseId),
      targetType: "expense",
    });

    if (approvalResult.approverUserId) {
      void this.dispatch.emit({
        eventKey: "accounting.expense.submitted",
        orgId: u.orgId,
        actorUserId: u.userId,
        targetUserIds: [approvalResult.approverUserId],
        entityType: "expense",
        entityId: String(expenseId),
        variables: { amount: expense.amount, category: expense.category },
      });
    }

    await this.cache.invalidateNamespace(CACHE_KEYS.expensesListNamespace(u.orgId));

    return {
      success: true,
      approvalRequired: approvalResult.needsApproval,
      policyFlag: policyResult.policyFlag,
      duplicateOf,
    };
  }

  async approveExpense(
    u: CurrentUserContext,
    expenseId: number,
  ): Promise<{ success: boolean; entryId: number | null }> {
    const expense = await this.db.query.expenses.findFirst({
      where: and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)),
    });

    if (!expense) throw new NotFoundException("Expense not found");

    const approvableStatuses: string[] = ["PENDING", "SUBMITTED"];
    if (!approvableStatuses.includes(expense.status ?? "")) {
      throw new BadRequestException(`Expense in status ${expense.status} cannot be approved`);
    }

    const openApprovalRequest = await this.db.query.finApprovalRequests.findFirst({
      where: and(
        eq(finApprovalRequests.orgId, u.orgId),
        eq(finApprovalRequests.recordType, "EXPENSE"),
        eq(finApprovalRequests.recordId, expenseId),
        eq(finApprovalRequests.status, "PENDING"),
      ),
    });

    if (openApprovalRequest) {
      if (!u.isOrgOwner) {
        throw new BadRequestException("This expense requires a pending approval to be granted first");
      }
      await this.db
        .update(finApprovalRequests)
        .set({ status: "APPROVED", decidedBy: u.userId, decidedAt: new Date() })
        .where(eq(finApprovalRequests.id, openApprovalRequest.id));
    }

    const categoryWithLedger = expense.categoryId
      ? await this.db.query.expenseCategories.findFirst({
          where: eq(expenseCategories.id, expense.categoryId),
          columns: { id: true, name: true, ledgerAccountId: true },
        })
      : null;

    const amount = Number(expense.amount);
    const amountStr = amount.toFixed(2);
    const taxAmount = expense.taxAmount ? Number(expense.taxAmount) : 0;
    const expenseAmount = amount - taxAmount;

    const lines: PostJournalLine[] = [
      categoryWithLedger?.ledgerAccountId
        ? {
            accountId: categoryWithLedger.ledgerAccountId,
            debit: expenseAmount.toFixed(2),
            description: `Expense: ${expense.category}`,
          }
        : {
            systemPurpose: "EXPENSE_CLEARING" as const,
            debit: expenseAmount.toFixed(2),
            description: `Expense: ${expense.category}`,
          },
    ];

    if (taxAmount > 0) {
      lines.push({
        systemPurpose: "TAX_RECEIVABLE",
        debit: taxAmount.toFixed(2),
        description: "Tax receivable on expense",
      });
    }

    lines.push({
      systemPurpose: "REIMBURSEMENT_PAYABLE",
      credit: amountStr,
      description: "Reimbursement payable to employee",
    });

    const postResult = await this.posting.postJournal(u, {
      entryDate: expense.expenseDate,
      description: `Expense approved: ${expense.category} — ${expense.description ?? ""}`.trimEnd(),
      sourceType: "EXPENSE",
      sourceId: String(expenseId),
      sourceEvent: "approved",
      lines,
    });

    await this.db
      .update(expenses)
      .set({
        status: "REIMBURSEMENT_PENDING",
        approverId: u.userId,
        approvedAt: new Date(),
        postedJournalEntryId: postResult.entryId,
        updatedAt: new Date(),
      })
      .where(and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)));

    this.audit.log({
      action: "expense.approved",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(expenseId),
      targetType: "expense",
      metadata: { journalEntryId: postResult.entryId },
    });

    void this.dispatch.emit({
      eventKey: "accounting.expense.approved",
      orgId: u.orgId,
      actorUserId: u.userId,
      targetUserIds: [expense.userId],
      entityType: "expense",
      entityId: String(expenseId),
      variables: { amount: expense.amount, category: expense.category },
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.expensesListNamespace(u.orgId));

    return { success: true, entryId: postResult.entryId };
  }

  async rejectExpense(
    u: CurrentUserContext,
    expenseId: number,
    rejectionReason: string,
  ): Promise<{ success: boolean }> {
    const expense = await this.db.query.expenses.findFirst({
      where: and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)),
      columns: { id: true, status: true, userId: true, amount: true, category: true },
    });

    if (!expense) throw new NotFoundException("Expense not found");

    const rejectableStatuses: string[] = ["PENDING", "SUBMITTED"];
    if (!rejectableStatuses.includes(expense.status ?? "")) {
      throw new BadRequestException(`Expense in status ${expense.status} cannot be rejected`);
    }

    await this.db
      .update(expenses)
      .set({
        status: "REJECTED",
        rejectionReason,
        approverId: u.userId,
        updatedAt: new Date(),
      })
      .where(and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)));

    await this.db
      .update(finApprovalRequests)
      .set({ status: "REJECTED", decidedBy: u.userId, decidedAt: new Date(), decisionComment: rejectionReason })
      .where(
        and(
          eq(finApprovalRequests.orgId, u.orgId),
          eq(finApprovalRequests.recordType, "EXPENSE"),
          eq(finApprovalRequests.recordId, expenseId),
          eq(finApprovalRequests.status, "PENDING"),
        ),
      );

    this.audit.log({
      action: "expense.rejected",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(expenseId),
      targetType: "expense",
      metadata: { rejectionReason },
    });

    void this.dispatch.emit({
      eventKey: "accounting.expense.rejected",
      orgId: u.orgId,
      actorUserId: u.userId,
      targetUserIds: [expense.userId],
      entityType: "expense",
      entityId: String(expenseId),
      variables: { amount: expense.amount, category: expense.category, reason: rejectionReason },
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.expensesListNamespace(u.orgId));

    return { success: true };
  }
}
