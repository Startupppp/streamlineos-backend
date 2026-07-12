import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  finBankAccounts,
  finBankTransactions,
  finReconciliationMatches,
  finReconciliationRules,
  journalEntries,
  journalLines,
} from "../../db/schema";
import {
  checkApprovalPolicy,
  getApprovalRequest,
  insertApprovalRequest,
} from "../finance-ap/ap-approval.helper";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { FinancePostingService } from "../accounting/finance-posting.service";
import { paginateOffset, buildListResponse } from "../../common/pagination/pagination";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type {
  ConfirmMatchInput,
  UnmatchInput,
  IgnoreTransactionInput,
  CreateReconciliationRuleInput,
} from "./dto/reconciliation.schemas";

const CACHE_RECON = (orgId: string, bankAccountId: number) => `fin:banking:recon:${orgId}:${bankAccountId}`;

interface RulesQuery {
  page: number;
  pageSize: number;
  bankAccountId?: number;
}

@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: FinancePostingService,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
    private readonly audit: AuditService,
  ) {}

  async getWorkspace(u: CurrentUserContext, bankAccountId: number) {
    const { orgId } = u;

    const account = await this.db.query.finBankAccounts.findFirst({
      where: and(eq(finBankAccounts.id, bankAccountId), eq(finBankAccounts.orgId, orgId)),
    });
    if (!account) throw new NotFoundException("Bank account not found");

    const [unmatched, suggested, reconciledCount] = await Promise.all([
      this.db
        .select()
        .from(finBankTransactions)
        .where(and(
          eq(finBankTransactions.orgId, orgId),
          eq(finBankTransactions.bankAccountId, bankAccountId),
          eq(finBankTransactions.status, "UNMATCHED"),
        ))
        .orderBy(desc(finBankTransactions.txnDate)),
      this.db
        .select()
        .from(finBankTransactions)
        .where(and(
          eq(finBankTransactions.orgId, orgId),
          eq(finBankTransactions.bankAccountId, bankAccountId),
          eq(finBankTransactions.status, "SUGGESTED"),
        ))
        .orderBy(desc(finBankTransactions.txnDate)),
      this.db
        .select({ total: count() })
        .from(finBankTransactions)
        .where(and(
          eq(finBankTransactions.orgId, orgId),
          eq(finBankTransactions.bankAccountId, bankAccountId),
          eq(finBankTransactions.status, "RECONCILED"),
        )),
    ]);

    const suggestedWithMatches = await Promise.all(
      suggested.map(async (txn) => {
        const matches = await this.db
          .select()
          .from(finReconciliationMatches)
          .where(and(
            eq(finReconciliationMatches.orgId, orgId),
            eq(finReconciliationMatches.bankTransactionId, txn.id),
          ));
        return { ...txn, suggestedMatches: matches };
      }),
    );

    const ledgerBalance = await this.computeLedgerBalance(orgId, account.ledgerAccountId);

    return {
      unmatched,
      suggested: suggestedWithMatches,
      reconciledCount: reconciledCount[0]?.total ?? 0,
      ledgerBalance,
      bankBalance: account.currentBalance,
    };
  }

  async confirmMatch(u: CurrentUserContext, bankAccountId: number, input: ConfirmMatchInput) {
    const { orgId, userId } = u;

    const txn = await this.db.query.finBankTransactions.findFirst({
      where: and(
        eq(finBankTransactions.id, input.transactionId),
        eq(finBankTransactions.orgId, orgId),
        eq(finBankTransactions.bankAccountId, bankAccountId),
      ),
    });
    if (!txn) throw new NotFoundException("Bank transaction not found");

    if (txn.status === "RECONCILED") {
      throw new BadRequestException("Transaction is already reconciled");
    }
    if (txn.status === "IGNORED") {
      throw new BadRequestException("Transaction is ignored — unmatch first");
    }

    if (input.matchType === "BANK_FEE" || input.matchType === "MANUAL_JOURNAL") {
      const txnAmount = Math.abs(parseFloat(txn.amount));
      const approval = await checkApprovalPolicy(this.db, orgId, "BANK_ADJUSTMENT", txnAmount);

      if (approval.needsApproval) {
        const existing = await getApprovalRequest(this.db, orgId, "BANK_ADJUSTMENT", txn.id);

        if (existing?.status === "APPROVED") {
        } else if (existing?.status === "PENDING") {
          throw new BadRequestException("Bank adjustment awaiting approval — cannot reconcile yet");
        } else {
          await insertApprovalRequest(this.db, orgId, "BANK_ADJUSTMENT", txn.id, userId);
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
          where: and(eq(finBankAccounts.id, bankAccountId), eq(finBankAccounts.orgId, orgId)),
          columns: { ledgerAccountId: true, name: true },
        });
        if (!account?.ledgerAccountId) {
          throw new BadRequestException("Bank account has no linked ledger account");
        }

        const today = txn.txnDate;
        const postResult = await this.posting.postJournal(u, {
          entryDate: today,
          description: input.memo ?? `Bank fee: ${txn.description ?? txn.reference ?? ""}`,
          sourceType: "BANK_TXN",
          sourceId: String(txn.id),
          sourceEvent: "bank_fee",
          lines: [
            { systemPurpose: "PAYMENT_FEES", debit: String(Math.abs(parseFloat(txn.amount))), credit: "0" },
            { accountId: account.ledgerAccountId, debit: "0", credit: String(Math.abs(parseFloat(txn.amount))) },
          ],
        });
        journalEntryId = postResult.entryId;

      } else if (input.matchType === "MANUAL_JOURNAL") {
        const account = await tx.query.finBankAccounts.findFirst({
          where: and(eq(finBankAccounts.id, bankAccountId), eq(finBankAccounts.orgId, orgId)),
          columns: { ledgerAccountId: true },
        });
        if (!account?.ledgerAccountId) {
          throw new BadRequestException("Bank account has no linked ledger account");
        }
        if (!input.counterAccountId) {
          throw new BadRequestException("counterAccountId is required for MANUAL_JOURNAL match");
        }

        const amount = String(Math.abs(parseFloat(txn.amount)));
        const isDebit = parseFloat(txn.amount) > 0;

        const postResult = await this.posting.postJournal(u, {
          entryDate: txn.txnDate,
          description: input.memo ?? txn.description ?? `Manual journal for txn ${txn.id}`,
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
          .where(and(
            eq(finReconciliationMatches.orgId, orgId),
            eq(finReconciliationMatches.bankTransactionId, txn.id),
            eq(finReconciliationMatches.matchedType, input.matchType),
          ))
          .limit(1);
        journalEntryId = existingMatches[0]?.journalEntryId ?? null;
      }

      await tx
        .delete(finReconciliationMatches)
        .where(and(
          eq(finReconciliationMatches.orgId, orgId),
          eq(finReconciliationMatches.bankTransactionId, txn.id),
        ));

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
        .where(and(eq(finBankTransactions.id, txn.id), eq(finBankTransactions.orgId, orgId)));
    });

    await this.cache.invalidate(CACHE_RECON(orgId, bankAccountId));

    const refreshedAccount = await this.db.query.finBankAccounts.findFirst({
      where: and(eq(finBankAccounts.id, bankAccountId), eq(finBankAccounts.orgId, orgId)),
      columns: { ledgerAccountId: true, currentBalance: true },
    });

    const ledgerBalance = await this.computeLedgerBalance(orgId, refreshedAccount?.ledgerAccountId ?? null);

    if (ledgerBalance !== null && refreshedAccount && Math.abs(parseFloat(ledgerBalance) - parseFloat(refreshedAccount.currentBalance)) > 0.01) {
      void this.dispatch.emit({
        eventKey: "accounting.reconciliation.mismatch",
        orgId,
        actorUserId: userId,
        targetUserIds: [userId],
        entityType: "bank_account",
        entityId: String(bankAccountId),
        variables: { ledgerBalance, bankBalance: refreshedAccount.currentBalance },
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

  async unmatch(u: CurrentUserContext, bankAccountId: number, input: UnmatchInput) {
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
      .where(and(
        eq(finReconciliationMatches.orgId, orgId),
        eq(finReconciliationMatches.bankTransactionId, txn.id),
        eq(finReconciliationMatches.isConfirmed, true),
      ));

    await this.db.transaction(async (tx) => {
      for (const match of matches) {
        if (match.journalEntryId && (match.matchedType === "BANK_FEE" || match.matchedType === "MANUAL_JOURNAL")) {
          await this.posting.reverseJournal(u, match.journalEntryId, "Unmatched from bank reconciliation");
        }
      }

      await tx
        .delete(finReconciliationMatches)
        .where(and(
          eq(finReconciliationMatches.orgId, orgId),
          eq(finReconciliationMatches.bankTransactionId, txn.id),
        ));

      await tx
        .update(finBankTransactions)
        .set({ status: "UNMATCHED", matchedJournalEntryId: null })
        .where(and(eq(finBankTransactions.id, txn.id), eq(finBankTransactions.orgId, orgId)));
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

  async ignoreTransaction(u: CurrentUserContext, bankAccountId: number, input: IgnoreTransactionInput) {
    const { orgId, userId } = u;

    const txn = await this.db.query.finBankTransactions.findFirst({
      where: and(
        eq(finBankTransactions.id, input.transactionId),
        eq(finBankTransactions.orgId, orgId),
        eq(finBankTransactions.bankAccountId, bankAccountId),
      ),
    });
    if (!txn) throw new NotFoundException("Bank transaction not found");

    if (txn.status === "RECONCILED") {
      throw new BadRequestException("Cannot ignore a reconciled transaction");
    }

    await this.db
      .update(finBankTransactions)
      .set({ status: "IGNORED" })
      .where(and(eq(finBankTransactions.id, txn.id), eq(finBankTransactions.orgId, orgId)));

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

  async listRules(u: CurrentUserContext, query: RulesQuery) {
    const { orgId } = u;
    const { limit, offset } = paginateOffset(query);

    const where = eq(finReconciliationRules.orgId, orgId);
    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(finReconciliationRules)
        .where(where)
        .orderBy(sql`${finReconciliationRules.priority} DESC`)
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(finReconciliationRules).where(where),
    ]);

    return buildListResponse(rows, totals?.total ?? 0, query);
  }

  async createRule(u: CurrentUserContext, bankAccountId: number, input: CreateReconciliationRuleInput) {
    const { orgId, userId } = u;

    await this.assertAccountOwned(orgId, bankAccountId);

    const [rule] = await this.db
      .insert(finReconciliationRules)
      .values({
        orgId,
        name: input.name,
        priority: input.priority,
        conditions: input.conditions,
        action: input.action,
        isActive: input.isActive,
      })
      .returning();

    if (!rule) throw new Error("Failed to create reconciliation rule");

    this.audit.log({
      action: "banking.rule.create",
      userId,
      orgId,
      resourceType: "reconciliation_rule",
      resourceId: String(rule.id),
      result: "SUCCESS",
    });

    return rule;
  }

  async deleteRule(u: CurrentUserContext, bankAccountId: number, ruleId: number) {
    const { orgId, userId } = u;

    await this.assertAccountOwned(orgId, bankAccountId);

    const existing = await this.db.query.finReconciliationRules.findFirst({
      where: and(eq(finReconciliationRules.id, ruleId), eq(finReconciliationRules.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Reconciliation rule not found");

    await this.db
      .delete(finReconciliationRules)
      .where(and(eq(finReconciliationRules.id, ruleId), eq(finReconciliationRules.orgId, orgId)));

    this.audit.log({
      action: "banking.rule.delete",
      userId,
      orgId,
      resourceType: "reconciliation_rule",
      resourceId: String(ruleId),
      result: "SUCCESS",
    });

    return { success: true };
  }

  private async computeLedgerBalance(orgId: string, ledgerAccountId: number | null | undefined): Promise<string | null> {
    if (!ledgerAccountId) return null;

    const [result] = await this.db
      .select({
        balance: sql<string>`COALESCE(SUM(CAST(${journalLines.debit} AS numeric)) - SUM(CAST(${journalLines.credit} AS numeric)), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, and(
        eq(journalEntries.id, journalLines.entryId),
        eq(journalEntries.status, "POSTED"),
      ))
      .where(and(
        eq(journalLines.accountId, ledgerAccountId),
        eq(journalEntries.orgId, orgId),
      ));

    return result?.balance ?? "0";
  }

  private async assertAccountOwned(orgId: string, bankAccountId: number): Promise<void> {
    const account = await this.db.query.finBankAccounts.findFirst({
      where: and(eq(finBankAccounts.id, bankAccountId), eq(finBankAccounts.orgId, orgId)),
      columns: { id: true },
    });
    if (!account) throw new NotFoundException("Bank account not found");
  }
}
