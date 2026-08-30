import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  finBankAccounts,
  finBankTransactions,
  finReconciliationMatches,
  journalEntries,
  journalLines,
} from "../../../db/schema";
import {
  checkApprovalPolicy,
  getApprovalRequest,
  insertApprovalRequest,
} from "../ap/ap-approval.helper";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  ConfirmMatchInput,
  UnmatchInput,
  IgnoreTransactionInput,
} from "./dto/reconciliation.schemas";

const CACHE_RECON = (orgId: string, bankAccountId: number) =>
  `fin:banking:recon:${orgId}:${bankAccountId}`;

@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: FinancePostingService,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
    private readonly audit: AuditService,
  ) {}

  async confirmMatch(
    u: CurrentUserContext,
    bankAccountId: number,
    input: ConfirmMatchInput,
  ) {
    const { orgId, userId } = u;

    const txn = await this.db.query.finBankTransactions.findFirst({
      where: and(
        eq(finBankTransactions.id, input.transactionId),
        eq(finBankTransactions.orgId, orgId),
        eq(finBankTransactions.bankAccountId, bankAccountId),
      ),
    });
    if (!txn) throw new NotFoundException("Bank transaction not found");

    if (txn.status === "RECONCILED")
      throw new BadRequestException("Transaction is already reconciled");
    if (txn.status === "IGNORED")
      throw new BadRequestException("Transaction is ignored — unmatch first");

    if (
      input.matchType === "BANK_FEE" ||
      input.matchType === "MANUAL_JOURNAL"
    ) {
      const txnAmount = Math.abs(parseFloat(txn.amount));
      const approval = await checkApprovalPolicy(
        this.db,
        orgId,
        "BANK_ADJUSTMENT",
        txnAmount,
      );

      if (approval.needsApproval) {
        const existing = await getApprovalRequest(
          this.db,
          orgId,
          "BANK_ADJUSTMENT",
          txn.id,
        );

        if (existing?.status === "PENDING")
          throw new BadRequestException(
            "Bank adjustment awaiting approval — cannot reconcile yet",
          );
        else if (existing?.status !== "APPROVED") {
          await insertApprovalRequest(
            this.db,
            orgId,
            "BANK_ADJUSTMENT",
            txn.id,
            userId,
          );
          throw new BadRequestException(
            "Bank adjustment requires approval — approval request created",
          );
        }
      }
    }

    await this.db.transaction(async (tx) => {
      let journalEntryId: number | null = null;

      if (input.matchType === "BANK_FEE") {
        const account = await tx.query.finBankAccounts.findFirst({
          where: and(
            eq(finBankAccounts.id, bankAccountId),
            eq(finBankAccounts.orgId, orgId),
          ),
          columns: { ledgerAccountId: true, name: true },
        });
        if (!account?.ledgerAccountId)
          throw new BadRequestException(
            "Bank account has no linked ledger account",
          );

        const postResult = await this.posting.postJournal(u, {
          entryDate: txn.txnDate,
          description:
            input.memo ?? `Bank fee: ${txn.description ?? txn.reference ?? ""}`,
          sourceType: "BANK_TXN",
          sourceId: String(txn.id),
          sourceEvent: "bank_fee",
          lines: [
            {
              systemPurpose: "PAYMENT_FEES",
              debit: String(Math.abs(parseFloat(txn.amount))),
              credit: "0",
            },
            {
              accountId: account.ledgerAccountId,
              debit: "0",
              credit: String(Math.abs(parseFloat(txn.amount))),
            },
          ],
        });
        journalEntryId = postResult.entryId;
      } else if (input.matchType === "MANUAL_JOURNAL") {
        const account = await tx.query.finBankAccounts.findFirst({
          where: and(
            eq(finBankAccounts.id, bankAccountId),
            eq(finBankAccounts.orgId, orgId),
          ),
          columns: { ledgerAccountId: true },
        });
        if (!account?.ledgerAccountId)
          throw new BadRequestException(
            "Bank account has no linked ledger account",
          );
        if (!input.counterAccountId)
          throw new BadRequestException(
            "counterAccountId is required for MANUAL_JOURNAL match",
          );

        const amount = String(Math.abs(parseFloat(txn.amount)));
        const isDebit = parseFloat(txn.amount) > 0;

        const postResult = await this.posting.postJournal(u, {
          entryDate: txn.txnDate,
          description:
            input.memo ?? txn.description ?? `Manual journal for txn ${txn.id}`,
          sourceType: "BANK_TXN",
          sourceId: String(txn.id),
          sourceEvent: "manual_journal",
          lines: isDebit
            ? [
                { accountId: account.ledgerAccountId, debit: amount, credit: "0" },
                { accountId: input.counterAccountId, debit: "0", credit: amount },
              ]
            : [
                { accountId: input.counterAccountId, debit: amount, credit: "0" },
                { accountId: account.ledgerAccountId, debit: "0", credit: amount },
              ],
        });
        journalEntryId = postResult.entryId;
      } else if (input.matchedRecordId) {
        const existingMatches = await tx
          .select({ journalEntryId: finReconciliationMatches.journalEntryId })
          .from(finReconciliationMatches)
          .where(
            and(
              eq(finReconciliationMatches.orgId, orgId),
              eq(finReconciliationMatches.bankTransactionId, txn.id),
              eq(finReconciliationMatches.matchedType, input.matchType),
            ),
          )
          .limit(1);
        journalEntryId = existingMatches[0]?.journalEntryId ?? null;
      }

      await tx
        .delete(finReconciliationMatches)
        .where(
          and(
            eq(finReconciliationMatches.orgId, orgId),
            eq(finReconciliationMatches.bankTransactionId, txn.id),
          ),
        );

      await tx.insert(finReconciliationMatches).values({
        orgId,
        bankTransactionId: txn.id,
        journalEntryId,
        matchedType: input.matchType,
        matchedRecordId: input.matchedRecordId ?? null,
        amount: txn.amount,
        confidence: "100.00",
        isConfirmed: true,
        confirmedBy: userId,
        confirmedAt: new Date(),
      });

      await tx
        .update(finBankTransactions)
        .set({ status: "RECONCILED", matchedJournalEntryId: journalEntryId })
        .where(
          and(
            eq(finBankTransactions.id, txn.id),
            eq(finBankTransactions.orgId, orgId),
          ),
        );
    });

    await this.cache.invalidate(CACHE_RECON(orgId, bankAccountId));

    const refreshedAccount = await this.db.query.finBankAccounts.findFirst({
      where: and(
        eq(finBankAccounts.id, bankAccountId),
        eq(finBankAccounts.orgId, orgId),
      ),
      columns: { ledgerAccountId: true, currentBalance: true },
    });

    const ledgerBalance = await this.computeLedgerBalance(
      orgId,
      refreshedAccount?.ledgerAccountId ?? null,
    );

    if (
      ledgerBalance !== null &&
      refreshedAccount &&
      Math.abs(
        parseFloat(ledgerBalance) - parseFloat(refreshedAccount.currentBalance),
      ) > 0.01
    ) {
      await this.dispatch.emit({
        eventKey: "accounting.reconciliation.mismatch",
        orgId,
        actorUserId: userId,
        targetUserIds: [userId],
        entityType: "bank_account",
        entityId: String(bankAccountId),
        variables: {
          ledgerBalance,
          bankBalance: refreshedAccount.currentBalance,
        },
      });
    }

    this.audit.log({
      action: "banking.reconciliation.match",
      userId,
      orgId,
      resourceType: "bank_transaction",
      resourceId: String(input.transactionId),
      metadata: { matchType: input.matchType, matchedRecordId: input.matchedRecordId },
      result: "SUCCESS",
    });

    return { success: true };
  }

  async unmatch(
    u: CurrentUserContext,
    bankAccountId: number,
    input: UnmatchInput,
  ) {
    const { orgId, userId } = u;

    const txn = await this.db.query.finBankTransactions.findFirst({
      where: and(
        eq(finBankTransactions.id, input.transactionId),
        eq(finBankTransactions.orgId, orgId),
        eq(finBankTransactions.bankAccountId, bankAccountId),
      ),
    });
    if (!txn) throw new NotFoundException("Bank transaction not found");

    const matches = await this.db
      .select()
      .from(finReconciliationMatches)
      .where(
        and(
          eq(finReconciliationMatches.orgId, orgId),
          eq(finReconciliationMatches.bankTransactionId, txn.id),
          eq(finReconciliationMatches.isConfirmed, true),
        ),
      );

    await this.db.transaction(async (tx) => {
      for (const match of matches) {
        if (
          match.journalEntryId &&
          (match.matchedType === "BANK_FEE" ||
            match.matchedType === "MANUAL_JOURNAL")
        ) {
          await this.posting.reverseJournal(
            u,
            match.journalEntryId,
            "Unmatched from bank reconciliation",
          );
        }
      }

      await tx
        .delete(finReconciliationMatches)
        .where(
          and(
            eq(finReconciliationMatches.orgId, orgId),
            eq(finReconciliationMatches.bankTransactionId, txn.id),
          ),
        );

      await tx
        .update(finBankTransactions)
        .set({ status: "UNMATCHED", matchedJournalEntryId: null })
        .where(
          and(
            eq(finBankTransactions.id, txn.id),
            eq(finBankTransactions.orgId, orgId),
          ),
        );
    });

    await this.cache.invalidate(CACHE_RECON(orgId, bankAccountId));

    this.audit.log({
      action: "banking.reconciliation.unmatch",
      userId,
      orgId,
      resourceType: "bank_transaction",
      resourceId: String(input.transactionId),
      result: "SUCCESS",
    });

    return { success: true };
  }

  async ignoreTransaction(
    u: CurrentUserContext,
    bankAccountId: number,
    input: IgnoreTransactionInput,
  ) {
    const { orgId, userId } = u;

    const txn = await this.db.query.finBankTransactions.findFirst({
      where: and(
        eq(finBankTransactions.id, input.transactionId),
        eq(finBankTransactions.orgId, orgId),
        eq(finBankTransactions.bankAccountId, bankAccountId),
      ),
    });
    if (!txn) throw new NotFoundException("Bank transaction not found");

    if (txn.status === "RECONCILED")
      throw new BadRequestException("Cannot ignore a reconciled transaction");

    await this.db
      .update(finBankTransactions)
      .set({ status: "IGNORED" })
      .where(
        and(
          eq(finBankTransactions.id, txn.id),
          eq(finBankTransactions.orgId, orgId),
        ),
      );

    this.audit.log({
      action: "banking.reconciliation.ignore",
      userId,
      orgId,
      resourceType: "bank_transaction",
      resourceId: String(input.transactionId),
      result: "SUCCESS",
    });

    return { success: true };
  }

  private async computeLedgerBalance(
    orgId: string,
    ledgerAccountId: number | null | undefined,
  ): Promise<string | null> {
    if (!ledgerAccountId) return null;

    const [result] = await this.db
      .select({
        balance: sql<string>`COALESCE(SUM(CAST(${journalLines.debit} AS numeric)) - SUM(CAST(${journalLines.credit} AS numeric)), 0)`,
      })
      .from(journalLines)
      .innerJoin(
        journalEntries,
        and(
          eq(journalEntries.id, journalLines.entryId),
          eq(journalEntries.status, "POSTED"),
        ),
      )
      .where(
        and(
          eq(journalLines.accountId, ledgerAccountId),
          eq(journalEntries.orgId, orgId),
        ),
      );

    return result?.balance ?? "0";
  }

}
