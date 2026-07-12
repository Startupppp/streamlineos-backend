import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  finBankAccounts,
  finBankTransactions,
  ledgerAccounts,
} from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { paginateOffset, buildListResponse } from "../../common/pagination/pagination";
import { FinancePostingService } from "../accounting/finance-posting.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type {
  CreateBankAccountInput,
  UpdateBankAccountInput,
  BankAccountsQuery,
  BankTransactionsQuery,
} from "./dto/bank-accounts.schemas";

const CACHE_BANK_ACCOUNTS = (orgId: string) => `fin:banking:accounts:${orgId}`;
const CACHE_BANK_ACCOUNT_DETAIL = (orgId: string, id: number) => `fin:banking:account:${orgId}:${id}`;

@Injectable()
export class BankAccountsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: FinancePostingService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async list(u: CurrentUserContext, query: BankAccountsQuery) {
    const { orgId } = u;
    const { limit, offset } = paginateOffset(query);

    const conditions: SQL[] = [eq(finBankAccounts.orgId, orgId)];
    if (query.isActive !== undefined) {
      conditions.push(eq(finBankAccounts.isActive, query.isActive));
    }
    if (query.q) {
      const pattern = `%${query.q}%`;
      const search = or(
        ilike(finBankAccounts.name, pattern),
        ilike(finBankAccounts.bankName, pattern),
      );
      if (search) conditions.push(search);
    }

    const where = and(...conditions);
    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(finBankAccounts)
        .where(where)
        .orderBy(asc(finBankAccounts.name))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(finBankAccounts).where(where),
    ]);

    return buildListResponse(rows, totals?.total ?? 0, query);
  }

  async findOne(orgId: string, bankAccountId: number) {
    return this.cache.cached(
      CACHE_BANK_ACCOUNT_DETAIL(orgId, bankAccountId),
      async () => {
        const row = await this.db.query.finBankAccounts.findFirst({
          where: and(
            eq(finBankAccounts.id, bankAccountId),
            eq(finBankAccounts.orgId, orgId),
          ),
        });
        if (!row) throw new NotFoundException("Bank account not found");
        return row;
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async create(u: CurrentUserContext, input: CreateBankAccountInput) {
    const { orgId, userId } = u;

    const duplicate = await this.db.query.finBankAccounts.findFirst({
      where: and(eq(finBankAccounts.orgId, orgId), eq(finBankAccounts.name, input.name)),
      columns: { id: true },
    });
    if (duplicate) throw new ConflictException(`Bank account named "${input.name}" already exists`);

    const result = await this.db.transaction(async (tx) => {
      let ledgerAccountId = input.ledgerAccountId;

      if (!ledgerAccountId) {
        const code = await this.allocateBankCode(orgId, tx);
        const [newLedger] = await tx
          .insert(ledgerAccounts)
          .values({
            orgId,
            code,
            name: input.name,
            accountType: "ASSET",
            isSystem: true,
            normalBalance: "DEBIT",
          })
          .returning({ id: ledgerAccounts.id });
        if (!newLedger) throw new Error("Failed to create ledger account");
        ledgerAccountId = newLedger.id;
      }

      const [account] = await tx
        .insert(finBankAccounts)
        .values({
          orgId,
          name: input.name,
          accountType: input.accountType,
          accountNumberMasked: input.accountNumberMasked ?? null,
          bankName: input.bankName ?? null,
          ifsc: input.ifsc ?? null,
          currency: input.currency,
          ledgerAccountId,
          openingBalance: input.openingBalance,
          currentBalance: input.openingBalance,
        })
        .returning();
      if (!account) throw new Error("Failed to create bank account");

      const openingAmount = parseFloat(input.openingBalance);
      if (openingAmount !== 0) {
        const entryDate = input.openingBalanceDate ?? new Date().toISOString().slice(0, 10);
        await this.posting.postJournal(u, {
          entryDate,
          description: `Opening balance for ${input.name}`,
          sourceType: "bank_account",
          sourceId: String(account.id),
          sourceEvent: "opening_balance",
          lines: [
            { accountId: ledgerAccountId, debit: input.openingBalance, credit: "0" },
            { systemPurpose: "OWNER_EQUITY", debit: "0", credit: input.openingBalance },
          ],
        });
      }

      return account;
    });

    await this.cache.invalidatePattern(`fin:banking:accounts:${orgId}*`);

    this.audit.log({
      action: "banking.account.create",
      userId,
      orgId,
      resourceType: "bank_account",
      resourceId: String(result.id),
      result: "SUCCESS",
    });

    return result;
  }

  async update(u: CurrentUserContext, bankAccountId: number, input: UpdateBankAccountInput) {
    const { orgId, userId } = u;

    const existing = await this.db.query.finBankAccounts.findFirst({
      where: and(eq(finBankAccounts.id, bankAccountId), eq(finBankAccounts.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Bank account not found");

    if (input.name) {
      const duplicate = await this.db.query.finBankAccounts.findFirst({
        where: and(
          eq(finBankAccounts.orgId, orgId),
          eq(finBankAccounts.name, input.name),
        ),
        columns: { id: true },
      });
      if (duplicate && duplicate.id !== bankAccountId) {
        throw new ConflictException(`Bank account named "${input.name}" already exists`);
      }
    }

    const [updated] = await this.db
      .update(finBankAccounts)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(finBankAccounts.id, bankAccountId), eq(finBankAccounts.orgId, orgId)))
      .returning();

    await Promise.all([
      this.cache.invalidate(CACHE_BANK_ACCOUNT_DETAIL(orgId, bankAccountId)),
      this.cache.invalidatePattern(`fin:banking:accounts:${orgId}*`),
    ]);

    this.audit.log({
      action: "banking.account.update",
      userId,
      orgId,
      resourceType: "bank_account",
      resourceId: String(bankAccountId),
      result: "SUCCESS",
    });

    return updated;
  }

  async listTransactions(u: CurrentUserContext, bankAccountId: number, query: BankTransactionsQuery) {
    const { orgId } = u;

    const account = await this.db.query.finBankAccounts.findFirst({
      where: and(eq(finBankAccounts.id, bankAccountId), eq(finBankAccounts.orgId, orgId)),
      columns: { id: true },
    });
    if (!account) throw new NotFoundException("Bank account not found");

    const { limit, offset } = paginateOffset(query);
    const conditions: SQL[] = [
      eq(finBankTransactions.orgId, orgId),
      eq(finBankTransactions.bankAccountId, bankAccountId),
    ];

    if (query.status) conditions.push(eq(finBankTransactions.status, query.status));
    if (query.from) {
      conditions.push(sql`${finBankTransactions.txnDate} >= ${query.from}`);
    }
    if (query.to) {
      conditions.push(sql`${finBankTransactions.txnDate} <= ${query.to}`);
    }
    if (query.q) {
      const pattern = `%${query.q}%`;
      const search = or(
        ilike(finBankTransactions.description, pattern),
        ilike(finBankTransactions.counterparty, pattern),
      );
      if (search) conditions.push(search);
    }

    const where = and(...conditions);
    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(finBankTransactions)
        .where(where)
        .orderBy(desc(finBankTransactions.txnDate), desc(finBankTransactions.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(finBankTransactions).where(where),
    ]);

    return buildListResponse(rows, totals?.total ?? 0, query);
  }

  async recomputeBalance(bankAccountId: number, orgId: string): Promise<string> {
    const account = await this.db.query.finBankAccounts.findFirst({
      where: and(eq(finBankAccounts.id, bankAccountId), eq(finBankAccounts.orgId, orgId)),
      columns: { openingBalance: true },
    });
    if (!account) throw new NotFoundException("Bank account not found");

    const [agg] = await this.db
      .select({ total: sql<string>`COALESCE(SUM(CAST(${finBankTransactions.amount} AS numeric)), 0)` })
      .from(finBankTransactions)
      .where(
        and(
          eq(finBankTransactions.orgId, orgId),
          eq(finBankTransactions.bankAccountId, bankAccountId),
        ),
      );

    const movementSum = agg?.total ?? "0";
    const balance = (parseFloat(account.openingBalance) + parseFloat(movementSum)).toFixed(4);

    await this.db
      .update(finBankAccounts)
      .set({ currentBalance: balance, updatedAt: new Date() })
      .where(and(eq(finBankAccounts.id, bankAccountId), eq(finBankAccounts.orgId, orgId)));

    await this.cache.invalidate(CACHE_BANK_ACCOUNT_DETAIL(orgId, bankAccountId));
    return balance;
  }

  private async allocateBankCode(orgId: string, tx: Db): Promise<string> {
    const existing = await tx
      .select({ code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.orgId, orgId),
          sql`${ledgerAccounts.code} ~ '^11[0-9]{2}$'`,
        ),
      )
      .orderBy(desc(ledgerAccounts.code));

    const used = new Set(existing.map((r) => r.code));
    for (let i = 1100; i <= 1199; i++) {
      const candidate = String(i);
      if (!used.has(candidate)) return candidate;
    }
    throw new BadRequestException("No available bank account codes in range 1100-1199");
  }
}
