import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  finBankAccounts,
  finBankTransactions,
  finBankTransfers,
  organizationMembers,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../common/pagination/cursor";
import { keysetBeforeValue } from "../../../common/pagination/keyset";
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

  async list(u: CurrentUserContext, query: TransfersQuery): Promise<CursorPage<typeof finBankTransfers.$inferSelect>> {
    const { orgId } = u;
    const pos = decodeCursor(query.cursor);

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
    if (pos) conditions.push(keysetBeforeValue(finBankTransfers.transferDate, finBankTransfers.id, pos));

    const rows = await this.db
      .select()
      .from(finBankTransfers)
      .where(and(...conditions))
      .orderBy(desc(finBankTransfers.transferDate), desc(finBankTransfers.id))
      .limit(query.limit + 1);

    return buildCursorPage(rows, query.limit, (r) => ({
      sortValue: String(r.transferDate),
      id: String(r.id),
    }));
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

      const [transferActor] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
        .limit(1);
      const createdByMembershipId = transferActor?.id ?? null;

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
          createdByMembershipId,
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

      /*
       * Both balances move with atomic SQL, and the debit re-asserts sufficiency
       * inside the write.
       *
       * The sufficiency check above reads `fromAccount` before this transaction
       * opens, so it is advisory only: two 80-unit transfers out of a 100-unit
       * account both passed it, and because each then wrote an absolute value
       * computed from the same stale read, one debit vanished entirely and the
       * account was overdrawn against a guard that had said yes. The predicate
       * here is evaluated by the database against the row it is locking, so the
       * second transfer matches no row and is rejected rather than silently
       * losing the first.
       */
      const debited = await tx
        .update(finBankAccounts)
        .set({
          currentBalance: sql`${finBankAccounts.currentBalance} - ${input.amount}::numeric`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(finBankAccounts.id, input.fromBankAccountId),
            eq(finBankAccounts.orgId, orgId),
            gte(finBankAccounts.currentBalance, input.amount),
          ),
        )
        .returning({ id: finBankAccounts.id });

      if (debited.length === 0)
        throw new ConflictException(
          "The source account no longer has enough balance for this transfer. Refresh and try again.",
        );

      await tx
        .update(finBankAccounts)
        .set({
          currentBalance: sql`${finBankAccounts.currentBalance} + ${input.amount}::numeric`,
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
