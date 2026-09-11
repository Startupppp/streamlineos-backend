import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBefore } from "../../../common/pagination/keyset";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { aiCreditPacks, aiCreditTransactions } from "../../../db/schema";
import { DEFAULT_AI_CREDIT_PACKS } from "./ai-credit-packs.constants";
import { milliToCredits } from "../../ai/core/billing/ai-model-pricing.constants";

@Injectable()
export class AiCreditsPacksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listPacks() {
    let packs = await this.db
      .select()
      .from(aiCreditPacks)
      .where(eq(aiCreditPacks.isActive, true))
      .orderBy(aiCreditPacks.sortOrder);

    if (packs.length === 0) {
      await this.ensureDefaultPacks();
      packs = await this.db
        .select()
        .from(aiCreditPacks)
        .where(eq(aiCreditPacks.isActive, true))
        .orderBy(aiCreditPacks.sortOrder);
    }

    return packs;
  }

  private async ensureDefaultPacks() {
    for (const pack of DEFAULT_AI_CREDIT_PACKS) {
      await this.db
        .insert(aiCreditPacks)
        .values({
          name: pack.name,
          credits: pack.credits,
          bonusCredits: pack.bonusCredits,
          priceInPaise: pack.priceInPaise,
          sortOrder: pack.sortOrder,
          isActive: true,
        })
        .onConflictDoNothing({ target: aiCreditPacks.name });
    }
  }

  async listTransactions(orgId: string, query: { cursor?: string; limit: number }) {
    const position = decodeCursor(query.cursor);
    const limit = Math.min(query.limit, 100);
    const conditions = [eq(aiCreditTransactions.orgId, orgId)];
    if (position) {
      conditions.push(keysetBefore(aiCreditTransactions.createdAt, aiCreditTransactions.id, position));
    }

    const items = await this.db
      .select({
        id: aiCreditTransactions.id,
        orgId: aiCreditTransactions.orgId,
        userId: aiCreditTransactions.userId,
        type: aiCreditTransactions.type,
        amount: aiCreditTransactions.amount,
        balanceAfter: aiCreditTransactions.balanceAfter,
        feature: aiCreditTransactions.feature,
        model: aiCreditTransactions.model,
        referenceId: aiCreditTransactions.referenceId,
        createdAt: aiCreditTransactions.createdAt,
        promptTokens: aiCreditTransactions.promptTokens,
        completionTokens: aiCreditTransactions.completionTokens,
        totalTokens: aiCreditTransactions.totalTokens,
        costUsd: aiCreditTransactions.costUsd,
      })
      .from(aiCreditTransactions)
      .where(and(...conditions))
      .orderBy(desc(aiCreditTransactions.createdAt), desc(aiCreditTransactions.id))
      .limit(limit + 1);

    const mappedItems = items.map((t) => ({
      ...t,
      amount: milliToCredits(t.amount),
      balanceAfter: milliToCredits(t.balanceAfter),
    }));

    return buildCursorPage(mappedItems, limit, (transaction) => ({
      sortValue: transaction.createdAt.toISOString(),
      id: String(transaction.id),
    }));
  }

  async hasSameDayPurchaseForPack(orgId: string, packId: number): Promise<boolean> {
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

    const [row] = await this.db
      .select({ id: aiCreditTransactions.id })
      .from(aiCreditTransactions)
      .where(
        and(
          eq(aiCreditTransactions.orgId, orgId),
          eq(aiCreditTransactions.type, "PURCHASE"),
          eq(aiCreditTransactions.referenceId, String(packId)),
          gte(aiCreditTransactions.createdAt, dayStart),
          lt(aiCreditTransactions.createdAt, dayEnd),
        ),
      )
      .limit(1);
    return !!row;
  }

  async hasMonthlyPlanGrant(orgId: string): Promise<boolean> {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const [row] = await this.db
      .select({ id: aiCreditTransactions.id })
      .from(aiCreditTransactions)
      .where(
        and(
          eq(aiCreditTransactions.orgId, orgId),
          eq(aiCreditTransactions.type, "PLAN_GRANT"),
          ne(aiCreditTransactions.feature, "trial-grant"),
          gte(aiCreditTransactions.createdAt, monthStart),
          lt(aiCreditTransactions.createdAt, monthEnd),
        ),
      )
      .limit(1);
    return !!row;
  }

  async getMonthlyGrantedOrgIds(orgIds: string[]): Promise<Set<string>> {
    if (orgIds.length === 0) return new Set();
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const rows = await this.db
      .selectDistinct({ orgId: aiCreditTransactions.orgId })
      .from(aiCreditTransactions)
      .where(
        and(
          eq(aiCreditTransactions.type, "PLAN_GRANT"),
          ne(aiCreditTransactions.feature, "trial-grant"),
          gte(aiCreditTransactions.createdAt, monthStart),
          lt(aiCreditTransactions.createdAt, monthEnd),
          inArray(aiCreditTransactions.orgId, orgIds),
        ),
      );
    return new Set(rows.map((r) => r.orgId));
  }
}
