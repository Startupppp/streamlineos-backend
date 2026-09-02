import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { accountingPeriods, journalEntries, journalLines, ledgerAccounts } from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { SETTINGS_CACHE_KEY } from "./accounting-settings.constants";
import type { PostOpeningBalancesInput } from "./dto/settings.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { FinancePostingService } from "../posting/finance-posting.service";
import type { PostJournalLine } from "../core/finance-posting.types";
import {
  absDecimal,
  compareDecimals,
  decimalFromNumber,
  subtractDecimals,
  sumDecimals,
} from "../core/money.util";

@Injectable()
export class OpeningBalancesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: FinancePostingService,
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
    const [existing] = await this.db
      .select({
        id: journalEntries.id,
        periodId: journalEntries.periodId,
        status: journalEntries.status,
      })
      .from(journalEntries)
      .where(and(eq(journalEntries.orgId, u.orgId), eq(journalEntries.sourceType, "OPENING_BALANCE")))
      .limit(1);

    if (existing) {
      if (existing.periodId) {
        const [period] = await this.db
          .select({ status: accountingPeriods.status })
          .from(accountingPeriods)
          .where(and(eq(accountingPeriods.orgId, u.orgId), eq(accountingPeriods.id, existing.periodId)))
          .limit(1);

        if (period && period.status !== "OPEN") {
          throw new ConflictException("Cannot re-post opening balances: the period is closed or locked");
        }
      }

      if (existing.status === "POSTED") {
        await this.posting.reverseJournal(u, existing.id, "Opening balance re-import");
      }
    }

    await this.doPost(u, input);
    return { reimported: !!existing };
  }

  private async doPost(u: CurrentUserContext, input: PostOpeningBalancesInput) {
    const debitTotal = sumDecimals(input.lines.map((l) => decimalFromNumber(l.debit ?? 0)));
    const creditTotal = sumDecimals(input.lines.map((l) => decimalFromNumber(l.credit ?? 0)));
    const diff = subtractDecimals(debitTotal, creditTotal);

    const lines: PostJournalLine[] = input.lines.map((l) => ({
      accountId: l.accountId,
      debit: decimalFromNumber(l.debit ?? 0),
      credit: decimalFromNumber(l.credit ?? 0),
      description: "Opening balance",
    }));

    const sign = compareDecimals(diff, "0");
    if (sign !== 0) {
      lines.push({
        systemPurpose: "RETAINED_EARNINGS",
        debit: sign > 0 ? "0.0000" : absDecimal(diff),
        credit: sign > 0 ? diff : "0.0000",
        description: "Opening balance auto-balance",
      });
    }

    const result = await this.posting.postJournal(u, {
      entryDate: input.asOfDate,
      description: "Opening balances",
      sourceType: "OPENING_BALANCE",
      sourceId: u.orgId,
      sourceEvent: "opening_balance",
      lines,
    });

    await this.cache.invalidate(SETTINGS_CACHE_KEY(u.orgId));

    this.audit.log({
      action: "accounting.opening_balances.posted",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "journal_entry",
      resourceId: u.orgId,
      after: { asOfDate: input.asOfDate, lineCount: input.lines.length, entryId: result.entryId },
    });
  }
}
