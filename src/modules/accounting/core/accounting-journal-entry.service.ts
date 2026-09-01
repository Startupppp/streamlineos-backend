import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  journalEntries,
  journalLines,
  ledgerAccounts,
  finApprovalPolicies,
  finApprovalRequests,
  organizationMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { JournalPostingService, type DraftLine } from "../posting/journal-posting.service";
import { FinancePostingService } from "../posting/finance-posting.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { ACCT_STATEMENTS_NS } from "../settings/accounting-settings.constants";
import { addDecimals, compareDecimals } from "./money.util";
import { type CreateJournalEntryInput } from "./dto/accounting.schemas";

function todayIsoDate(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseDecimal(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

@Injectable()
export class AccountingJournalEntryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: JournalPostingService,
    private readonly finPosting: FinancePostingService,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly cache: CacheService,
  ) {}

  async createJournalEntry(orgId: string, userId: string, membershipId: number, input: CreateJournalEntryInput) {
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

    await this.finPosting.assertPeriodOpen(orgId, input.entryDate);
    await this.posting.seedChartOfAccountsForOrg(orgId);

    const entryTotalStr = input.lines.reduce((acc, l) => addDecimals(acc, l.debit.toFixed(4)), "0");

    const allPolicies = await this.db
      .select({
        id: finApprovalPolicies.id,
        approverMembershipId: finApprovalPolicies.approverMembershipId,
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
    const result = await this.db.transaction(async (tx) => {
      const persisted = await this.posting.persistJournalEntry(
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

        if (applicablePolicy.approverMembershipId) {
          const [approver] = await tx
            .select({ userId: organizationMembers.userId })
            .from(organizationMembers)
            .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.id, applicablePolicy.approverMembershipId)))
            .limit(1);
          if (!approver) throw new BadRequestException("Approval policy approver membership is no longer active");
          await this.dispatch.emit({
            eventKey: "accounting.approval.requested",
            orgId,
            actorUserId: userId,
            targetUserIds: [approver.userId],
            entityType: "journal_entry",
            entityId: String(persisted.id),
            variables: { entryNumber: persisted.entryNumber, amount: entryTotalStr, description: input.description },
          });
        }
      }

      return persisted;
    });

    this.audit.log({
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

  async reverseJournalEntry(orgId: string, userId: string, entryId: number) {
    const today = todayIsoDate();
    await this.finPosting.assertPeriodOpen(orgId, today);

    const headerRows = await this.db
      .select({
        id: journalEntries.id,
        orgId: journalEntries.orgId,
        entryNumber: journalEntries.entryNumber,
        entryDate: journalEntries.entryDate,
        sourceType: journalEntries.sourceType,
        sourceId: journalEntries.sourceId,
        sourceEvent: journalEntries.sourceEvent,
        status: journalEntries.status,
      })
      .from(journalEntries)
      .where(and(eq(journalEntries.id, entryId), eq(journalEntries.orgId, orgId)))
      .limit(1);
    const original = headerRows[0];
    if (!original) throw new NotFoundException("Journal entry not found");
    if (original.status !== "POSTED") throw new ConflictException("Only posted entries can be reversed");
    if (original.sourceEvent === "reverse") throw new ConflictException("Cannot reverse a reversing entry");

    const lineRows = await this.db
      .select({
        debit: journalLines.debit,
        credit: journalLines.credit,
        description: journalLines.description,
        lineOrder: journalLines.lineOrder,
        accountCode: ledgerAccounts.code,
      })
      .from(journalLines)
      .innerJoin(ledgerAccounts, eq(journalLines.accountId, ledgerAccounts.id))
      .where(and(eq(journalLines.entryId, original.id), eq(journalLines.orgId, orgId)))
      .orderBy(asc(journalLines.lineOrder));
    if (lineRows.length === 0) throw new ConflictException("Original entry has no lines");

    const reversingLines: DraftLine[] = lineRows.map((line) => ({
      accountCode: line.accountCode,
      debit: parseDecimal(line.credit),
      credit: parseDecimal(line.debit),
      description: `Reverses ${original.entryNumber}: ${line.description ?? ""}`,
    }));

    const sourceIdMatch =
      original.sourceId === null
        ? isNull(journalEntries.sourceId)
        : eq(journalEntries.sourceId, original.sourceId);
    const existing = await this.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.orgId, orgId),
          eq(journalEntries.sourceType, original.sourceType),
          sourceIdMatch,
          eq(journalEntries.sourceEvent, "reverse"),
        ),
      )
      .limit(1);
    const wasExisting = existing.length > 0;

    const persisted = await this.db.transaction(async (tx) => {
      const reversed = await this.posting.persistJournalEntry(
        {
          orgId,
          entryDate: today,
          description: `Reversing entry for ${original.entryNumber}`,
          sourceType: original.sourceType,
          sourceId: original.sourceId,
          sourceEvent: "reverse",
          createdBy: userId,
          lines: reversingLines,
        },
        tx,
      );

      await tx
        .update(journalEntries)
        .set({ status: "VOID", reversedEntryId: reversed.id, updatedAt: new Date() })
        .where(and(eq(journalEntries.id, entryId), eq(journalEntries.orgId, orgId)));

      return reversed;
    });

    const invalidateStatements = () => Promise.all([
      this.cache.invalidateNamespace(ACCT_STATEMENTS_NS(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.finReportsNamespace(orgId)),
    ]);
    if (!registerAfterCommit(invalidateStatements)) await invalidateStatements();

    this.audit.log({
      action: "accounting.journal.reverse",
      userId,
      orgId,
      resourceType: "journal_entry",
      resourceId: String(entryId),
      metadata: { reversalEntryId: persisted.id, reversalEntryNumber: persisted.entryNumber },
      result: "SUCCESS",
    });

    return {
      created: !wasExisting,
      result: { id: persisted.id, entryNumber: persisted.entryNumber, created: !wasExisting },
    };
  }
}
