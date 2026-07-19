import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { hrPolicies, leavePolicies, leaveTypes } from "../../db/schema";
import { and, desc, eq, isNull, lte, gte, or } from "drizzle-orm";

export interface LeavePolicySummary {
  wfhMonthlyQuota: number;
  leaveTypes: Array<{
    name: string;
    daysPerYear: number;
    carryForward: boolean;
    expiresMonthly: boolean;
  }>;
}

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
  genderRestriction?: string | null;
  appliesTo?: string;
  effectiveFrom: string;
  effectiveTo?: string;
  isActive?: boolean;
}

export type UpdateLeavePolicyInput = Partial<CreateLeavePolicyInput>;

const DEFAULT_WFH_MONTHLY_QUOTA = 4;

@Injectable()
export class LeavePoliciesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getOrgSummary(orgId: string): Promise<LeavePolicySummary> {
    const [types, policies, wfhQuota] = await Promise.all([
      this.db
        .select({
          id: leaveTypes.id,
          name: leaveTypes.name,
          daysPerYear: leaveTypes.daysPerYear,
          carryForward: leaveTypes.carryForward,
        })
        .from(leaveTypes)
        .where(eq(leaveTypes.orgId, orgId)),
      this.db
        .select({
          leaveTypeId: leavePolicies.leaveTypeId,
          accrualType: leavePolicies.accrualType,
        })
        .from(leavePolicies)
        .where(and(eq(leavePolicies.orgId, orgId), eq(leavePolicies.isActive, true))),
      this.resolveOrgWfhQuota(orgId),
    ]);

    if (types.length === 0) {
      return {
        wfhMonthlyQuota: wfhQuota,
        leaveTypes: [],
      };
    }

    const policyMap = new Map<number, string>();
    for (const p of policies) {
      if (!policyMap.has(p.leaveTypeId)) policyMap.set(p.leaveTypeId, p.accrualType);
    }

    return {
      wfhMonthlyQuota: wfhQuota,
      leaveTypes: types.map((t) => ({
        name: t.name,
        daysPerYear: t.daysPerYear,
        carryForward: t.carryForward,
        expiresMonthly: policyMap.get(t.id) === "MONTHLY",
      })),
    };
  }

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

  private async resolveOrgWfhQuota(orgId: string): Promise<number> {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const policyRow = await this.db.query.hrPolicies.findFirst({
        where: and(
          eq(hrPolicies.orgId, orgId),
          eq(hrPolicies.policyType, "wfh"),
          eq(hrPolicies.status, "active"),
          isNull(hrPolicies.deletedAt),
          lte(hrPolicies.effectiveFrom, today),
          or(isNull(hrPolicies.effectiveTo), gte(hrPolicies.effectiveTo, today)),
        ),
        columns: { rules: true },
      });
      if (!policyRow) return DEFAULT_WFH_MONTHLY_QUOTA;
      const rules = policyRow.rules as Record<string, unknown>;
      const quota = typeof rules["monthlyQuota"] === "number" ? rules["monthlyQuota"] : null;
      return quota ?? DEFAULT_WFH_MONTHLY_QUOTA;
    } catch {
      return DEFAULT_WFH_MONTHLY_QUOTA;
    }
  }
}
