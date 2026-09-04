import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { createHash } from "crypto";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  finBankAccounts,
  finBankImports,
  finBankTransactions,
  organizationMembers,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { MatchingService } from "./matching.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CreateBankImportInput, BankImportsQuery } from "./dto/imports.schemas";
import { parseBankStatementRows } from "./bank-statement-rows";

const MAX_IMPORT_ROWS = 2000;
const IMPORT_INSERT_CHUNK = 500;

function computeFingerprint(
  orgId: string,
  bankAccountId: number,
  date: string,
  amount: string,
  description: string,
): string {
  const normalized = description.trim().toLowerCase().replace(/\s+/g, " ");
  const payload = `${orgId}|${bankAccountId}|${date}|${amount}|${normalized}`;
  return createHash("sha256").update(payload).digest("hex");
}

@Injectable()
export class ImportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly matching: MatchingService,
    private readonly dispatch: NotificationDispatchService,
    private readonly audit: AuditService,
  ) {}

  async createImport(u: CurrentUserContext, input: CreateBankImportInput) {
    const { orgId, userId } = u;

    const account = await this.db.query.finBankAccounts.findFirst({
      where: and(
        eq(finBankAccounts.id, input.bankAccountId),
        eq(finBankAccounts.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!account) throw new NotFoundException("Bank account not found");

    const dataRows = input.hasHeaderRow ? input.rows.slice(1) : input.rows;
    if (dataRows.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException(`Import exceeds maximum of ${MAX_IMPORT_ROWS} rows`);
    }

    const { parsed, errors } = parseBankStatementRows(dataRows, input.columnMapping, input.dateFormat);

    if (errors.length > 0) {
      throw new BadRequestException({
        message: "Import contains invalid rows",
        rowErrors: errors,
      });
    }

    const [actorMember] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    const createdByMembershipId = actorMember?.id ?? null;

    const [importRecord] = await this.db
      .insert(finBankImports)
      .values({
        orgId,
        bankAccountId: input.bankAccountId,
        fileName: input.fileName,
        format: "CSV",
        rowCount: parsed.length,
        importedCount: 0,
        duplicateCount: 0,
        status: "PENDING",
        columnMapping: input.columnMapping,
        createdByMembershipId,
      })
      .returning();

    if (!importRecord) throw new Error("Failed to create import record");

    /*
     * One SELECT plus one INSERT per row is up to 4,000 round trips for a
     * MAX_IMPORT_ROWS file, and the SELECT was also a lost-update race: two
     * imports of the same statement both saw "not present" and both inserted,
     * or collided on `uniq_fin_bank_txn_org_account_fp` and 500'd the request.
     *
     * `ON CONFLICT DO NOTHING` against that same unique index is the existence
     * check — decided by the constraint, inside the write, with no window — so
     * the probe disappears rather than moving. What comes back from RETURNING is
     * exactly the set that was new; everything else is a duplicate.
     */
    const seenFingerprints = new Set<string>();
    const candidates: Array<typeof finBankTransactions.$inferInsert> = [];
    for (const row of parsed) {
      const fingerprint = computeFingerprint(orgId, input.bankAccountId, row.date, row.amount, row.description ?? "");
      if (seenFingerprints.has(fingerprint)) continue;
      seenFingerprints.add(fingerprint);
      candidates.push({
        orgId,
        bankAccountId: input.bankAccountId,
        importId: importRecord.id,
        txnDate: row.date,
        description: row.description,
        reference: row.reference,
        amount: row.amount,
        counterparty: row.counterparty,
        fingerprint,
        status: "UNMATCHED",
      });
    }

    const newTransactionIds: number[] = [];
    for (let i = 0; i < candidates.length; i += IMPORT_INSERT_CHUNK) {
      const inserted = await this.db
        .insert(finBankTransactions)
        .values(candidates.slice(i, i + IMPORT_INSERT_CHUNK))
        .onConflictDoNothing({
          target: [
            finBankTransactions.orgId,
            finBankTransactions.bankAccountId,
            finBankTransactions.fingerprint,
          ],
        })
        .returning({ id: finBankTransactions.id });
      for (const txn of inserted) newTransactionIds.push(txn.id);
    }

    const importedCount = newTransactionIds.length;
    const duplicateCount = parsed.length - importedCount;

    await this.db
      .update(finBankImports)
      .set({
        importedCount,
        duplicateCount,
        status: "COMPLETED",
      })
      .where(and(eq(finBankImports.id, importRecord.id), eq(finBankImports.orgId, orgId)));

    if (newTransactionIds.length > 0) {
      await this.matching.suggestMatches(u, input.bankAccountId, newTransactionIds);
    }

    await this.dispatch.emit({
      eventKey: "accounting.bank.import_completed",
      orgId,
      actorUserId: userId,
      targetUserIds: [userId],
      entityType: "bank_import",
      entityId: String(importRecord.id),
      variables: {
        fileName: input.fileName,
        importedCount,
        duplicateCount,
        totalRows: parsed.length,
      },
    });

    this.audit.log({
      action: "banking.import.complete",
      userId,
      orgId,
      resourceType: "bank_import",
      resourceId: String(importRecord.id),
      metadata: { importedCount, duplicateCount },
      result: "SUCCESS",
    });

    return { id: importRecord.id, importedCount, duplicateCount, totalRows: parsed.length };
  }

  async listImports(u: CurrentUserContext, query: BankImportsQuery): Promise<CursorPage<typeof finBankImports.$inferSelect>> {
    const { orgId } = u;
    const pos = decodeCursor(query.cursor);

    const conditions = [eq(finBankImports.orgId, orgId)];
    if (query.bankAccountId !== undefined) {
      conditions.push(eq(finBankImports.bankAccountId, query.bankAccountId));
    }
    if (pos) conditions.push(keysetBeforeId(finBankImports.createdAt, finBankImports.id, pos));

    const rows = await this.db
      .select()
      .from(finBankImports)
      .where(and(...conditions))
      .orderBy(desc(finBankImports.createdAt), desc(finBankImports.id))
      .limit(query.limit + 1);

    return buildCursorPage(rows, query.limit, (r) => ({
      sortValue: (r.createdAt ?? new Date(0)).toISOString(),
      id: String(r.id),
    }));
  }
}
