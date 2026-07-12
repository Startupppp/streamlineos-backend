import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { accountingPeriods, accSystemAccountMap, journalEntries, journalLines, ledgerAccounts } from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { SETTINGS_CACHE_KEY } from "./accounting-settings.constants";
import type { PostOpeningBalancesInput } from "./dto/settings.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { JournalPostingService } from "../accounting/journal-posting.service";

@Injectable()
export class OpeningBalancesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: JournalPostingService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async getOpeningBalance(orgId: string) {
    const [entry] = await this.db
      .select({
        id: journalEntries.id,
        entryNumber: journalEntries.entryNumber,
        entryDate: journalEntries.entryDate,
        status: journalEntries.status,
        description: journalEntries.description,
        createdAt: journalEntries.createdAt,
      })
      .from(journalEntries)
      .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.sourceType, "OPENING_BALANCE")))
      .limit(1);

    if (!entry) return { posted: false, entry: null };

    const lines = await this.db
      .select({
        id: journalLines.id,
        accountId: journalLines.accountId,
        accountCode: ledgerAccounts.code,
        accountName: ledgerAccounts.name,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines)
      .innerJoin(ledgerAccounts, eq(journalLines.accountId, ledgerAccounts.id))
      .where(eq(journalLines.entryId, entry.id));

    return { posted: true, entry: { ...entry, lines } };
  }

  async postOpeningBalances(u: CurrentUserContext, input: PostOpeningBalancesInput) {
    const existing = await this.db
      .select({
        id: journalEntries.id,
        entryNumber: journalEntries.entryNumber,
        periodId: journalEntries.periodId,
      })
      .from(journalEntries)
      .where(and(eq(journalEntries.orgId, u.orgId), eq(journalEntries.sourceType, "OPENING_BALANCE")))
      .limit(1);

    if (existing[0]) {
      const openPeriod = existing[0].periodId
        ? await this.db
            .select({ status: accountingPeriods.status })
            .from(accountingPeriods)
            .where(and(eq(accountingPeriods.orgId, u.orgId), eq(accountingPeriods.id, existing[0].periodId)))
            .limit(1)
        : null;

      const isClosed = openPeriod?.[0] && openPeriod[0].status !== "OPEN";
      if (isClosed) {
        throw new ConflictException("Cannot re-post opening balances: the period is closed or locked");
      }

      await this.reverseAndRepost(u, existing[0].id, input);
      return { reimported: true };
    }

    await this.createOpeningBalanceEntry(u, input);
    return { reimported: false };
  }

  private async createOpeningBalanceEntry(u: CurrentUserContext, input: PostOpeningBalancesInput) {
    const debitTotal = input.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const creditTotal = input.lines.reduce((s, l) => s + (l.credit ?? 0), 0);
    const diff = Math.round((debitTotal - creditTotal) * 100) / 100;

    const [retainedMapping] = await this.db
      .select({ accountId: accSystemAccountMap.accountId })
      .from(accSystemAccountMap)
      .where(and(eq(accSystemAccountMap.orgId, u.orgId), eq(accSystemAccountMap.purpose, "RETAINED_EARNINGS")))
      .limit(1);

    const accountIds = input.lines.map((l) => l.accountId);
    const accounts = await this.db
      .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.orgId, u.orgId));

    const idToCode = new Map(accounts.map((a) => [a.id, a.code]));

    const draftLines: Array<{ accountCode: string; debit: number; credit: number; description?: string }> =
      input.lines.map((l) => {
        const code = idToCode.get(l.accountId);
        if (!code) throw new ConflictException(`Account ${l.accountId} not found`);
        return { accountCode: code, debit: l.debit ?? 0, credit: l.credit ?? 0, description: "Opening balance" };
      });

    if (Math.abs(diff) > 0.009) {
      if (!retainedMapping) {
        throw new ConflictException(
          "Opening balances are unbalanced. Map the RETAINED_EARNINGS system account to auto-balance.",
        );
      }
      const reCode = idToCode.get(retainedMapping.accountId);
      if (!reCode) throw new ConflictException("Retained earnings account not found in chart of accounts");

      if (diff > 0) {
        draftLines.push({ accountCode: reCode, debit: 0, credit: diff, description: "Opening balance auto-balance" });
      } else {
        draftLines.push({ accountCode: reCode, debit: Math.abs(diff), credit: 0, description: "Opening balance auto-balance" });
      }
    }

    await this.posting.persistJournalEntry({
      orgId: u.orgId,
      entryDate: input.asOfDate,
      description: "Opening balances",
      sourceType: "OPENING_BALANCE",
      sourceId: u.orgId,
      sourceEvent: "opening_balance",
      status: "POSTED",
      createdBy: u.userId,
      lines: draftLines,
    });

    await this.cache.invalidate(SETTINGS_CACHE_KEY(u.orgId));

    this.audit.log({
      action: "accounting.opening_balances.posted",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "journal_entry",
      resourceId: u.orgId,
      after: { asOfDate: input.asOfDate, lineCount: input.lines.length } as Record<string, unknown>,
    });
  }

  private async reverseAndRepost(u: CurrentUserContext, existingEntryId: number, input: PostOpeningBalancesInput) {
    const existingLines = await this.db
      .select({
        accountId: journalLines.accountId,
        debit: journalLines.debit,
        credit: journalLines.credit,
        description: journalLines.description,
        lineOrder: journalLines.lineOrder,
      })
      .from(journalLines)
      .where(eq(journalLines.entryId, existingEntryId));

    const accounts = await this.db
      .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.orgId, u.orgId));

    const idToCode = new Map(accounts.map((a) => [a.id, a.code]));

    const reversalLines = existingLines.map((l) => {
      const code = idToCode.get(l.accountId);
      if (!code) throw new ConflictException(`Account ${l.accountId} not found`);
      return {
        accountCode: code,
        debit: parseFloat(l.credit),
        credit: parseFloat(l.debit),
        description: "Opening balance reversal",
      };
    });

    await this.posting.persistJournalEntry({
      orgId: u.orgId,
      entryDate: input.asOfDate,
      description: "Opening balances reversal",
      sourceType: "OPENING_BALANCE",
      sourceId: u.orgId,
      sourceEvent: `opening_balance_reversal_${Date.now()}`,
      status: "POSTED",
      createdBy: u.userId,
      lines: reversalLines,
    });

    await this.db
      .update(journalEntries)
      .set({ status: "VOID" })
      .where(eq(journalEntries.id, existingEntryId));

    await this.createOpeningBalanceEntry(u, { ...input });
  }
}
