import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { ledgerAccounts, accSystemAccountMap } from "../../../db/schema";
import type { SystemAccountPurpose, PostJournalLine } from "../core/finance-posting.types";

export const PURPOSE_DEFAULT_CODE: Record<SystemAccountPurpose, string> = {
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
  // INV-09. Kept identical to `PURPOSE_SUGGESTED_CODE`; the parity spec holds
  // the two together, because a suggestion and a posting fallback that disagree
  // would show an admin one account and post to another.
  INVENTORY_ASSET: "1300",
  INVENTORY_COGS: "5000",
  INVENTORY_GRNI: "2000",
  INVENTORY_LANDED_COST_CLEARING: "2000",
  INVENTORY_WRITE_OFF: "5990",
  INVENTORY_ADJUSTMENT_GAIN_LOSS: "4900",
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTxForAccounts = Db | Tx;

@Injectable()
export class FinancePostingAccountsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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

  /**
   * INV-09 — the account **code** each purpose posts to for one organisation.
   *
   * `resolveSystemAccount` and `resolveLineAccountIds` above answer the same
   * question in account *ids*, and both of them write: an unmapped purpose whose
   * default code exists is inserted into `acc_system_account_map` as a side
   * effect, and an unmapped purpose whose default code does **not** exist raises
   * a `BadRequestException`. Neither behaviour is usable from inventory.
   *
   *   - Codes, not ids, because inventory reaches the ledger through
   *     `JournalPostingService.persistJournalEntry`, whose `DraftLine` carries
   *     an `accountCode`.
   *   - Read-only, because a goods receipt must not silently create a tenant's
   *     accounting configuration as a side effect of moving a box.
   *   - Never throws, because the caller is `InventoryAccountingBridge`, whose
   *     whole contract is that a receipt is a physical fact that happened and a
   *     missing account may not stop it being recorded. An unmapped purpose
   *     resolves to `PURPOSE_DEFAULT_CODE` — which is what every inventory call
   *     site named as a literal before this existed, so resolving through the
   *     map is behaviour-preserving for a tenant that has mapped nothing.
   *
   * The join is on `(id, org_id)` rather than `id` alone: the map row and the
   * account it points at must belong to the same tenant, and asserting it here
   * costs nothing while `ledger_accounts` and `acc_system_account_map` both
   * carry `org_id`.
   */
  async resolveAccountCodes<P extends SystemAccountPurpose>(
    orgId: string,
    purposes: readonly P[],
    executor: DbOrTxForAccounts = this.db,
  ): Promise<Record<P, string>> {
    const distinct = [...new Set(purposes)];
    const resolved = Object.fromEntries(
      distinct.map((purpose) => [purpose, PURPOSE_DEFAULT_CODE[purpose]]),
    ) as Record<P, string>;
    if (distinct.length === 0) return resolved;

    const rows = await executor
      .select({ purpose: accSystemAccountMap.purpose, code: ledgerAccounts.code })
      .from(accSystemAccountMap)
      .innerJoin(
        ledgerAccounts,
        and(
          eq(ledgerAccounts.id, accSystemAccountMap.accountId),
          eq(ledgerAccounts.orgId, accSystemAccountMap.orgId),
        ),
      )
      .where(
        and(
          eq(accSystemAccountMap.orgId, orgId),
          inArray(accSystemAccountMap.purpose, distinct),
        ),
      );

    for (const row of rows) resolved[row.purpose as P] = row.code;
    return resolved;
  }

  async resolveLineAccountIds(
    orgId: string,
    lines: PostJournalLine[],
    executor: DbOrTxForAccounts,
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
}
