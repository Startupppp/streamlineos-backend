/**
 * Approving an expense — the only transition in this module that reaches the
 * general ledger.
 *
 * Submit and reject move a status and tell somebody. This one posts an accrual
 * through `PostingCommandService` — the accounting module's anti-corruption
 * layer — BEFORE it writes the status, so an expense can never sit in
 * REIMBURSEMENT_PENDING with no journal behind it. That ordering, and the GL
 * vocabulary it needs (system tags, integer minor units), is what earns it its
 * own file.
 *
 * Nothing here names a GL account: lines carry a `GlSystemTag` and accounting
 * resolves them against the organisation's own chart, so a tenant renumbering
 * their accounts cannot break expense approval. Accounting is opt-in and HR
 * self-service is not: an organisation that never enabled accounting still
 * approves expenses — the posting is skipped, not failed (the same contract
 * `payroll-posting.service.ts` keeps). A retried approval is safe on the ledger
 * side too: `PostingCommandService` keys a journal on
 * `{sourceType}:{sourceId}:{purpose}` and returns the original on a replay.
 */
import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { expenses } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import { emitExpenseOutboxEvent } from "../expense-outbox-emitter";
import {
  EXPENSE_DECIDED_EVENT,
  expenseDecidedPayloadSchema,
} from "../dto/expense-outbox.schemas";
import { PostingCommandService } from "../../accounting/adapters/posting-command.service";
import { AdapterRejection } from "../../accounting/adapters/posting-command.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import { amountToMinor } from "./expense-policy-rules";

const logger = new Logger("ExpenseApproval");

export interface ExpenseApprovalDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly audit: AuditService;
  readonly posting: PostingCommandService;
}

export async function approveExpense(
  deps: ExpenseApprovalDeps,
  u: CurrentUserContext,
  expenseId: number,
): Promise<{ success: boolean; journalId: string | null }> {
  const approverActor = await assertOrganizationActor(deps.db, u.orgId, { kind: "user", userId: u.userId }).catch((e: unknown) => {
    if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
    throw e;
  });

  const expense = await deps.db.query.expenses.findFirst({
    where: and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)),
  });

  if (!expense) throw new NotFoundException("Expense not found");

  // Separation of duties, and the one rung the route's permission cannot supply:
  // `hr:expenses:approve` says this person may approve expenses, never that they
  // may approve their own. `ExpensesWriteService.updateStatus` refuses the same
  // thing on the status-change path; both doors have to, or the rule is a
  // suggestion.
  if (expense.userId === u.userId) {
    throw new ForbiddenException("You cannot approve your own expense");
  }

  const approvableStatuses: string[] = ["PENDING", "SUBMITTED"];
  if (!approvableStatuses.includes(expense.status ?? "")) {
    throw new BadRequestException(`Expense in status ${expense.status} cannot be approved`);
  }

  // The retired `fin_approval_requests` row, and the owner-only override that
  // granted over it, went with the pre-rewrite accounting schema. The pending
  // state is the expense's own SUBMITTED status now, and approving it is gated
  // by `hr:expenses:approve` on the route.
  const currency = (expense.currency || "INR").toUpperCase();
  const journalId = await postApprovalAccrual(deps, u, {
    expenseId,
    expenseDate: expense.expenseDate,
    currency,
    totalMinor: amountToMinor(expense.amount, currency),
    category: expense.category,
    description: expense.description,
  });

  await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(expenses)
      .set({
        status: "REIMBURSEMENT_PENDING",
        approverId: u.userId,
        approverMembershipId: approverActor.membershipId,
        approvedAt: new Date(),
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
        // `journalEntryId` is the retired integer `journal_entries` id; a
        // kernel journal id is text and does not fit it. The journal is recorded
        // on the audit row below.
        journalEntryId: null,
      }),
    });
  });

  deps.audit.log({
    action: "expense.approved",
    userId: u.userId,
    orgId: u.orgId,
    targetId: String(expenseId),
    targetType: "expense",
    metadata: { journalId },
  });

  await deps.cache.invalidateNamespace(CACHE_KEYS.expensesListNamespace(u.orgId));

  return { success: true, journalId };
}

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
async function postApprovalAccrual(
  deps: ExpenseApprovalDeps,
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
    const result = await deps.posting.submit(u.orgId, u.userId, {
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
      logger.debug(
        `Accounting is not enabled for org ${u.orgId}; expense ${claim.expenseId} was approved without a ledger entry`,
      );
      return null;
    }
    throw error;
  }
}
