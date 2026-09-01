import {
  BadRequestException, Inject, Injectable,
  InternalServerErrorException, NotFoundException, UnprocessableEntityException,
} from "@nestjs/common";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { decodeCursor, buildCursorPage } from "../../../common/pagination/cursor";
import { keysetBefore } from "../../../common/pagination/keyset";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import {
  accFixedAssets, accAssetCategories, accDepreciationSchedules,
} from "../../../db/schema/accounting/finance-assets";
import { accNumberSequences, accSystemAccountMap } from "../../../db/schema/accounting/accounting-core";
import { ledgerAccounts } from "../../../db/schema/accounting/accounting";
import { purchaseBills } from "../../../db/schema/crm/invoicing";
import { JournalPostingService, type DraftLine, type DbOrTx } from "../../accounting/posting/journal-posting.service";
import type { SystemAccountPurpose } from "../../accounting/core/finance-posting.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CreateAssetInput, DisposeAssetInput, ListAssetsQuery, UpdateAssetInput } from "./dto/assets.schemas";

type TxArg = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class AssetsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: JournalPostingService,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  async list(orgId: string, query: ListAssetsQuery) {
    const { cursor, limit } = query;
    const pos = decodeCursor(cursor);
    const pageLimit = Math.min(limit, 100);
    const cacheKey = `${cursor ?? ""}:${pageLimit}:${query.status ?? ""}:${query.categoryId ?? ""}`;

    return this.cache.cachedVersioned(CACHE_KEYS.finAssetsListNamespace(orgId), cacheKey, async () => {
      const conditions = [eq(accFixedAssets.orgId, orgId)];
      if (query.status) conditions.push(eq(accFixedAssets.status, query.status));
      if (query.categoryId) conditions.push(eq(accFixedAssets.categoryId, query.categoryId));
      if (pos) conditions.push(keysetBefore(accFixedAssets.createdAt, accFixedAssets.id, pos));

      const rows = await this.db
        .select({
          asset: accFixedAssets,
          categoryName: accAssetCategories.name,
        })
        .from(accFixedAssets)
        .leftJoin(accAssetCategories, eq(accFixedAssets.categoryId, accAssetCategories.id))
        .where(and(...conditions))
        .orderBy(desc(accFixedAssets.createdAt), desc(accFixedAssets.id))
        .limit(pageLimit + 1);

      return buildCursorPage(rows, pageLimit, (row) => ({
        sortValue: (row.asset.createdAt ?? new Date(0)).toISOString(),
        id: String(row.asset.id),
      }));
    }, 60);
  }

  async getOne(orgId: string, assetId: number) {
    const [row] = await this.db
      .select({
        asset: accFixedAssets,
        category: accAssetCategories,
      })
      .from(accFixedAssets)
      .leftJoin(accAssetCategories, eq(accFixedAssets.categoryId, accAssetCategories.id))
      .where(and(eq(accFixedAssets.id, assetId), eq(accFixedAssets.orgId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundException(`Asset ${assetId} not found`);

    const schedules = await this.db
      .select()
      .from(accDepreciationSchedules)
      .where(and(eq(accDepreciationSchedules.assetId, assetId), eq(accDepreciationSchedules.orgId, orgId)))
      .orderBy(accDepreciationSchedules.periodKey)
      .limit(1200);

    return { ...row, schedules };
  }

  async create(u: CurrentUserContext, input: CreateAssetInput) {
    const [category] = await this.db
      .select()
      .from(accAssetCategories)
      .where(and(eq(accAssetCategories.id, input.categoryId), eq(accAssetCategories.orgId, u.orgId)))
      .limit(1);
    if (!category) throw new NotFoundException(`Asset category ${input.categoryId} not found`);

    if (input.billId) {
      const [bill] = await this.db
        .select({ id: purchaseBills.id })
        .from(purchaseBills)
        .where(and(eq(purchaseBills.id, input.billId), eq(purchaseBills.orgId, u.orgId)))
        .limit(1);
      if (!bill) throw new NotFoundException(`Purchase bill ${input.billId} not found`);
    }

    const assetNumber = await this.db.transaction(async (tx) => {
      return this.nextAssetNumber(u.orgId, tx);
    });

    const [asset] = await this.db
      .insert(accFixedAssets)
      .values({
        orgId: u.orgId,
        assetNumber,
        name: input.name,
        categoryId: input.categoryId,
        acquisitionDate: input.acquisitionDate,
        acquisitionCost: input.acquisitionCost,
        salvageValue: input.salvageValue,
        usefulLifeMonths: input.usefulLifeMonths,
        depreciationMethod: input.depreciationMethod,
        vendorId: input.vendorId ?? null,
        billId: input.billId ?? null,
        status: "DRAFT",
      })
      .returning();

    if (!asset) throw new InternalServerErrorException("Failed to create asset.");

    this.audit.log({
      action: "CREATE",
      orgId: u.orgId,
      userId: u.userId,
      resourceType: "fixed_asset",
      resourceId: String(asset.id),
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.finAssetsListNamespace(u.orgId));
    return asset;
  }

  async update(orgId: string, assetId: number, input: UpdateAssetInput) {
    const asset = await this.findOrThrow(orgId, assetId);

    const hasPostedSchedules = await this.db
      .select({ c: count() })
      .from(accDepreciationSchedules)
      .where(
        and(
          eq(accDepreciationSchedules.assetId, assetId),
          eq(accDepreciationSchedules.status, "POSTED"),
        ),
      );
    const postedCount = Number(hasPostedSchedules[0]?.c ?? 0);

    if (asset.status !== "DRAFT" && postedCount > 0) {
      throw new BadRequestException("Cannot update an asset that has posted depreciation schedules");
    }

    if (input.categoryId) {
      const [cat] = await this.db
        .select({ id: accAssetCategories.id })
        .from(accAssetCategories)
        .where(and(eq(accAssetCategories.id, input.categoryId), eq(accAssetCategories.orgId, orgId)))
        .limit(1);
      if (!cat) throw new NotFoundException(`Category ${input.categoryId} not found`);
    }

    const [updated] = await this.db
      .update(accFixedAssets)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(accFixedAssets.id, assetId), eq(accFixedAssets.orgId, orgId)))
      .returning();

    await this.cache.invalidateNamespace(CACHE_KEYS.finAssetsListNamespace(orgId));
    return updated;
  }

  async activate(u: CurrentUserContext, assetId: number) {
    const asset = await this.findOrThrow(u.orgId, assetId);
    if (asset.status !== "DRAFT") {
      throw new BadRequestException(`Asset is already ${asset.status}`);
    }

    const scheduleRows = this.buildStraightLineSchedule(asset);

    await this.db.transaction(async (tx) => {
      await tx
        .update(accFixedAssets)
        .set({ status: "ACTIVE", updatedAt: new Date() })
        .where(and(eq(accFixedAssets.id, assetId), eq(accFixedAssets.orgId, u.orgId)));

      if (scheduleRows.length > 0) {
        await tx.insert(accDepreciationSchedules).values(
          scheduleRows.map((r) => ({
            orgId: u.orgId,
            assetId,
            periodKey: r.periodKey,
            amount: r.amount,
            status: "SCHEDULED" as const,
          })),
        );
      }

      if (asset.billId) {
        const assetAccountCode = await this.resolveAccountCode(u.orgId, asset.categoryId, "asset", tx);
        const expenseClearingCode = await this.resolveSystemPurposeCode(u.orgId, "EXPENSE_CLEARING", tx);
        const cost = Number(asset.acquisitionCost);
        await this.posting.persistJournalEntry(
          {
            orgId: u.orgId,
            entryDate: asset.acquisitionDate,
            description: `Capitalize asset ${asset.assetNumber} from bill ${asset.billId}`,
            sourceType: "ASSET",
            sourceId: String(assetId),
            sourceEvent: "capitalize",
            createdBy: u.userId,
            lines: [
              { accountCode: assetAccountCode, debit: cost, credit: 0 },
              { accountCode: expenseClearingCode, debit: 0, credit: cost },
            ],
          },
          tx,
        );
      }
    });

    this.audit.log({
      action: "ACTIVATE",
      orgId: u.orgId,
      userId: u.userId,
      resourceType: "fixed_asset",
      resourceId: String(assetId),
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.finAssetsListNamespace(u.orgId));
    return this.getOne(u.orgId, assetId);
  }

  async dispose(u: CurrentUserContext, assetId: number, input: DisposeAssetInput) {
    const asset = await this.findOrThrow(u.orgId, assetId);
    if (asset.status !== "ACTIVE" && asset.status !== "FULLY_DEPRECIATED") {
      throw new BadRequestException(`Cannot dispose an asset with status ${asset.status}`);
    }

    const assetAccountCode = await this.resolveAccountCode(u.orgId, asset.categoryId, "asset", this.db);
    const accumDepCode = await this.resolveAccountCode(u.orgId, asset.categoryId, "accumDep", this.db);
    const bankClearingCode = await this.resolveSystemPurposeCode(u.orgId, "BANK_CLEARING", this.db);
    const gainLossCode = await this.resolveSystemPurposeCode(u.orgId, "ASSET_DISPOSAL_GAIN_LOSS", this.db);

    const cost = Number(asset.acquisitionCost);
    const accumulated = Number(asset.accumulatedDepreciation);
    const proceeds = Number(input.amount);
    const bookValue = cost - accumulated;
    const gainLoss = proceeds - bookValue;

    const lines: DraftLine[] = [
      { accountCode: bankClearingCode, debit: proceeds, credit: 0, description: "Disposal proceeds" },
      { accountCode: accumDepCode, debit: accumulated, credit: 0, description: "Remove accumulated depreciation" },
      { accountCode: assetAccountCode, debit: 0, credit: cost, description: "Remove asset cost" },
    ];

    if (gainLoss > 0) {
      lines.push({ accountCode: gainLossCode, debit: 0, credit: gainLoss, description: "Gain on disposal" });
    } else if (gainLoss < 0) {
      lines.push({ accountCode: gainLossCode, debit: Math.abs(gainLoss), credit: 0, description: "Loss on disposal" });
    }

    const entry = await this.db.transaction(async (tx) => {
      const posted = await this.posting.persistJournalEntry(
        {
          orgId: u.orgId,
          entryDate: input.disposalDate,
          description: `Disposal of asset ${asset.assetNumber}`,
          sourceType: "ASSET",
          sourceId: String(assetId),
          sourceEvent: "dispose",
          createdBy: u.userId,
          lines: this.balanceDisposalLines(lines),
        },
        tx,
      );

      await tx
        .update(accDepreciationSchedules)
        .set({ status: "POSTED" })
        .where(
          and(
            eq(accDepreciationSchedules.assetId, assetId),
            eq(accDepreciationSchedules.status, "SCHEDULED"),
          ),
        );

      await tx
        .update(accFixedAssets)
        .set({
          status: "DISPOSED",
          disposedAt: new Date(input.disposalDate),
          disposalAmount: input.amount,
          disposalJournalEntryId: posted.id,
          updatedAt: new Date(),
        })
        .where(and(eq(accFixedAssets.id, assetId), eq(accFixedAssets.orgId, u.orgId)));

      return posted;
    });

    this.audit.log({
      action: "DISPOSE",
      orgId: u.orgId,
      userId: u.userId,
      resourceType: "fixed_asset",
      resourceId: String(assetId),
      metadata: { disposalDate: input.disposalDate, amount: input.amount },
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.finAssetsListNamespace(u.orgId));
    return { assetId, journalEntryId: entry.id, entryNumber: entry.entryNumber };
  }

  async findOrThrow(orgId: string, assetId: number) {
    const [row] = await this.db
      .select()
      .from(accFixedAssets)
      .where(and(eq(accFixedAssets.id, assetId), eq(accFixedAssets.orgId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundException(`Asset ${assetId} not found`);
    return row;
  }

  private buildStraightLineSchedule(
    asset: typeof accFixedAssets.$inferSelect,
  ): Array<{ periodKey: string; amount: string }> {
    const cost = Number(asset.acquisitionCost);
    const salvage = Number(asset.salvageValue);
    const months = asset.usefulLifeMonths;
    const depreciable = cost - salvage;
    if (depreciable <= 0 || months <= 0) return [];

    const monthly = Math.floor((depreciable / months) * 10000) / 10000;
    const rows: Array<{ periodKey: string; amount: string }> = [];
    const parts = asset.acquisitionDate.split("-").map(Number);
    const startYear = parts[0] ?? 2000;
    const startMonth = parts[1] ?? 1;

    let totalAllocated = 0;
    for (let i = 0; i < months; i++) {
      const m = ((startMonth - 1 + i) % 12) + 1;
      const y = startYear + Math.floor((startMonth - 1 + i) / 12);
      const periodKey = `${y}-${String(m).padStart(2, "0")}`;
      const isLast = i === months - 1;
      const amount = isLast
        ? String(Math.round((depreciable - totalAllocated) * 10000) / 10000)
        : String(monthly);
      totalAllocated += monthly;
      rows.push({ periodKey, amount });
    }
    return rows;
  }

  private balanceDisposalLines(lines: DraftLine[]): DraftLine[] {
    const debit = lines.reduce((s, l) => s + l.debit, 0);
    const credit = lines.reduce((s, l) => s + l.credit, 0);
    const diff = Math.round((debit - credit) * 10000) / 10000;
    if (Math.abs(diff) < 0.0001) return lines;
    const lastLine = lines[lines.length - 1];
    if (!lastLine) return lines;
    return [
      ...lines.slice(0, -1),
      {
        ...lastLine,
        debit: diff > 0 ? lastLine.debit : lastLine.debit + Math.abs(diff),
        credit: diff < 0 ? lastLine.credit : lastLine.credit + diff,
      },
    ];
  }

  private async resolveAccountCode(
    orgId: string,
    categoryId: number,
    field: "asset" | "accumDep",
    executor: DbOrTx,
  ): Promise<string> {
    const [cat] = await executor
      .select({
        assetAccountId: accAssetCategories.assetAccountId,
        accumDepAccountId: accAssetCategories.accumulatedDepreciationAccountId,
      })
      .from(accAssetCategories)
      .where(and(eq(accAssetCategories.id, categoryId), eq(accAssetCategories.orgId, orgId)))
      .limit(1);
    if (!cat) throw new UnprocessableEntityException(`Category ${categoryId} not found`);
    const accountId = field === "asset" ? cat.assetAccountId : cat.accumDepAccountId;
    const [acct] = await executor
      .select({ code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.orgId, orgId)))
      .limit(1);
    if (!acct) throw new UnprocessableEntityException(`Ledger account for category ${categoryId} not found`);
    return acct.code;
  }

  private async resolveSystemPurposeCode(
    orgId: string,
    purpose: SystemAccountPurpose,
    executor: DbOrTx,
  ): Promise<string> {
    const [map] = await executor
      .select({ accountId: accSystemAccountMap.accountId })
      .from(accSystemAccountMap)
      .where(
        and(
          eq(accSystemAccountMap.orgId, orgId),
          eq(accSystemAccountMap.purpose, purpose),
        ),
      )
      .limit(1);
    if (!map) throw new UnprocessableEntityException(`System account for purpose ${purpose} not configured`);
    const [acct] = await executor
      .select({ code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, map.accountId), eq(ledgerAccounts.orgId, orgId)))
      .limit(1);
    if (!acct) throw new UnprocessableEntityException(`Ledger account for system purpose ${purpose} not found`);
    return acct.code;
  }

  private async nextAssetNumber(orgId: string, tx: TxArg): Promise<string> {
    const seq = await tx
      .insert(accNumberSequences)
      .values({ orgId, entityType: "asset", prefix: "AST-", nextNumber: 2, padding: 5 })
      .onConflictDoUpdate({
        target: [accNumberSequences.orgId, accNumberSequences.entityType],
        set: { nextNumber: sql`${accNumberSequences.nextNumber} + 1` },
      })
      .returning();
    const row = seq[0];
    if (!row) throw new Error("Failed to allocate asset number");
    const num = row.nextNumber - 1;
    return `${row.prefix}${String(num).padStart(row.padding, "0")}`;
  }
}
