import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { leavePolicies } from "../../db/schema";
import { eq, and, desc } from "drizzle-orm";

export interface CreateLeavePolicyInput {
  leaveTypeId: number;
  name: string;
  accrualType?: string;
  accrualRate: string;
  maxBalance?: string;
  carryForwardDays?: string;
  carryForwardExpiryMonths?: number;
  encashable?: boolean;
  probationRestricted?: boolean;
  genderRestriction?: string;
  appliesTo?: string;
  effectiveFrom: string;
  effectiveTo?: string;
  isActive?: boolean;
}

export type UpdateLeavePolicyInput = Partial<CreateLeavePolicyInput>;

@Injectable()
export class LeavePoliciesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string) {
    return this.db
      .select()
      .from(leavePolicies)
      .where(eq(leavePolicies.orgId, orgId))
      .orderBy(desc(leavePolicies.createdAt))
      .limit(100);
  }

  async create(orgId: string, data: CreateLeavePolicyInput) {
    const [policy] = await this.db
      .insert(leavePolicies)
      .values({
        orgId,
        leaveTypeId: data.leaveTypeId,
        name: data.name,
        accrualType: data.accrualType ?? "ANNUAL",
        accrualRate: data.accrualRate,
        maxBalance: data.maxBalance,
        carryForwardDays: data.carryForwardDays ?? "0",
        carryForwardExpiryMonths: data.carryForwardExpiryMonths,
        encashable: data.encashable ?? false,
        probationRestricted: data.probationRestricted ?? false,
        genderRestriction: data.genderRestriction,
        appliesTo: data.appliesTo ?? "ALL",
        effectiveFrom: data.effectiveFrom,
        effectiveTo: data.effectiveTo,
        isActive: data.isActive ?? true,
      })
      .returning();
    return policy;
  }

  async update(orgId: string, id: number, data: UpdateLeavePolicyInput) {
    const [policy] = await this.db
      .update(leavePolicies)
      .set(data)
      .where(and(eq(leavePolicies.id, id), eq(leavePolicies.orgId, orgId)))
      .returning();
    if (!policy) throw new NotFoundException("Leave policy not found");
    return policy;
  }

  async remove(orgId: string, id: number) {
    await this.db
      .update(leavePolicies)
      .set({ isActive: false })
      .where(and(eq(leavePolicies.id, id), eq(leavePolicies.orgId, orgId)));
  }
}
