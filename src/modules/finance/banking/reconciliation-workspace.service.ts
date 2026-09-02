import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  finBankAccounts,
  finBankTransactions,
  finReconciliationMatches,
  journalEntries,
  journalLines,
} from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const MATCHES_PER_TRANSACTION_CAP = 100;

@Injectable()
export class ReconciliationWorkspaceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getWorkspace(u: CurrentUserContext, bankAccountId: number) {
    const { orgId } = u;

    const account = await this.db.query.finBankAccounts.findFirst({
      where: and(
        eq(finBankAccounts.id, bankAccountId),
        eq(finBankAccounts.orgId, orgId),
      ),
    });
    if (!account) throw new NotFoundException("Bank account not found");

    const [unmatched, suggested, reconciledCount] = await Promise.all([
      this.db
        .select()
        .from(finBankTransactions)
        .where(
          and(
            eq(finBankTransactions.orgId, orgId),
            eq(finBankTransactions.bankAccountId, bankAccountId),
            eq(finBankTransactions.status, "UNMATCHED"),
          ),
        )
        .orderBy(desc(finBankTransactions.txnDate))
        .limit(100),
      this.db
        .select()
        .from(finBankTransactions)
        .where(
          and(
            eq(finBankTransactions.orgId, orgId),
            eq(finBankTransactions.bankAccountId, bankAccountId),
            eq(finBankTransactions.status, "SUGGESTED"),
          ),
        )
        .orderBy(desc(finBankTransactions.txnDate))
        .limit(100),
      this.db
        .select({ total: count() })
        .from(finBankTransactions)
        .where(
          and(
            eq(finBankTransactions.orgId, orgId),
            eq(finBankTransactions.bankAccountId, bankAccountId),
            eq(finBankTransactions.status, "RECONCILED"),
          ),
        ),
    ]);

    /*
     * One query for every suggested transaction's matches, not one per
     * transaction: `suggested` is capped at 100, so this was 100 round trips on
     * a screen that renders one page.
     *
     * The per-transaction cap is preserved rather than replaced by a global one,
     * and the statement's own budget is the sum of those caps, so no transaction
     * can starve another. `MatchingService.suggestMatches` writes at most one
     * row per bank transaction per run, so this budget is not reachable in
     * practice — it exists to keep the read bounded, not to trim a real result.
     */
    const suggestedIds = suggested.map((txn) => txn.id);
    const matchRows =
      suggestedIds.length === 0
        ? []
        : await this.db
            .select()
            .from(finReconciliationMatches)
            .where(
              and(
                eq(finReconciliationMatches.orgId, orgId),
                inArray(finReconciliationMatches.bankTransactionId, suggestedIds),
              ),
            )
            .orderBy(
              asc(finReconciliationMatches.bankTransactionId),
              asc(finReconciliationMatches.id),
            )
            .limit(suggestedIds.length * MATCHES_PER_TRANSACTION_CAP);

    const matchesByTransaction = new Map<number, typeof matchRows>();
    for (const match of matchRows) {
      const bucket = matchesByTransaction.get(match.bankTransactionId);
      if (bucket) {
        if (bucket.length < MATCHES_PER_TRANSACTION_CAP) bucket.push(match);
      } else matchesByTransaction.set(match.bankTransactionId, [match]);
    }

    const suggestedWithMatches = suggested.map((txn) => ({
      ...txn,
      suggestedMatches: matchesByTransaction.get(txn.id) ?? [],
    }));

    const ledgerBalance = await this.computeLedgerBalance(
      orgId,
      account.ledgerAccountId,
    );

    return {
      unmatched,
      suggested: suggestedWithMatches,
      reconciledCount: reconciledCount[0]?.total ?? 0,
      ledgerBalance,
      bankBalance: account.currentBalance,
    };
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
