/**
 * Approving an expense — the only transition in this module that reaches the
 * general ledger.
 *
 * Submit and reject move a status and tell somebody. This one builds a balanced
 * journal and posts it through `FinancePostingService` BEFORE it writes the
 * status, so an expense can never sit in REIMBURSEMENT_PENDING with no entry
 * behind it. That ordering, and the GL vocabulary it needs (system purposes,
 * `PostJournalLine`), is what earns it its own file.
 *
 * The money here is the expenses family's `decimal(x,2)` MAJOR-unit convention,
 * NOT the GL kernel's integer `*_minor` units. Every `toFixed(2)` below and the
 * `amount - taxAmount` split moved from the service character for character;
 * they are the shape `postJournal` expects from this caller.
 */
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { expenses, finApprovalRequests, expenseCategories } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import { emitExpenseOutboxEvent } from "../expense-outbox-emitter";
import {
  EXPENSE_DECIDED_EVENT,
  expenseDecidedPayloadSchema,
} from "../dto/expense-outbox.schemas";
import { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import type { PostJournalLine } from "../../accounting/core/finance-posting.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { holdsOwnerOnly } from "../../../common/rbac/owner-only-operations";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";

export interface ExpenseApprovalDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly audit: AuditService;
  readonly posting: FinancePostingService;
}

export async function approveExpense(
  deps: ExpenseApprovalDeps,
  u: CurrentUserContext,
  expenseId: number,
): Promise<{ success: boolean; entryId: number | null }> {
  const approverActor = await assertOrganizationActor(deps.db, u.orgId, { kind: "user", userId: u.userId }).catch((e: unknown) => {
    if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
    throw e;
  });

  const expense = await deps.db.query.expenses.findFirst({
    where: and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)),
  });

  if (!expense) throw new NotFoundException("Expense not found");

  const approvableStatuses: string[] = ["PENDING", "SUBMITTED"];
  if (!approvableStatuses.includes(expense.status ?? "")) {
    throw new BadRequestException(`Expense in status ${expense.status} cannot be approved`);
  }

  const openApprovalRequest = await deps.db.query.finApprovalRequests.findFirst({
    where: and(
      eq(finApprovalRequests.orgId, u.orgId),
      eq(finApprovalRequests.recordType, "EXPENSE"),
      eq(finApprovalRequests.recordId, expenseId),
      eq(finApprovalRequests.status, "PENDING"),
    ),
  });

  if (openApprovalRequest) {
    if (!holdsOwnerOnly(u, "finance.expense.grant-without-approval")) {
      throw new BadRequestException("This expense requires a pending approval to be granted first");
    }
    await deps.db
      .update(finApprovalRequests)
      .set({ status: "APPROVED", decidedBy: u.userId, decidedAt: new Date() })
      .where(eq(finApprovalRequests.id, openApprovalRequest.id));
  }

  const categoryWithLedger = expense.categoryId
    ? await deps.db.query.expenseCategories.findFirst({
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

  const postResult = await deps.posting.postJournal(u, {
    entryDate: expense.expenseDate,
    description: `Expense approved: ${expense.category} — ${expense.description ?? ""}`.trimEnd(),
    sourceType: "EXPENSE",
    sourceId: String(expenseId),
    sourceEvent: "approved",
    lines,
  });

  await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(expenses)
      .set({
        status: "REIMBURSEMENT_PENDING",
        approverId: u.userId,
        approverMembershipId: approverActor.membershipId,
        approvedAt: new Date(),
        postedJournalEntryId: postResult.entryId,
        updatedAt: new Date(),
      })
      .where(and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)))
      .returning({ id: expenses.id });

    if (!updated) {
      throw new InternalServerErrorException("Expense was concurrently modified.");
    }

    await emitExpenseOutboxEvent(tx, {
      orgId: u.orgId,
      expenseId,
      eventType: EXPENSE_DECIDED_EVENT,
      payload: expenseDecidedPayloadSchema.parse({
        expenseId,
        orgId: u.orgId,
        actorUserId: u.userId,
        recipientUserId: expense.userId,
        status: "APPROVED",
        amount: expense.amount,
        category: expense.category,
        rejectionReason: null,
        journalEntryId: postResult.entryId,
      }),
    });
  });

  deps.audit.log({
    action: "expense.approved",
    userId: u.userId,
    orgId: u.orgId,
    targetId: String(expenseId),
    targetType: "expense",
    metadata: { journalEntryId: postResult.entryId },
  });

  await deps.cache.invalidateNamespace(CACHE_KEYS.expensesListNamespace(u.orgId));

  return { success: true, entryId: postResult.entryId };
}
