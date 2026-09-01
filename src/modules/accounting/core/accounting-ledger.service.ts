import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, getTableColumns, gt, gte, ilike, lt, lte, or, sql } from "drizzle-orm";
import { ledgerAccounts, journalEntries, journalLines, users } from "../../../db/schema";
import type { DataScope } from "../../access/access.types";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { JournalPostingService } from "../posting/journal-posting.service";
import { FinancePostingService } from "../posting/finance-posting.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { ACCT_STATEMENTS_NS } from "../settings/accounting-settings.constants";
import { AccountingJournalEntryService } from "./accounting-journal-entry.service";
import {
  type CreateAccountInput,
  type CreateJournalEntryInput,
  type ListAccountsQuery,
  type ListJournalQuery,
  type UpdateAccountInput,
} from "./dto/accounting.schemas";

function escapeLike(value: string): string {
  return value.replaceAll("%", "\\%").replaceAll("_", "\\_");
}

@Injectable()
export class AccountingLedgerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: JournalPostingService,
    private readonly finPosting: FinancePostingService,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly journalEntryService: AccountingJournalEntryService,
  ) {}

  async listAccounts(orgId: string, query: ListAccountsQuery) {
    const { cursor, limit, q, type, activeOnly } = query;

    await this.posting.seedChartOfAccountsForOrg(orgId);

    const conds = [eq(ledgerAccounts.orgId, orgId)];
    if (type) conds.push(eq(ledgerAccounts.accountType, type));
    if (activeOnly) conds.push(eq(ledgerAccounts.isActive, true));
    if (q) conds.push(ilike(ledgerAccounts.name, `%${escapeLike(q)}%`));

    const pos = decodeCursor(cursor);
    if (pos) {
      const cursorId = Number(pos.id);
      conds.push(
        or(
          gt(ledgerAccounts.code, pos.sortValue),
          and(eq(ledgerAccounts.code, pos.sortValue), gt(ledgerAccounts.id, cursorId))!,
        )!,
      );
    }

    const rows = await this.db
      .select(getTableColumns(ledgerAccounts))
      .from(ledgerAccounts)
      .where(and(...conds))
      .orderBy(asc(ledgerAccounts.code), asc(ledgerAccounts.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.code,
      id: String(row.id),
    }));
  }

  async createAccount(orgId: string, input: CreateAccountInput) {
    const existing = await this.db
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.orgId, orgId), eq(ledgerAccounts.code, input.code)))
      .limit(1);
    if (existing.length > 0) throw new ConflictException("Account code already exists");

    const inserted = await this.db
      .insert(ledgerAccounts)
      .values({ ...input, orgId })
      .returning();
    return inserted[0];
  }

  async updateAccount(orgId: string, accountId: number, input: UpdateAccountInput) {
    const updated = await this.db
      .update(ledgerAccounts)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.orgId, orgId)))
      .returning();
    if (updated.length === 0) throw new NotFoundException("Account not found");
    return updated[0];
  }

  async listJournal(orgId: string, query: ListJournalQuery, scope: DataScope, userId: string, membershipId: number) {
    const { cursor, limit, from, to, sourceType, status } = query;
    const fromStr = from ? from.toISOString().slice(0, 10) : undefined;
    const toStr = to ? to.toISOString().slice(0, 10) : undefined;

    const conds = [eq(journalEntries.orgId, orgId)];
    if (fromStr) conds.push(gte(journalEntries.entryDate, fromStr));
    if (toStr) conds.push(lte(journalEntries.entryDate, toStr));
    if (sourceType) conds.push(eq(journalEntries.sourceType, sourceType));
    if (status) conds.push(eq(journalEntries.status, status));
    if (scope === "own" || scope === "team") conds.push(eq(journalEntries.createdByMembershipId, membershipId));
    else if (scope === "none") conds.push(sql`false`);

    const pos = decodeCursor(cursor);
    if (pos) {
      const cursorId = Number(pos.id);
      conds.push(
        or(
          lt(journalEntries.entryDate, pos.sortValue),
          and(eq(journalEntries.entryDate, pos.sortValue), gt(journalEntries.id, cursorId))!,
        )!,
      );
    }

    const rows = await this.db
      .select(getTableColumns(journalEntries))
      .from(journalEntries)
      .where(and(...conds))
      .orderBy(desc(journalEntries.entryDate), asc(journalEntries.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.entryDate,
      id: String(row.id),
    }));
  }

  createJournalEntry(orgId: string, userId: string, membershipId: number, input: CreateJournalEntryInput) {
    return this.journalEntryService.createJournalEntry(orgId, userId, membershipId, input);
  }

  async getJournalEntry(orgId: string, entryId: number) {
    const headerRows = await this.db
      .select({
        id: journalEntries.id,
        orgId: journalEntries.orgId,
        entryNumber: journalEntries.entryNumber,
        entryDate: journalEntries.entryDate,
        postingDate: journalEntries.postingDate,
        description: journalEntries.description,
        periodId: journalEntries.periodId,
        currency: journalEntries.currency,
        sourceType: journalEntries.sourceType,
        sourceId: journalEntries.sourceId,
        sourceEvent: journalEntries.sourceEvent,
        status: journalEntries.status,
        createdBy: journalEntries.createdBy,
        approvedBy: journalEntries.approvedBy,
        approvedAt: journalEntries.approvedAt,
        postedBy: journalEntries.postedBy,
        postedAt: journalEntries.postedAt,
        reversedEntryId: journalEntries.reversedEntryId,
        createdAt: journalEntries.createdAt,
        updatedAt: journalEntries.updatedAt,
        createdByName: users.name,
        createdByEmail: users.email,
      })
      .from(journalEntries)
      .leftJoin(users, eq(users.id, journalEntries.createdBy))
      .where(and(eq(journalEntries.id, entryId), eq(journalEntries.orgId, orgId)))
      .limit(1);
    const header = headerRows[0];
    if (!header) throw new NotFoundException("Journal entry not found");

    const lines = await this.db
      .select({
        id: journalLines.id,
        entryId: journalLines.entryId,
        accountId: journalLines.accountId,
        debit: journalLines.debit,
        credit: journalLines.credit,
        description: journalLines.description,
        lineOrder: journalLines.lineOrder,
        accountCode: ledgerAccounts.code,
        accountName: ledgerAccounts.name,
      })
      .from(journalLines)
      .innerJoin(ledgerAccounts, eq(journalLines.accountId, ledgerAccounts.id))
      .where(and(eq(journalLines.entryId, entryId), eq(journalLines.orgId, orgId)))
      .orderBy(asc(journalLines.lineOrder));

    return { ...header, lines };
  }

  async postJournalEntry(orgId: string, userId: string, entryId: number) {
    const rows = await this.db
      .select({ id: journalEntries.id, status: journalEntries.status, entryDate: journalEntries.entryDate, entryNumber: journalEntries.entryNumber })
      .from(journalEntries)
      .where(and(eq(journalEntries.id, entryId), eq(journalEntries.orgId, orgId)))
      .limit(1);

    const entry = rows[0];
    if (!entry) throw new NotFoundException("Journal entry not found");
    if (entry.status === "POSTED") throw new ConflictException("Entry is already posted");
    if (entry.status === "VOID") throw new ConflictException("Cannot post a voided entry");

    await this.finPosting.assertPeriodOpen(orgId, entry.entryDate);

    if (entry.status === "PENDING_APPROVAL") {
      await this.finPosting.assertApprovalGranted(orgId, entryId);
    }

    const updated = await this.db
      .update(journalEntries)
      .set({ status: "POSTED", postedBy: userId, postedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(journalEntries.id, entryId), eq(journalEntries.orgId, orgId)))
      .returning({
        id: journalEntries.id,
        entryNumber: journalEntries.entryNumber,
        status: journalEntries.status,
      });

    const invalidate = () => Promise.all([
      this.cache.invalidateNamespace(ACCT_STATEMENTS_NS(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.finReportsNamespace(orgId)),
    ]);
    if (!registerAfterCommit(invalidate)) await invalidate();

    this.audit.log({
      action: "accounting.journal.post",
      userId,
      orgId,
      resourceType: "journal_entry",
      resourceId: String(entryId),
      metadata: { entryNumber: entry.entryNumber },
      result: "SUCCESS",
    });

    return updated[0];
  }

  reverseJournalEntry(orgId: string, userId: string, entryId: number) {
    return this.journalEntryService.reverseJournalEntry(orgId, userId, entryId);
  }
}
