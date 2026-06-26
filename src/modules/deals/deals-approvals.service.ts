import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { dealApprovalRules, dealApprovals, deals, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type { ApprovalsListInput, CreateApprovalRuleInput } from "./dto/deals.schemas";

@Injectable()
export class DealsApprovalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  listRules(orgId: string) {
    return this.db
      .select()
      .from(dealApprovalRules)
      .where(eq(dealApprovalRules.orgId, orgId))
      .orderBy(desc(dealApprovalRules.createdAt));
  }

  async createRule(orgId: string, input: CreateApprovalRuleInput) {
    const [rule] = await this.db
      .insert(dealApprovalRules)
      .values({
        orgId,
        minValue: input.minValue,
        approverRole: input.approverRole,
      })
      .returning();
    return rule;
  }

  listApprovals(orgId: string, query: ApprovalsListInput) {
    return this.cache.cached(
      CACHE_KEYS.approvalsList(orgId),
      () => {
        const conditions = [eq(dealApprovals.orgId, orgId)];
        if (query.status) conditions.push(eq(dealApprovals.status, query.status));

        return this.db
          .select({
            id: dealApprovals.id,
            dealId: dealApprovals.dealId,
            dealName: deals.name,
            dealValue: deals.value,
            requestedBy: dealApprovals.requestedBy,
            requesterName: users.name,
            requestedStage: dealApprovals.requestedStage,
            status: dealApprovals.status,
            rejectionReason: dealApprovals.rejectionReason,
            createdAt: dealApprovals.createdAt,
            resolvedAt: dealApprovals.resolvedAt,
          })
          .from(dealApprovals)
          .leftJoin(deals, eq(dealApprovals.dealId, deals.id))
          .leftJoin(users, eq(dealApprovals.requestedBy, users.id))
          .where(and(...conditions))
          .orderBy(desc(dealApprovals.createdAt))
          .limit(query.limit ?? 20);
      },
      CACHE_TTL.MEDIUM,
    );
  }
}
