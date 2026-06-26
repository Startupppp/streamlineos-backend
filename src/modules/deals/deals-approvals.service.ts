import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { dealApprovalRules, dealApprovals, deals, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { NotificationsService } from "../notifications/notifications.service";
import { dealStageSchema } from "./dto/deals.schemas";
import type {
  ApprovalsListInput,
  CreateApprovalRuleInput,
  RequestApprovalInput,
  ResolveApprovalInput,
} from "./dto/deals.schemas";

@Injectable()
export class DealsApprovalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly notifications: NotificationsService,
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

  async resolveApproval(orgId: string, actorUserId: string, input: ResolveApprovalInput) {
    const [updated] = await this.db
      .update(dealApprovals)
      .set({
        status: input.action === "approve" ? "approved" : "rejected",
        approvedBy: actorUserId,
        rejectionReason: input.action === "reject" ? input.rejectionReason ?? null : null,
        resolvedAt: new Date(),
      })
      .where(and(eq(dealApprovals.id, input.approvalId), eq(dealApprovals.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Approval not found");

    if (input.action === "approve") {
      await this.db
        .update(deals)
        .set({ stage: dealStageSchema.parse(updated.requestedStage), updatedAt: new Date() })
        .where(eq(deals.id, updated.dealId));
    }

    await this.notifications.create({
      orgId,
      userId: updated.requestedBy,
      type: "INFO",
      title: input.action === "approve" ? "Deal approved" : "Deal approval rejected",
      message:
        input.action === "approve"
          ? `Your deal has been approved to move to ${updated.requestedStage}`
          : `Your deal approval was rejected: ${input.rejectionReason || "No reason given"}`,
      link: `/crm/deals/${updated.dealId}`,
    });

    await this.cache.invalidate(CACHE_KEYS.approvalsList(orgId));
    return updated;
  }

  async requestApproval(orgId: string, actorUserId: string, input: RequestApprovalInput) {
    const [deal] = await this.db
      .select({ id: deals.id, value: deals.value })
      .from(deals)
      .where(and(eq(deals.id, input.dealId), eq(deals.orgId, orgId)));
    if (!deal) throw new NotFoundException("Deal not found");

    const rules = await this.db
      .select({ id: dealApprovalRules.id, minValue: dealApprovalRules.minValue })
      .from(dealApprovalRules)
      .where(and(eq(dealApprovalRules.orgId, orgId), eq(dealApprovalRules.isActive, true)));

    const needsApproval = rules.some((r) => Number(deal.value ?? 0) >= Number(r.minValue));

    if (!needsApproval) {
      await this.db
        .update(deals)
        .set({ stage: input.requestedStage, updatedAt: new Date() })
        .where(eq(deals.id, input.dealId));
      return { created: false as const, body: { approved: true as const, directUpdate: true as const } };
    }

    const [approval] = await this.db
      .insert(dealApprovals)
      .values({
        orgId,
        dealId: input.dealId,
        requestedBy: actorUserId,
        requestedStage: input.requestedStage,
      })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.approvalsList(orgId));
    return { created: true as const, body: approval };
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
