import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { crmDealCompetitors, deals } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { CreateCompetitorInput, UpdateCompetitorInput } from "./dto/deals.schemas";
import { isUniqueViolation } from "../../common/db/postgres-error";

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
      /**
       * Read through the wrapper, not off the top of the error.
       *
       * This branch used to compare `(err as { code?: string }).code`, which is
       * never set: Drizzle wraps driver errors in `DrizzleQueryError` and leaves
       * the SQLSTATE on `.cause`. So adding a competitor already on the deal --
       * the one collision `uq_crm_deal_competitors_deal_key` exists to catch --
       * fell through as an unhandled 500 rather than the 409 the message here
       * was written for, and the frontend showed a generic failure for a
       * situation the user could have resolved by reading it.
       */
      if (isUniqueViolation(err)) {
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
