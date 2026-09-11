/**
 * Creating a manual journal entry.
 *
 * Bringing an entry into existence is a different job from moving one that
 * already exists. This is the only path in the ledger that checks the entry
 * BALANCES before anything is written, and the only one that routes a new entry
 * through the manual-journal approval policy — an entry over the policy
 * threshold is persisted as DRAFT, flipped to PENDING_APPROVAL and given an
 * approval request inside the same transaction, so an entry can never exist in
 * PENDING_APPROVAL with no request behind it. Post and reverse next door start
 * from a row that is already balanced and already approved.
 *
 * MONEY: the balance check compares `Math.round(total * 100)` on both sides
 * rather than the floats, and the policy threshold is compared with
 * `compareDecimals` over a string accumulated with `addDecimals(..., toFixed(4))`
 * — four places, not two, because a line may carry sub-paise precision before it
 * is summed. Every one of those moved character for character from
 * accounting-ledger.service.ts; none of it was tidied.
 */
import { BadRequestException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  journalEntries,
  finApprovalPolicies,
  finApprovalRequests,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { JournalPostingService } from "../../posting/journal-posting.service";
import { FinancePostingService } from "../../posting/finance-posting.service";
import { addDecimals, compareDecimals } from "../money.util";
import { type CreateJournalEntryInput } from "../dto/accounting.schemas";

export interface JournalCreateDeps {
  readonly db: Db;
  readonly posting: JournalPostingService;
  readonly finPosting: FinancePostingService;
  readonly audit: AuditService;
  readonly dispatch: NotificationDispatchService;
}

export async function createJournalEntry(
  deps: JournalCreateDeps,
  orgId: string,
  userId: string,
  membershipId: number,
  input: CreateJournalEntryInput,
) {
  const totalDebit = input.lines.reduce((acc, line) => acc + line.debit, 0);
  const totalCredit = input.lines.reduce((acc, line) => acc + line.credit, 0);
  if (Math.round(totalDebit * 100) !== Math.round(totalCredit * 100)) {
    throw new BadRequestException(
      `Unbalanced entry: debit ${totalDebit.toFixed(2)} != credit ${totalCredit.toFixed(2)}`,
    );
  }
  for (const line of input.lines) {
    if ((line.debit > 0 && line.credit > 0) || (line.debit === 0 && line.credit === 0)) {
      throw new BadRequestException("Each line must have exactly one of debit or credit > 0");
    }
  }

  await deps.finPosting.assertPeriodOpen(orgId, input.entryDate);
  await deps.posting.seedChartOfAccountsForOrg(orgId);

  const entryTotalStr = input.lines.reduce((acc, l) => addDecimals(acc, l.debit.toFixed(4)), "0");

  const allPolicies = await deps.db
    .select({
      id: finApprovalPolicies.id,
      approverUserId: finApprovalPolicies.approverUserId,
      minAmount: finApprovalPolicies.minAmount,
    })
    .from(finApprovalPolicies)
    .where(
      and(
        eq(finApprovalPolicies.orgId, orgId),
        eq(finApprovalPolicies.recordType, "MANUAL_JOURNAL"),
        eq(finApprovalPolicies.isActive, true),
      ),
    );

  const applicablePolicy = allPolicies.find((p) => {
    if (p.minAmount === null) return true;
    return compareDecimals(entryTotalStr, p.minAmount) >= 0;
  });

  const needsApproval = applicablePolicy !== undefined;
  const result = await deps.db.transaction(async (tx) => {
    const persisted = await deps.posting.persistJournalEntry(
      {
        orgId,
        entryDate: input.entryDate,
        description: input.description,
        sourceType: "manual",
        sourceId: null,
        sourceEvent: null,
        status: needsApproval ? "DRAFT" : input.status,
        createdBy: userId,
        createdByMembershipId: membershipId,
        lines: input.lines.map((line) => ({
          accountCode: line.accountCode,
          debit: line.debit,
          credit: line.credit,
          description: line.description ?? null,
        })),
      },
      tx,
    );

    if (needsApproval && applicablePolicy) {
      await tx
        .update(journalEntries)
        .set({ status: "PENDING_APPROVAL" })
        .where(eq(journalEntries.id, persisted.id));

      await tx.insert(finApprovalRequests).values({
        orgId,
        recordType: "MANUAL_JOURNAL",
        recordId: persisted.id,
        status: "PENDING",
        requestedBy: userId,
      });

      if (applicablePolicy.approverUserId) {
        await deps.dispatch.emit({
          eventKey: "accounting.approval.requested",
          orgId,
          actorUserId: userId,
          targetUserIds: [applicablePolicy.approverUserId],
          entityType: "journal_entry",
          entityId: String(persisted.id),
          variables: { entryNumber: persisted.entryNumber, amount: entryTotalStr, description: input.description },
        });
      }
    }

    return persisted;
  });

  deps.audit.log({
    action: "accounting.journal.create",
    userId,
    orgId,
    resourceType: "journal_entry",
    resourceId: String(result.id),
    metadata: { entryNumber: result.entryNumber, needsApproval },
    result: "SUCCESS",
  });

  return result;
}
