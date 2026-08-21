import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { crmDealCompetitors, deals } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { CreateCompetitorInput, UpdateCompetitorInput } from "./dto/deals.schemas";

@Injectable()
export class DealsCompetitorsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, dealId: number) {
    await this.assertDealAccess(orgId, dealId);
    return this.db
      .select()
      .from(crmDealCompetitors)
      .where(and(eq(crmDealCompetitors.orgId, orgId), eq(crmDealCompetitors.dealId, dealId)))
      .orderBy(crmDealCompetitors.createdAt)
      .limit(100);
  }

  async create(orgId: string, dealId: number, input: CreateCompetitorInput) {
    await this.assertDealAccess(orgId, dealId);
    try {
      const [row] = await this.db
        .insert(crmDealCompetitors)
        .values({ orgId, dealId, ...input })
        .returning();
      return row;
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        throw new ConflictException(`Competitor "${input.competitorKey}" already tracked on this deal`);
      }
      throw err;
    }
  }

  async update(orgId: string, dealId: number, competitorId: string, input: UpdateCompetitorInput) {
    await this.assertDealAccess(orgId, dealId);
    const [row] = await this.db
      .update(crmDealCompetitors)
      .set(input)
      .where(
        and(
          eq(crmDealCompetitors.id, competitorId),
          eq(crmDealCompetitors.orgId, orgId),
          eq(crmDealCompetitors.dealId, dealId),
        ),
      )
      .returning();
    if (!row) throw new NotFoundException("Competitor not found");
    return row;
  }

  async remove(orgId: string, dealId: number, competitorId: string) {
    await this.assertDealAccess(orgId, dealId);
    const [row] = await this.db
      .delete(crmDealCompetitors)
      .where(
        and(
          eq(crmDealCompetitors.id, competitorId),
          eq(crmDealCompetitors.orgId, orgId),
          eq(crmDealCompetitors.dealId, dealId),
        ),
      )
      .returning({ id: crmDealCompetitors.id });
    if (!row) throw new NotFoundException("Competitor not found");
    return { success: true };
  }

  private async assertDealAccess(orgId: string, dealId: number) {
    const row = await this.db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)))
      .limit(1);
    if (!row[0]) throw new NotFoundException("Deal not found");
  }
}
