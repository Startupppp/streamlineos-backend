import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, sql } from "drizzle-orm";
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
        .orderBy(desc(finBankTransactions.txnDate)),
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
        .orderBy(desc(finBankTransactions.txnDate)),
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

    const suggestedWithMatches = await Promise.all(
      suggested.map(async (txn) => {
        const matches = await this.db
          .select()
          .from(finReconciliationMatches)
          .where(
            and(
              eq(finReconciliationMatches.orgId, orgId),
              eq(finReconciliationMatches.bankTransactionId, txn.id),
            ),
          );
        return { ...txn, suggestedMatches: matches };
      }),
    );

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
