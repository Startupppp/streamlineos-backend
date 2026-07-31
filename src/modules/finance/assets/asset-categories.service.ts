import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { and, count, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { paginateOffset, buildListResponse } from "../../../common/pagination/pagination";
import { accAssetCategories } from "../../../db/schema/accounting/finance-assets";
import { ledgerAccounts } from "../../../db/schema/accounting/accounting";
import type { CreateCategoryInput, ListCategoriesQuery, UpdateCategoryInput } from "./dto/assets.schemas";

@Injectable()
export class AssetCategoriesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async list(orgId: string, query: ListCategoriesQuery) {
    const cacheKey = `fin:asset-categories:${orgId}:${query.page}:${query.pageSize}`;
    return this.cache.cached(cacheKey, async () => {
      const { limit, offset } = paginateOffset(query);
      const where = eq(accAssetCategories.orgId, orgId);
      const [items, totals] = await Promise.all([
        this.db
          .select()
          .from(accAssetCategories)
          .where(where)
          .limit(limit)
          .offset(offset),
        this.db.select({ c: count() }).from(accAssetCategories).where(where),
      ]);
      return buildListResponse(items, Number(totals[0]?.c ?? 0), query);
    }, 300);
  }

  async create(orgId: string, input: CreateCategoryInput) {
    await this.validateAccountLinks(orgId, input);
    try {
      const [row] = await this.db
        .insert(accAssetCategories)
        .values({
          orgId,
          name: input.name,
          assetAccountId: input.assetAccountId,
          depreciationExpenseAccountId: input.depreciationExpenseAccountId,
          accumulatedDepreciationAccountId: input.accumulatedDepreciationAccountId,
          defaultMethod: input.defaultMethod,
          defaultUsefulLifeMonths: input.defaultUsefulLifeMonths ?? null,
        })
        .returning();
      await this.cache.invalidatePattern(`fin:asset-categories:${orgId}:*`);
      return row;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("uniq_acc_asset_categories_org_name") || msg.includes("23505")) {
        throw new ConflictException(`Category name '${input.name}' already exists`);
      }
      throw error;
    }
  }

  async update(orgId: string, categoryId: number, input: UpdateCategoryInput) {
    const existing = await this.findOrThrow(orgId, categoryId);
    if (input.assetAccountId || input.depreciationExpenseAccountId || input.accumulatedDepreciationAccountId) {
      await this.validateAccountLinks(orgId, {
        assetAccountId: input.assetAccountId ?? existing.assetAccountId,
        depreciationExpenseAccountId: input.depreciationExpenseAccountId ?? existing.depreciationExpenseAccountId,
        accumulatedDepreciationAccountId: input.accumulatedDepreciationAccountId ?? existing.accumulatedDepreciationAccountId,
        name: input.name ?? existing.name,
        defaultMethod: input.defaultMethod ?? existing.defaultMethod,
      });
    }
    try {
      const [row] = await this.db
        .update(accAssetCategories)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(accAssetCategories.id, categoryId), eq(accAssetCategories.orgId, orgId)))
        .returning();
      await this.cache.invalidatePattern(`fin:asset-categories:${orgId}:*`);
      return row;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("uniq_acc_asset_categories_org_name") || msg.includes("23505")) {
        throw new ConflictException(`Category name '${input.name}' already exists`);
      }
      throw error;
    }
  }

  async findOrThrow(orgId: string, categoryId: number) {
    const [row] = await this.db
      .select()
      .from(accAssetCategories)
      .where(and(eq(accAssetCategories.id, categoryId), eq(accAssetCategories.orgId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundException(`Asset category ${categoryId} not found`);
    return row;
  }

  private async validateAccountLinks(
    orgId: string,
    input: Pick<CreateCategoryInput, "assetAccountId" | "depreciationExpenseAccountId" | "accumulatedDepreciationAccountId" | "name" | "defaultMethod">,
  ) {
    const ids = [input.assetAccountId, input.depreciationExpenseAccountId, input.accumulatedDepreciationAccountId];
    const accounts = await this.db
      .select({ id: ledgerAccounts.id, accountType: ledgerAccounts.accountType })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.orgId, orgId));
    const map = new Map(accounts.map((a) => [a.id, a.accountType]));
    for (const id of ids) {
      if (!map.has(id)) {
        throw new UnprocessableEntityException(`Ledger account ${id} not found in this org`);
      }
    }
  }
}
