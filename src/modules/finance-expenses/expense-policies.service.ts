import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { finExpensePolicies } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import type { CreatePolicyInput, UpdatePolicyInput } from "./dto/finance-expenses.schemas";

const POLICY_CACHE_KEY = (orgId: string) => `fin:expense-policies:${orgId}`;

@Injectable()
export class ExpensePoliciesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string) {
    return this.cache.cached(
      POLICY_CACHE_KEY(orgId),
      () =>
        this.db.query.finExpensePolicies.findMany({
          where: eq(finExpensePolicies.orgId, orgId),
          with: { category: true },
          orderBy: (p, { asc }) => [asc(p.name)],
        }),
      300,
    );
  }

  async create(orgId: string, actorUserId: string, input: CreatePolicyInput) {
    const [policy] = await this.db
      .insert(finExpensePolicies)
      .values({
        orgId,
        name: input.name,
        categoryId: input.categoryId ?? null,
        maxAmount: input.maxAmount?.toFixed(2) ?? null,
        requiresReceiptAbove: input.requiresReceiptAbove?.toFixed(2) ?? null,
        requiresApprovalAbove: input.requiresApprovalAbove?.toFixed(2) ?? null,
        isActive: input.isActive,
      })
      .returning();

    if (!policy) throw new BadRequestException("Failed to create expense policy");

    this.audit.log({
      action: "fin.expense_policy.created",
      userId: actorUserId,
      orgId,
      targetId: String(policy.id),
      targetType: "fin_expense_policy",
      metadata: { name: input.name },
    });

    await this.cache.invalidatePattern(`fin:expense-policies:${orgId}*`);

    return policy;
  }

  async update(orgId: string, actorUserId: string, policyId: number, input: UpdatePolicyInput) {
    const existing = await this.db.query.finExpensePolicies.findFirst({
      where: and(eq(finExpensePolicies.id, policyId), eq(finExpensePolicies.orgId, orgId)),
      columns: { id: true },
    });

    if (!existing) throw new NotFoundException("Expense policy not found");

    await this.db
      .update(finExpensePolicies)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
        ...(input.maxAmount !== undefined && { maxAmount: input.maxAmount.toFixed(2) }),
        ...(input.requiresReceiptAbove !== undefined && { requiresReceiptAbove: input.requiresReceiptAbove.toFixed(2) }),
        ...(input.requiresApprovalAbove !== undefined && { requiresApprovalAbove: input.requiresApprovalAbove.toFixed(2) }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        updatedAt: new Date(),
      })
      .where(and(eq(finExpensePolicies.id, policyId), eq(finExpensePolicies.orgId, orgId)));

    this.audit.log({
      action: "fin.expense_policy.updated",
      userId: actorUserId,
      orgId,
      targetId: String(policyId),
      targetType: "fin_expense_policy",
    });

    await this.cache.invalidatePattern(`fin:expense-policies:${orgId}*`);

    return { success: true };
  }

  async remove(orgId: string, actorUserId: string, policyId: number) {
    const existing = await this.db.query.finExpensePolicies.findFirst({
      where: and(eq(finExpensePolicies.id, policyId), eq(finExpensePolicies.orgId, orgId)),
      columns: { id: true },
    });

    if (!existing) throw new NotFoundException("Expense policy not found");

    await this.db
      .delete(finExpensePolicies)
      .where(and(eq(finExpensePolicies.id, policyId), eq(finExpensePolicies.orgId, orgId)));

    this.audit.log({
      action: "fin.expense_policy.deleted",
      userId: actorUserId,
      orgId,
      targetId: String(policyId),
      targetType: "fin_expense_policy",
    });

    await this.cache.invalidatePattern(`fin:expense-policies:${orgId}*`);

    return { success: true };
  }
}
