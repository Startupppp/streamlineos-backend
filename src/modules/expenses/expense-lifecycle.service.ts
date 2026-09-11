import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { expenses, finApprovalRequests } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { emitExpenseOutboxEvent } from "./expense-outbox-emitter";
import {
  EXPENSE_DECIDED_EVENT,
  EXPENSE_SUBMITTED_EVENT,
  expenseDecidedPayloadSchema,
  expenseSubmittedPayloadSchema,
} from "./dto/expense-outbox.schemas";
import { FinancePostingService } from "../accounting/posting/finance-posting.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../common/organization/organization-actor";
import {
  buildReceiptHash,
  checkDuplicate as checkExpenseDuplicate,
  evaluatePolicy as evaluateExpensePolicy,
  findApplicableApprovalPolicy as findExpenseApprovalPolicy,
  type ApprovalCheckResult,
  type ExpensePolicyDeps,
  type PolicyEvalResult,
} from "./lib/expense-policy-rules";
import {
  approveExpense as approveExpenseAndPost,
  type ExpenseApprovalDeps,
} from "./lib/expense-approval";

@Injectable()
export class ExpenseLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly posting: FinancePostingService,
  ) {}

  private get policyDeps(): ExpensePolicyDeps {
    return { db: this.db };
  }

  private get approvalDeps(): ExpenseApprovalDeps {
    return {
      db: this.db,
      cache: this.cache,
      audit: this.audit,
      posting: this.posting,
    };
  }

  computeReceiptHash(
    orgId: string,
    amount: string,
    expenseDate: string,
    merchant: string | null | undefined,
  ): string {
    return buildReceiptHash(orgId, amount, expenseDate, merchant);
  }

  /** @see checkDuplicate — same receipt hash already recorded for this org. */
  async checkDuplicate(
    orgId: string,
    hash: string,
    excludeExpenseId?: number,
  ): Promise<number | null> {
    return checkExpenseDuplicate(this.policyDeps, orgId, hash, excludeExpenseId);
  }

  /** @see evaluatePolicy — spend-policy verdict for one expense. */
  async evaluatePolicy(
    orgId: string,
    categoryId: number | null | undefined,
    amount: number,
    hasReceipt: boolean,
  ): Promise<PolicyEvalResult> {
    return evaluateExpensePolicy(this.policyDeps, orgId, categoryId, amount, hasReceipt);
  }

  /** @see findApplicableApprovalPolicy — who, if anyone, must approve. */
  async findApplicableApprovalPolicy(
    orgId: string,
    amount: number,
  ): Promise<ApprovalCheckResult> {
    return findExpenseApprovalPolicy(this.policyDeps, orgId, amount);
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
      const [updated] = await tx
        .update(expenses)
        .set({
          status: "SUBMITTED",
          receiptHash: hash,
          policyFlag: policyResult.policyFlag,
          updatedAt: new Date(),
        })
        .where(and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)))
        .returning({ id: expenses.id });

      if (!updated) {
        throw new InternalServerErrorException("Expense was concurrently modified.");
      }

      if (approvalResult.needsApproval) {
        await tx.insert(finApprovalRequests).values({
          orgId: u.orgId,
          recordType: "EXPENSE",
          recordId: expenseId,
          status: "PENDING",
          requestedBy: u.userId,
        });
      }

      if (!approvalResult.approverUserId) return;

      await emitExpenseOutboxEvent(tx, {
        orgId: u.orgId,
        expenseId,
        eventType: EXPENSE_SUBMITTED_EVENT,
        payload: expenseSubmittedPayloadSchema.parse({
          expenseId,
          orgId: u.orgId,
          actorUserId: u.userId,
          amount: expense.amount,
          category: expense.category,
          description: expense.description ?? null,
          recipients: { mode: "EXPLICIT", userIds: [approvalResult.approverUserId] },
          runAutomations: false,
        }),
      });
    });

    this.audit.log({
      action: "expense.submitted",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(expenseId),
      targetType: "expense",
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.expensesListNamespace(u.orgId));

    return {
      success: true,
      approvalRequired: approvalResult.needsApproval,
      policyFlag: policyResult.policyFlag,
      duplicateOf,
    };
  }

  /** @see approveExpense — posts the journal, then moves the status. */
  async approveExpense(
    u: CurrentUserContext,
    expenseId: number,
  ): Promise<{ success: boolean; entryId: number | null }> {
    return approveExpenseAndPost(this.approvalDeps, u, expenseId);
  }

  async rejectExpense(
    u: CurrentUserContext,
    expenseId: number,
    rejectionReason: string,
  ): Promise<{ success: boolean }> {
    const rejectActor = await assertOrganizationActor(this.db, u.orgId, { kind: "user", userId: u.userId }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    });

    const expense = await this.db.query.expenses.findFirst({
      where: and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)),
      columns: { id: true, status: true, userId: true, amount: true, category: true },
    });

    if (!expense) throw new NotFoundException("Expense not found");

    const rejectableStatuses: string[] = ["PENDING", "SUBMITTED"];
    if (!rejectableStatuses.includes(expense.status ?? "")) {
      throw new BadRequestException(`Expense in status ${expense.status} cannot be rejected`);
    }

    await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(expenses)
        .set({
          status: "REJECTED",
          rejectionReason,
          approverId: u.userId,
          approverMembershipId: rejectActor.membershipId,
          updatedAt: new Date(),
        })
        .where(and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)))
        .returning({ id: expenses.id });

      if (!updated) {
        throw new InternalServerErrorException("Expense was concurrently modified.");
      }

      await tx
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

      await emitExpenseOutboxEvent(tx, {
        orgId: u.orgId,
        expenseId,
        eventType: EXPENSE_DECIDED_EVENT,
        payload: expenseDecidedPayloadSchema.parse({
          expenseId,
          orgId: u.orgId,
          actorUserId: u.userId,
          recipientUserId: expense.userId,
          status: "REJECTED",
          amount: expense.amount,
          category: expense.category,
          rejectionReason,
          journalEntryId: null,
        }),
      });
    });

    this.audit.log({
      action: "expense.rejected",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(expenseId),
      targetType: "expense",
      metadata: { rejectionReason },
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.expensesListNamespace(u.orgId));

    return { success: true };
  }
}
