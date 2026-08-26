import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  finBankAccounts,
  finBankTransactions,
  finBankTransfers,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import { paginateOffset, buildListResponse } from "../../../common/pagination/pagination";
import { createHash } from "crypto";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CreateBankTransferInput, TransfersQuery } from "./dto/transfers.schemas";

const CACHE_TRANSFERS = (orgId: string) => `fin:banking:transfers:${orgId}`;

function makeTransferFingerprint(orgId: string, accountId: number, date: string, amount: string, side: "FROM" | "TO"): string {
  const payload = `${orgId}|${accountId}|${date}|${amount}|TRANSFER_${side}`;
  return createHash("sha256").update(payload).digest("hex");
}

@Injectable()
export class TransfersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: FinancePostingService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async list(u: CurrentUserContext, query: TransfersQuery) {
    const { orgId } = u;
    const { limit, offset } = paginateOffset(query);

    const conditions = [eq(finBankTransfers.orgId, orgId)];
    if (query.bankAccountId !== undefined) {
      conditions.push(
        or(
          eq(finBankTransfers.fromBankAccountId, query.bankAccountId),
          eq(finBankTransfers.toBankAccountId, query.bankAccountId),
        ) as ReturnType<typeof eq>,
      );
    }
    if (query.from) {
      conditions.push(sql`${finBankTransfers.transferDate} >= ${query.from}` as ReturnType<typeof eq>);
    }
    if (query.to) {
      conditions.push(sql`${finBankTransfers.transferDate} <= ${query.to}` as ReturnType<typeof eq>);
    }

    const where = and(...conditions);
    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(finBankTransfers)
        .where(where)
        .orderBy(desc(finBankTransfers.transferDate), desc(finBankTransfers.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(finBankTransfers).where(where),
    ]);

    return buildListResponse(rows, totals?.total ?? 0, query);
  }

  async create(u: CurrentUserContext, input: CreateBankTransferInput) {
    const { orgId, userId } = u;

    const [fromAccount, toAccount] = await Promise.all([
      this.db.query.finBankAccounts.findFirst({
        where: and(eq(finBankAccounts.id, input.fromBankAccountId), eq(finBankAccounts.orgId, orgId)),
      }),
      this.db.query.finBankAccounts.findFirst({
        where: and(eq(finBankAccounts.id, input.toBankAccountId), eq(finBankAccounts.orgId, orgId)),
      }),
    ]);

    if (!fromAccount) throw new NotFoundException("Source bank account not found");
    if (!toAccount) throw new NotFoundException("Destination bank account not found");
    if (!fromAccount.isActive) throw new BadRequestException("Source bank account is inactive");
    if (!toAccount.isActive) throw new BadRequestException("Destination bank account is inactive");

    const fromLedgerAccountId = fromAccount.ledgerAccountId;
    const toLedgerAccountId = toAccount.ledgerAccountId;
    if (fromLedgerAccountId === null) {
      throw new BadRequestException("Source bank account has no linked ledger account");
    }
    if (toLedgerAccountId === null) {
      throw new BadRequestException("Destination bank account has no linked ledger account");
    }

    const currentBalance = parseFloat(fromAccount.currentBalance);
    const transferAmount = parseFloat(input.amount);
    if (currentBalance < transferAmount) {
      throw new BadRequestException(`Insufficient balance. Available: ${fromAccount.currentBalance}`);
    }

    const result = await this.db.transaction(async (tx) => {
      const description = input.description ?? `Transfer from ${fromAccount.name} to ${toAccount.name}`;

      const postResult = await this.posting.postJournal(u, {
        entryDate: input.transferDate,
        description,
        sourceType: "BANK_TRANSFER",
        sourceId: `${input.fromBankAccountId}-${input.toBankAccountId}-${input.transferDate}`,
        sourceEvent: "transfer",
        lines: [
          { accountId: toLedgerAccountId, debit: input.amount, credit: "0" },
          { accountId: fromLedgerAccountId, debit: "0", credit: input.amount },
        ],
      });

      const [transfer] = await tx
        .insert(finBankTransfers)
        .values({
          orgId,
          fromBankAccountId: input.fromBankAccountId,
          toBankAccountId: input.toBankAccountId,
          amount: input.amount,
          transferDate: input.transferDate,
          reference: input.reference ?? null,
          journalEntryId: postResult.entryId,
          createdBy: userId,
        })
        .returning();

      if (!transfer) throw new Error("Failed to create bank transfer");

      const fromFingerprint = makeTransferFingerprint(orgId, input.fromBankAccountId, input.transferDate, input.amount, "FROM");
      const toFingerprint = makeTransferFingerprint(orgId, input.toBankAccountId, input.transferDate, input.amount, "TO");

      await tx.insert(finBankTransactions).values([
        {
          orgId,
          bankAccountId: input.fromBankAccountId,
          txnDate: input.transferDate,
          description,
          reference: input.reference ?? null,
          amount: `-${input.amount}`,
          counterparty: toAccount.name,
          fingerprint: fromFingerprint,
          status: "RECONCILED",
          matchedJournalEntryId: postResult.entryId,
        },
        {
          orgId,
          bankAccountId: input.toBankAccountId,
          txnDate: input.transferDate,
          description,
          reference: input.reference ?? null,
          amount: input.amount,
          counterparty: fromAccount.name,
          fingerprint: toFingerprint,
          status: "RECONCILED",
          matchedJournalEntryId: postResult.entryId,
        },
      ]).onConflictDoNothing();

      await tx
        .update(finBankAccounts)
        .set({
          currentBalance: String((currentBalance - transferAmount).toFixed(4)),
          updatedAt: new Date(),
        })
        .where(and(eq(finBankAccounts.id, input.fromBankAccountId), eq(finBankAccounts.orgId, orgId)));

      const toBalance = parseFloat(toAccount.currentBalance) + transferAmount;
      await tx
        .update(finBankAccounts)
        .set({
          currentBalance: String(toBalance.toFixed(4)),
          updatedAt: new Date(),
        })
        .where(and(eq(finBankAccounts.id, input.toBankAccountId), eq(finBankAccounts.orgId, orgId)));

      return transfer;
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.finBankAccountsNamespace(orgId));
    await this.cache.invalidate(CACHE_TRANSFERS(orgId));
    await this.cache.invalidateNamespace(CACHE_KEYS.finReportsNamespace(orgId));

    this.audit.log({
      action: "banking.transfer.create",
      userId,
      orgId,
      resourceType: "bank_transfer",
      resourceId: String(result.id),
      metadata: {
        from: input.fromBankAccountId,
        to: input.toBankAccountId,
        amount: input.amount,
      },
      result: "SUCCESS",
    });

    return result;
  }
}
