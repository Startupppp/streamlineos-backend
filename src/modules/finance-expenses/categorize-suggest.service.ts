import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { expenses, expenseCategories } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import type { CategorizeSuggestInput } from "./dto/categorize-suggest.schemas";

const SUGGEST_TTL = 120;
const MIN_SAMPLES = 2;

function normalizeMerchant(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

@Injectable()
export class CategorizeSuggestService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async suggest(
    orgId: string,
    input: CategorizeSuggestInput,
  ): Promise<{ categoryId: number | null; categoryName: string | null; confidence: number; basis: "history" | "none" }> {
    const normalized = normalizeMerchant(input.merchant);
    const cacheKey = `fin:cat-suggest:${orgId}:${normalized}`;

    return this.cache.cached(cacheKey, () => this.computeSuggestion(orgId, normalized), SUGGEST_TTL);
  }

  private async computeSuggestion(
    orgId: string,
    normalizedMerchant: string,
  ): Promise<{ categoryId: number | null; categoryName: string | null; confidence: number; basis: "history" | "none" }> {
    const rows = await this.db
      .select({
        categoryId: expenses.categoryId,
        categoryName: expenseCategories.name,
        cnt: sql<string>`count(*)`,
      })
      .from(expenses)
      .leftJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .where(
        and(
          eq(expenses.orgId, orgId),
          isNotNull(expenses.categoryId),
          sql`lower(trim(${expenses.merchant})) = ${normalizedMerchant}`,
        ),
      )
      .groupBy(expenses.categoryId, expenseCategories.name)
      .orderBy(desc(sql`count(*)`))
      .limit(10);

    const total = rows.reduce((acc, r) => acc + Number(r.cnt ?? 0), 0);

    if (total < MIN_SAMPLES || rows.length === 0) {
      return { categoryId: null, categoryName: null, confidence: 0, basis: "none" };
    }

    const top = rows[0]!;
    const topCount = Number(top.cnt ?? 0);
    const confidence = topCount / total;

    return {
      categoryId: top.categoryId,
      categoryName: top.categoryName ?? null,
      confidence: Math.round(confidence * 100) / 100,
      basis: "history",
    };
  }
}
