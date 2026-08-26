import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  ledgerAccounts,
  journalEntries,
  journalLines,
  accountingPeriods,
  accountingSettings,
  accNumberSequences,
  accSystemAccountMap,
  finApprovalPolicies,
  finApprovalRequests,
} from "../../../db/schema";
import type { NewJournalLine } from "../../../db/schema/accounting/accounting";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { ACCT_STATEMENTS_NS } from "../settings/accounting-settings.constants";
import {
  addDecimals,
  assertDebitsEqualsCredits,
  compareDecimals,
  formatDecimal,
  isZero,
  multiplyDecimals,
} from "../core/money.util";
import type {
  PostJournalInput,
  PostJournalLine,
  PostJournalResult,
  ReverseJournalResult,
  SystemAccountPurpose,
} from "../core/finance-posting.types";

const PURPOSE_DEFAULT_CODE: Record<SystemAccountPurpose, string> = {
  AR: "1200",
  AP: "2000",
  BANK_CLEARING: "1100",
  SALES_INCOME: "4000",
  DISCOUNT_GIVEN: "5990",
  TAX_PAYABLE: "2100",
  TAX_RECEIVABLE: "1410",
  PAYROLL_PAYABLE: "2300",
  EXPENSE_CLEARING: "5990",
  RETAINED_EARNINGS: "3100",
  OWNER_EQUITY: "3000",
  PAYMENT_FEES: "5910",
  REIMBURSEMENT_PAYABLE: "2000",
  FX_GAIN_LOSS: "4900",
  DEPRECIATION_EXPENSE: "5900",
  ACCUM_DEPRECIATION: "1590",
  SALARY_EXPENSE: "5100",
  ASSET_DISPOSAL_GAIN_LOSS: "4900",
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;

function todayIso(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function yyyymm(dateIso: string): string {
  return dateIso.slice(0, 7).replace("-", "");
}

@Injectable()
export class FinancePostingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly cache: CacheService,
  ) {}

  async resolveSystemAccount(orgId: string, purpose: SystemAccountPurpose): Promise<number> {
    const existing = await this.db
      .select({ accountId: accSystemAccountMap.accountId })
      .from(accSystemAccountMap)
      .where(
        and(
          eq(accSystemAccountMap.orgId, orgId),
          eq(accSystemAccountMap.purpose, purpose),
        ),
      )
      .limit(1);

    if (existing[0]) return existing[0].accountId;

    const defaultCode = PURPOSE_DEFAULT_CODE[purpose];
    const account = await this.db
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.orgId, orgId),
          eq(ledgerAccounts.code, defaultCode),
        ),
      )
      .limit(1);

    if (!account[0]) {
      throw new BadRequestException(
        `No account mapped for purpose ${purpose} and default code ${defaultCode} not found. Seed the chart of accounts first.`,
      );
    }

    await this.db
      .insert(accSystemAccountMap)
      .values({ orgId, purpose, accountId: account[0].id })
      .onConflictDoNothing();

    return account[0].id;
  }

  async assertPeriodOpen(orgId: string, date: string): Promise<void> {
    const periods = await this.db
      .select({ status: accountingPeriods.status })
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.orgId, orgId),
          lte(accountingPeriods.startDate, date),
          gte(accountingPeriods.endDate, date),
        ),
      )
      .limit(1);

    if (!periods[0]) {
      throw new BadRequestException(`No accounting period covers date ${date}`);
    }

    const { status } = periods[0];
    if (status === "CLOSED" || status === "LOCKED") {
      throw new BadRequestException(`Accounting period covering ${date} is ${status.toLowerCase()}`);
    }
  }

  private async getBaseCurrency(orgId: string): Promise<string> {
    const settings = await this.db
      .select({ baseCurrency: accountingSettings.baseCurrency })
      .from(accountingSettings)
      .where(eq(accountingSettings.orgId, orgId))
      .limit(1);
    return settings[0]?.baseCurrency ?? "INR";
  }

  private async nextSequenceNumber(orgId: string, entryDate: string, executor: DbOrTx): Promise<string> {
    const inserted = await executor
      .insert(accNumberSequences)
      .values({ orgId, entityType: "journal", prefix: "JE", nextNumber: 2, padding: 5 })
      .onConflictDoUpdate({
        target: [accNumberSequences.orgId, accNumberSequences.entityType],
        set: { nextNumber: sql`${accNumberSequences.nextNumber} + 1` },
      })
      .returning({
        next: accNumberSequences.nextNumber,
        padding: accNumberSequences.padding,
      });

    const row = inserted[0];
    if (!row) throw new Error("Sequence upsert returned no rows");
    const seq = row.next - 1;
    const pad = row.padding ?? 5;
    const period = yyyymm(entryDate);
    return `JE-${period}-${String(seq).padStart(pad, "0")}`;
  }

  private async resolveLineAccountIds(
    orgId: string,
    lines: PostJournalLine[],
    executor: DbOrTx,
  ): Promise<Array<PostJournalLine & { resolvedAccountId: number }>> {
    const purposeLines: Array<{ index: number; purpose: SystemAccountPurpose }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      if (line.accountId === undefined && line.systemPurpose === undefined) {
        throw new BadRequestException("Each journal line must have either accountId or systemPurpose");
      }
      if (line.systemPurpose !== undefined) {
        purposeLines.push({ index: i, purpose: line.systemPurpose });
      }
    }

    const purposeToAccountId = new Map<SystemAccountPurpose, number>();

    if (purposeLines.length > 0) {
      const distinctPurposes = [...new Set(purposeLines.map((pl) => pl.purpose))];

      const existingMappings = await executor
        .select({ purpose: accSystemAccountMap.purpose, accountId: accSystemAccountMap.accountId })
        .from(accSystemAccountMap)
        .where(and(eq(accSystemAccountMap.orgId, orgId), inArray(accSystemAccountMap.purpose, distinctPurposes)));

      for (const m of existingMappings) {
        purposeToAccountId.set(m.purpose as SystemAccountPurpose, m.accountId);
      }

      const unmappedPurposes = distinctPurposes.filter((p) => !purposeToAccountId.has(p));

      if (unmappedPurposes.length > 0) {
        const defaultCodes = unmappedPurposes.map((p) => PURPOSE_DEFAULT_CODE[p]);

        const foundAccounts = await executor
          .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.orgId, orgId), inArray(ledgerAccounts.code, defaultCodes)));

        const codeToId = new Map(foundAccounts.map((a) => [a.code, a.id]));
        const newMappings: { orgId: string; purpose: SystemAccountPurpose; accountId: number }[] = [];

        for (const purpose of unmappedPurposes) {
          const defaultCode = PURPOSE_DEFAULT_CODE[purpose];
          const accountId = codeToId.get(defaultCode);
          if (accountId === undefined) {
            throw new BadRequestException(
              `No account mapped for purpose ${purpose} and default code ${defaultCode} not found. Seed the chart of accounts first.`,
            );
          }
          purposeToAccountId.set(purpose, accountId);
          newMappings.push({ orgId, purpose, accountId });
        }

        if (newMappings.length > 0) {
          await executor.insert(accSystemAccountMap).values(newMappings).onConflictDoNothing();
        }
      }
    }

    return lines.map((line) => {
      if (line.accountId !== undefined) {
        return { ...line, resolvedAccountId: line.accountId };
      }
      const purpose = line.systemPurpose;
      if (purpose === undefined) {
        throw new BadRequestException("Each journal line must have either accountId or systemPurpose");
      }
      const accountId = purposeToAccountId.get(purpose);
      if (accountId === undefined) {
        throw new BadRequestException(`No account could be resolved for purpose ${String(purpose)}`);
      }
      return { ...line, resolvedAccountId: accountId };
    });
  }

  async postJournal(u: CurrentUserContext, input: PostJournalInput): Promise<PostJournalResult> {
    const { orgId, userId } = u;

    if (input.lines.length < 2) {
      throw new BadRequestException("A journal entry requires at least 2 lines");
    }

    assertDebitsEqualsCredits(input.lines);
    await this.assertPeriodOpen(orgId, input.entryDate);

    const baseCurrency = await this.getBaseCurrency(orgId);
    const entryCurrency = input.currency ?? baseCurrency;
    const isForeign = entryCurrency !== baseCurrency;

    if (isForeign && !input.exchangeRate) {
      throw new BadRequestException(
        `exchangeRate is required when currency ${entryCurrency} differs from base currency ${baseCurrency}`,
      );
    }

    let postedDirectly = false;
    const result = await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: journalEntries.id, entryNumber: journalEntries.entryNumber })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.orgId, orgId),
            eq(journalEntries.sourceType, input.sourceType),
            eq(journalEntries.sourceId, input.sourceId),
            eq(journalEntries.sourceEvent, input.sourceEvent),
          ),
        )
        .limit(1);

      if (existing[0]) {
        return { entryId: existing[0].id, entryNumber: existing[0].entryNumber, replayed: true };
      }

      const resolvedLines = await this.resolveLineAccountIds(orgId, input.lines, tx);
      const entryNumber = await this.nextSequenceNumber(orgId, input.entryDate, tx);

      const entryTotal = resolvedLines.reduce(
        (acc, l) => addDecimals(acc, l.debit ?? "0"),
        "0",
      );

      const allPolicies = await tx
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
        return compareDecimals(entryTotal, p.minAmount) >= 0;
      });

      const needsApproval = input.sourceType === "manual" && applicablePolicy !== undefined;

      const initialStatus = needsApproval ? "PENDING_APPROVAL" : "POSTED";
      postedDirectly = initialStatus === "POSTED";

      const [inserted] = await tx
        .insert(journalEntries)
        .values({
          orgId,
          entryNumber,
          entryDate: input.entryDate,
          postingDate: input.postingDate ?? input.entryDate,
          description: input.description,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          sourceEvent: input.sourceEvent,
          currency: entryCurrency,
          status: initialStatus,
          createdBy: input.createdBy ?? userId,
          ...(initialStatus === "POSTED" ? { postedBy: userId, postedAt: new Date() } : {}),
        })
        .returning({ id: journalEntries.id, entryNumber: journalEntries.entryNumber });

      if (!inserted) throw new Error("Journal entry insert returned no rows");

      const lineRows = resolvedLines.map((line, idx) => {
        const debit = formatDecimal(line.debit ?? "0");
        const credit = formatDecimal(line.credit ?? "0");
        let baseDebit: string | null = null;
        let baseCredit: string | null = null;

        if (isForeign && input.exchangeRate) {
          baseDebit = isZero(debit) ? "0.0000" : multiplyDecimals(debit, input.exchangeRate);
          baseCredit = isZero(credit) ? "0.0000" : multiplyDecimals(credit, input.exchangeRate);
        }

        return {
          entryId: inserted.id,
          accountId: line.resolvedAccountId,
          orgId,
          debit,
          credit,
          description: line.description ?? null,
          lineOrder: idx,
          currency: entryCurrency !== baseCurrency ? entryCurrency : null,
          exchangeRate: input.exchangeRate ?? null,
          baseDebit,
          baseCredit,
          clientId: line.clientId ?? null,
          vendorId: line.vendorId ?? null,
          projectId: line.projectId ?? null,
          departmentId: line.departmentId ?? null,
          employeeId: line.employeeId ?? null,
          taxCodeId: line.taxCodeId ?? null,
          dimensionValues: line.dimensionValues ?? null,
        };
      });

      await tx.insert(journalLines).values(lineRows);

      if (needsApproval && applicablePolicy) {
        await tx.insert(finApprovalRequests).values({
          orgId,
          recordType: "MANUAL_JOURNAL",
          recordId: inserted.id,
          status: "PENDING",
          requestedBy: userId,
        });

        if (applicablePolicy.approverUserId) {
          await this.dispatch.emit({
            eventKey: "accounting.approval.requested",
            orgId,
            actorUserId: userId,
            targetUserIds: [applicablePolicy.approverUserId],
            entityType: "journal_entry",
            entityId: String(inserted.id),
            variables: { entryNumber, amount: entryTotal, description: input.description },
          });
        }
      }

      return { entryId: inserted.id, entryNumber: inserted.entryNumber, replayed: false };
    });

    if (postedDirectly) {
      const invalidate = () => Promise.all([
        this.cache.invalidateNamespace(ACCT_STATEMENTS_NS(orgId)),
        this.cache.invalidateNamespace(CACHE_KEYS.finReportsNamespace(orgId)),
      ]);
      if (!registerAfterCommit(invalidate)) await invalidate();
    }

    this.audit.log({
      action: "accounting.journal.post",
      userId,
      orgId,
      resourceType: "journal_entry",
      resourceId: String(result.entryId),
      metadata: { entryNumber: result.entryNumber, replayed: result.replayed },
      result: "SUCCESS",
    });

    return result;
  }

  async reverseJournal(
    u: CurrentUserContext,
    entryId: number,
    reason?: string,
  ): Promise<ReverseJournalResult> {
    const { orgId, userId } = u;

    const today = todayIso();
    await this.assertPeriodOpen(orgId, today);

    const result = await this.db.transaction(async (tx) => {
      const [original] = await tx
        .select()
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.id, entryId),
            eq(journalEntries.orgId, orgId),
          ),
        )
        .limit(1);

      if (!original) throw new BadRequestException("Journal entry not found");
      if (original.status !== "POSTED") {
        throw new BadRequestException("Only POSTED entries can be reversed");
      }

      const lines = await tx
        .select({
          accountId: journalLines.accountId,
          debit: journalLines.debit,
          credit: journalLines.credit,
          description: journalLines.description,
          lineOrder: journalLines.lineOrder,
          currency: journalLines.currency,
          exchangeRate: journalLines.exchangeRate,
          clientId: journalLines.clientId,
          vendorId: journalLines.vendorId,
          projectId: journalLines.projectId,
          departmentId: journalLines.departmentId,
          employeeId: journalLines.employeeId,
          taxCodeId: journalLines.taxCodeId,
          dimensionValues: journalLines.dimensionValues,
        })
        .from(journalLines)
        .where(eq(journalLines.entryId, entryId));

      if (lines.length === 0) throw new BadRequestException("Entry has no lines to reverse");

      const reversalEntryNumber = await this.nextSequenceNumber(orgId, today, tx);
      const reversalDesc = reason
        ? `Reversal of ${original.entryNumber}: ${reason}`
        : `Reversal of ${original.entryNumber}`;

      const [reversal] = await tx
        .insert(journalEntries)
        .values({
          orgId,
          entryNumber: reversalEntryNumber,
          entryDate: today,
          postingDate: today,
          description: reversalDesc,
          sourceType: original.sourceType,
          sourceId: original.sourceId,
          sourceEvent: "reverse",
          currency: original.currency,
          status: "POSTED",
          createdBy: userId,
          postedBy: userId,
          postedAt: new Date(),
          reversedEntryId: entryId,
        })
        .returning({ id: journalEntries.id });

      if (!reversal) throw new Error("Reversal entry insert returned no rows");

      const reversalLines: NewJournalLine[] = lines.map((line, idx) => ({
        entryId: reversal.id,
        accountId: line.accountId,
        orgId,
        debit: formatDecimal(line.credit ?? "0"),
        credit: formatDecimal(line.debit ?? "0"),
        description: line.description ? `Reversal: ${line.description}` : null,
        lineOrder: idx,
        currency: line.currency,
        exchangeRate: line.exchangeRate,
        baseDebit: null,
        baseCredit: null,
        clientId: line.clientId,
        vendorId: line.vendorId,
        projectId: line.projectId,
        departmentId: line.departmentId,
        employeeId: line.employeeId,
        taxCodeId: line.taxCodeId,
        dimensionValues: line.dimensionValues,
      }));

      await tx.insert(journalLines).values(reversalLines);

      await tx
        .update(journalEntries)
        .set({ status: "VOID", reversedEntryId: reversal.id, updatedAt: new Date() })
        .where(eq(journalEntries.id, entryId));

      return reversal.id;
    });

    const invalidate = () => Promise.all([
      this.cache.invalidateNamespace(ACCT_STATEMENTS_NS(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.finReportsNamespace(orgId)),
    ]);
    if (!registerAfterCommit(invalidate)) await invalidate();

    this.audit.log({
      action: "accounting.journal.reverse",
      userId,
      orgId,
      resourceType: "journal_entry",
      resourceId: String(entryId),
      metadata: { reversalEntryId: result, reason },
      result: "SUCCESS",
    });

    return { reversalEntryId: result };
  }

  async assertEntryNotPosted(orgId: string, entryId: number): Promise<void> {
    const rows = await this.db
      .select({ status: journalEntries.status })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.id, entryId),
          eq(journalEntries.orgId, orgId),
        ),
      )
      .limit(1);

    if (rows[0]?.status === "POSTED") {
      throw new BadRequestException("Cannot mutate a POSTED journal entry");
    }
  }

  async assertApprovalGranted(orgId: string, entryId: number): Promise<void> {
    const requests = await this.db
      .select({ status: finApprovalRequests.status })
      .from(finApprovalRequests)
      .where(
        and(
          eq(finApprovalRequests.orgId, orgId),
          eq(finApprovalRequests.recordType, "MANUAL_JOURNAL"),
          eq(finApprovalRequests.recordId, entryId),
        ),
      )
      .limit(1);

    if (requests.length === 0) return;

    if (requests[0]?.status !== "APPROVED") {
      throw new BadRequestException(
        "Journal entry requires approval before posting",
      );
    }
  }
}
