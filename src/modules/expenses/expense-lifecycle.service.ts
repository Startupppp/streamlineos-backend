import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { createHash } from "crypto";
import { expenses, finExpensePolicies } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { fromDecimalString, money, toDecimalString } from "../accounting/kernel/money";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { PostingCommandService } from "../accounting/adapters/posting-command.service";
import { AdapterRejection } from "../accounting/adapters/posting-command.types";
import { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

/**
 * Expense rows carry decimal strings; the ledger kernel works in integer minor
 * units. Everything crossing into accounting — and every policy comparison —
 * converts here, once, so no two amounts are ever compared as floats.
 *
 * `expenses.currency` is free text that predates the currency catalogue, so an
 * unrecognised code falls back to a two-decimal reading rather than throwing:
 * refusing to submit an expense over a currency code is a worse answer than
 * assuming the near-universal scale.
 */
function amountToMinor(amount: string | number, currency: string): number {
  const text = typeof amount === "number" ? amount.toString() : amount.trim();
  try {
    return fromDecimalString(text, currency.toUpperCase()).minor;
  } catch {
    return fromDecimalString(Number(text).toFixed(2), "INR").minor;
  }
}

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
  // Two decimals, exactly as the retired `formatDecimal(amount, 2)` produced,
  // so hashes computed before the rewrite still match.
  const normalizedAmount = toDecimalString(money(amountToMinor(amount, "INR"), "INR"));
  const raw = `${orgId}|${normalizedAmount}|${expenseDate}|${normalizeMerchant(merchant)}`;
  return createHash("sha256").update(raw).digest("hex");
}

interface PolicyEvalResult {
  policyFlag: string | null;
  blocked: boolean;
  blockReason: string | null;
}

interface ApprovalCheckResult {
  needsApproval: boolean;
  policyId: number | null;
}

/**
 * The expense claim lifecycle: submit, approve, reject.
 *
 * Approval posts an accrual to the general ledger through
 * `PostingCommandService`, the accounting module's anti-corruption layer.
 * Nothing here names a GL account: lines are tagged with a `GlSystemTag` and
 * accounting resolves them against the organisation's own chart, so a tenant
 * renumbering their accounts cannot break expense approval.
 *
 * Accounting is opt-in, and HR self-service is not. An organisation that never
 * enabled accounting still approves expenses — the posting is skipped, not
 * failed (the same contract `payroll-posting.service.ts` and `grn.service.ts`
 * keep).
 */
@Injectable()
export class ExpenseLifecycleService {
  private readonly logger = new Logger(ExpenseLifecycleService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly posting: PostingCommandService,
    private readonly access: AccessService,
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
    amount: number | string,
    currency: string,
    hasReceipt: boolean,
  ): Promise<PolicyEvalResult> {
    const policies = await this.db
      .select()
      .from(finExpensePolicies)
      .where(
        and(
          eq(finExpensePolicies.orgId, orgId),
          eq(finExpensePolicies.isActive, true),
        ),
      );

    const applicable = policies.filter(
      (p) => p.categoryId === null || p.categoryId === categoryId,
    );

    const amountMinor = amountToMinor(amount, currency);
    let policyFlag: string | null = null;

    for (const policy of applicable) {
      if (
        policy.maxAmount !== null &&
        amountMinor > amountToMinor(policy.maxAmount, currency)
      ) {
        return {
          policyFlag: "OVER_LIMIT",
          blocked: true,
          blockReason: `Amount exceeds policy limit of ${policy.maxAmount}`,
        };
      }

      if (
        policy.requiresReceiptAbove !== null &&
        amountMinor > amountToMinor(policy.requiresReceiptAbove, currency) &&
        !hasReceipt
      ) {
        policyFlag = "RECEIPT_REQUIRED";
      }
    }

    return { policyFlag, blocked: false, blockReason: null };
  }

  /**
   * Whether this claim needs a second pair of eyes.
   *
   * The retired `fin_approval_policies` / `fin_approval_requests` pair went with
   * the pre-rewrite accounting schema and has no successor — there is no
   * org-wide approval table on the new kernel. The threshold now comes from
   * `fin_expense_policies.requires_approval_above`, which is the column that was
   * always meant to carry it, and the pending state is the expense's own
   * `SUBMITTED` status rather than a parallel request row.
   */
  async findApplicableApprovalPolicy(
    orgId: string,
    categoryId: number | null | undefined,
    amount: number | string,
    currency: string,
  ): Promise<ApprovalCheckResult> {
    const policies = await this.db
      .select()
      .from(finExpensePolicies)
      .where(
        and(
          eq(finExpensePolicies.orgId, orgId),
          eq(finExpensePolicies.isActive, true),
        ),
      );

    const amountMinor = amountToMinor(amount, currency);
    const triggered = policies
      .filter((p) => p.categoryId === null || p.categoryId === categoryId)
      .find(
        (p) =>
          p.requiresApprovalAbove !== null &&
          amountMinor > amountToMinor(p.requiresApprovalAbove, currency),
      );

    return triggered
      ? { needsApproval: true, policyId: triggered.id }
      : { needsApproval: false, policyId: null };
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

    const currency = expense.currency || "INR";
    const hasReceipt = !!expense.receiptUrl;

    const hash = buildReceiptHash(u.orgId, expense.amount, expense.expenseDate, expense.merchant);
    const duplicateOf = await this.checkDuplicate(u.orgId, hash, expenseId);

    const policyResult = await this.evaluatePolicy(
      u.orgId,
      expense.categoryId ?? null,
      expense.amount,
      currency,
      hasReceipt,
    );

    if (policyResult.blocked) {
      throw new BadRequestException(policyResult.blockReason ?? "Expense blocked by policy");
    }

    const approvalResult = await this.findApplicableApprovalPolicy(
      u.orgId,
      expense.categoryId ?? null,
      expense.amount,
      currency,
    );

    await this.db
      .update(expenses)
      .set({
        status: "SUBMITTED",
        receiptHash: hash,
        policyFlag: policyResult.policyFlag,
        updatedAt: new Date(),
      })
      .where(and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)));

    this.audit.log({
      action: "expense.submitted",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(expenseId),
      targetType: "expense",
      metadata: { approvalRequired: approvalResult.needsApproval, policyId: approvalResult.policyId },
    });

    if (approvalResult.needsApproval) {
      // No approver column survives on the policy, so the claim goes to whoever
      // actually holds the approval permission — the same set the submitted
      // e-mail already targets.
      void this.notifyApprovers(u, expenseId, expense.amount, expense.category);
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
  ): Promise<{ success: boolean; journalId: string | null }> {
    const expense = await this.db.query.expenses.findFirst({
      where: and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)),
    });

    if (!expense) throw new NotFoundException("Expense not found");

    const approvableStatuses: string[] = ["PENDING", "SUBMITTED"];
    if (!approvableStatuses.includes(expense.status ?? "")) {
      throw new BadRequestException(`Expense in status ${expense.status} cannot be approved`);
    }

    const currency = (expense.currency || "INR").toUpperCase();
    const totalMinor = amountToMinor(expense.amount, currency);

    const journalId = await this.postApprovalAccrual(u, {
      expenseId,
      expenseDate: expense.expenseDate,
      currency,
      totalMinor,
      category: expense.category,
      description: expense.description,
    });

    await this.db
      .update(expenses)
      .set({
        status: "REIMBURSEMENT_PENDING",
        approverId: u.userId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)));

    this.audit.log({
      action: "expense.approved",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(expenseId),
      targetType: "expense",
      metadata: { journalId },
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

    return { success: true, journalId };
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

  /* ------------------------------------------------------------ internals */

  /**
   * The accrual an approved claim creates:
   *
   *   operating expenses        gross   (debit)
   *   employee payable          gross   (credit)
   *
   * Two deliberate differences from the retired posting service, both because
   * the new kernel has no equivalent rather than for convenience:
   *
   * 1. The whole claim, tax included, debits `opex`. The old service split a
   *    `TAX_RECEIVABLE` leg out, but a claim carries no tax code, no supplier
   *    registration and no place of supply, so no input-tax credit can be
   *    substantiated. Recoverable input tax is now determined by the tax engine
   *    on AP documents; `expenses.tax_amount` is still recorded for reporting.
   * 2. `expense_categories.ledger_account_id` is no longer honoured — it is a
   *    legacy integer that cannot address a `gl_accounts` text id, and the
   *    kernel resolves accounts by role, not by an id another module stores.
   *
   * The credit lands on `net_pay_clearing`: the kernel has no
   * `reimbursement_payable` role, and that account is the employee-side
   * liability a disbursement clears, which is exactly what a reimbursement is.
   */
  private async postApprovalAccrual(
    u: CurrentUserContext,
    claim: {
      expenseId: number;
      expenseDate: string;
      currency: string;
      totalMinor: number;
      category: string;
      description: string | null;
    },
  ): Promise<string | null> {
    if (claim.totalMinor <= 0) return null;

    const memo = `Expense approved: ${claim.category} — ${claim.description ?? ""}`.trimEnd();

    try {
      const result = await this.posting.submit(u.orgId, u.userId, {
        // The kernel's `gl_journal_source` enum has no expense-claim member, so
        // these post as `manual` with the expense id as the source id. Adding an
        // `expense_claim` value would be the clean fix, but that is a change to
        // the accounting kernel's schema, not to this module.
        sourceType: "expense_claim",
        sourceId: String(claim.expenseId),
        purpose: "expense_approve",
        journalDate: claim.expenseDate,
        memo,
        lines: [
          {
            accountTag: "opex",
            debitMinor: claim.totalMinor,
            currency: claim.currency,
            description: `Expense: ${claim.category}`,
          },
          {
            accountTag: "net_pay_clearing",
            creditMinor: claim.totalMinor,
            currency: claim.currency,
            description: "Reimbursement payable to employee",
          },
        ],
      });
      return result.journalId;
    } catch (error) {
      if (error instanceof AdapterRejection && error.code === "BOOK_NOT_ENABLED") {
        this.logger.debug(
          `Accounting is not enabled for org ${u.orgId}; expense ${claim.expenseId} was approved without a ledger entry`,
        );
        return null;
      }
      throw error;
    }
  }

  private async notifyApprovers(
    u: CurrentUserContext,
    expenseId: number,
    amount: string,
    category: string,
  ): Promise<void> {
    try {
      const approvers = await this.access.membersWithPermission(u.orgId, "hr:expenses:approve");
      const targetUserIds = approvers.map((m) => m.userId).filter((id) => id !== u.userId);
      if (targetUserIds.length === 0) return;

      await this.dispatch.emit({
        eventKey: "accounting.expense.submitted",
        orgId: u.orgId,
        actorUserId: u.userId,
        targetUserIds,
        entityType: "expense",
        entityId: String(expenseId),
        variables: { amount, category },
      });
    } catch (error) {
      this.logger.warn(
        `Could not notify expense approvers for ${expenseId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
