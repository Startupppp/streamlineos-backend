/**
 * Posting a journal from a source document.
 *
 * This is the system's write path into the ledger — every invoice, bill,
 * payment, expense and depreciation run arrives here — and it is idempotent by
 * construction rather than by an Idempotency-Key: it looks first for an entry
 * with the same (orgId, sourceType, sourceId, sourceEvent) and returns it with
 * `replayed: true`. A retried source event therefore posts once, which is the
 * single property that keeps the ledger from double-counting under retry.
 *
 * Reversal next door starts from an entry that already exists, so none of the
 * admission work here — line count, balance, period, currency, approval policy,
 * FX base conversion — applies to it.
 *
 * The cache bust fires ONLY when the entry actually landed POSTED. An entry held
 * in PENDING_APPROVAL has not changed any statement or report yet, so busting
 * for it would be a stampede on no new information.
 *
 * MONEY: this is the GL kernel. Amounts are decimal strings handled through
 * money.util (`addDecimals`, `compareDecimals`, `formatDecimal`, `isZero`,
 * `multiplyDecimals`), never JS floats, and the foreign-currency base columns
 * are `multiplyDecimals(amount, exchangeRate)` with an explicit isZero
 * short-circuit. Every line moved from finance-posting.service.ts character for
 * character.
 */
import { BadRequestException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import {
  journalEntries,
  journalLines,
  finApprovalPolicies,
  finApprovalRequests,
} from "../../../../db/schema";
import { AuditService } from "../../../../common/audit/audit.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { registerAfterCommit } from "../../../../common/tenant/tenant-context";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { ACCT_STATEMENTS_NS } from "../../settings/accounting-settings.constants";
import { type DbOrTx } from "../../../../common/rbac/access-invalidate";
import {
  addDecimals,
  assertDebitsEqualsCredits,
  compareDecimals,
  formatDecimal,
  isZero,
  multiplyDecimals,
} from "../../core/money.util";
import type {
  PostJournalInput,
  PostJournalResult,
} from "../../core/finance-posting.types";
import { FinancePostingAccountsService } from "../finance-posting-accounts.service";

export interface JournalPostDeps {
  readonly db: Db;
  readonly accounts: FinancePostingAccountsService;
  readonly audit: AuditService;
  readonly dispatch: NotificationDispatchService;
  readonly cache: CacheService;
  /** Bound FinancePostingService.assertPeriodOpen. */
  readonly assertPeriodOpen: (orgId: string, date: string) => Promise<void>;
  /**
   * Bound FinancePostingService.getBaseCurrency and .nextSequenceNumber. Both
   * are private on the service and stay private: they are passed as closures
   * rather than exported, so nothing outside can mint a journal number.
   */
  readonly getBaseCurrency: (orgId: string) => Promise<string>;
  readonly nextSequenceNumber: (
    orgId: string,
    entryDate: string,
    executor: DbOrTx,
  ) => Promise<string>;
}

export async function postJournal(
  deps: JournalPostDeps,
  u: CurrentUserContext,
  input: PostJournalInput,
): Promise<PostJournalResult> {
  const { orgId, userId } = u;

  if (input.lines.length < 2) {
    throw new BadRequestException("A journal entry requires at least 2 lines");
  }

  assertDebitsEqualsCredits(input.lines);
  await deps.assertPeriodOpen(orgId, input.entryDate);

  const baseCurrency = await deps.getBaseCurrency(orgId);
  const entryCurrency = input.currency ?? baseCurrency;
  const isForeign = entryCurrency !== baseCurrency;

  if (isForeign && !input.exchangeRate) {
    throw new BadRequestException(
      `exchangeRate is required when currency ${entryCurrency} differs from base currency ${baseCurrency}`,
    );
  }

  let postedDirectly = false;
  const result = await deps.db.transaction(async (tx) => {
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

    const resolvedLines = await deps.accounts.resolveLineAccountIds(orgId, input.lines, tx);
    const entryNumber = await deps.nextSequenceNumber(orgId, input.entryDate, tx);

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
        await deps.dispatch.emit({
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
      deps.cache.invalidateNamespace(ACCT_STATEMENTS_NS(orgId)),
      deps.cache.invalidateNamespace(CACHE_KEYS.finReportsNamespace(orgId)),
    ]);
    if (!registerAfterCommit(invalidate)) await invalidate();
  }

  deps.audit.log({
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
