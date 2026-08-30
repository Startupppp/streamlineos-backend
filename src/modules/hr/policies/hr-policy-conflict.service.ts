import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrPolicies } from "../../../db/schema";

export type PolicyConflict = {
  severity: "blocking" | "warning";
  reason: string;
  policyId: number;
  policyName: string;
  otherPolicyId: number;
  otherPolicyName: string;
  scopeOverlap: Array<{ scopeType: string; scopeValue: string }>;
};

function datesOverlap(
  aFrom: string,
  aTo: string | null,
  bFrom: string,
  bTo: string | null,
): boolean {
  const aEnd = aTo ?? "9999-12-31";
  const bEnd = bTo ?? "9999-12-31";
  return aFrom <= bEnd && bFrom <= aEnd;
}

function scopesOverlap(
  a: Array<{ scopeType: string; scopeValue: string }>,
  b: Array<{ scopeType: string; scopeValue: string }>,
): Array<{ scopeType: string; scopeValue: string }> {
  const aOrg = a.some((s) => s.scopeType === "organization");
  const bOrg = b.some((s) => s.scopeType === "organization");
  if (aOrg || bOrg) {
    return [{ scopeType: "organization", scopeValue: "*" }];
  }
  const bKeys = new Set(b.map((s) => `${s.scopeType}:${s.scopeValue}`));
  return a.filter((s) => bKeys.has(`${s.scopeType}:${s.scopeValue}`));
}

@Injectable()
export class HrPolicyConflictService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async detectConflicts(
    orgId: string,
    policyId: number,
  ): Promise<{ conflicts: PolicyConflict[]; canActivate: boolean }> {
    const policy = await this.db.query.hrPolicies.findFirst({
      where: and(
        eq(hrPolicies.id, policyId),
        eq(hrPolicies.orgId, orgId),
        isNull(hrPolicies.deletedAt),
      ),
      with: { scopes: true },
    });
    if (!policy) {
      return { conflicts: [], canActivate: false };
    }

    const others = await this.db.query.hrPolicies.findMany({
      where: and(
        eq(hrPolicies.orgId, orgId),
        eq(hrPolicies.policyType, policy.policyType),
        eq(hrPolicies.status, "active"),
        ne(hrPolicies.id, policyId),
        isNull(hrPolicies.deletedAt),
      ),
      with: { scopes: true },
      limit: 200,
    });

    const policyScopes = policy.scopes.map((s) => ({
      scopeType: s.scopeType,
      scopeValue: s.scopeValue,
    }));

    const conflicts: PolicyConflict[] = [];

    for (const other of others) {
      if (
        !datesOverlap(
          policy.effectiveFrom,
          policy.effectiveTo,
          other.effectiveFrom,
          other.effectiveTo,
        )
      ) {
        continue;
      }

      const otherScopes = other.scopes.map((s) => ({
        scopeType: s.scopeType,
        scopeValue: s.scopeValue,
      }));
      const overlap = scopesOverlap(policyScopes, otherScopes);
      if (overlap.length === 0) continue;

      const samePriority = other.priority === policy.priority;
      conflicts.push({
        severity: samePriority ? "blocking" : "warning",
        reason: samePriority
          ? "Active policy with overlapping scope and equal priority will produce ambiguous evaluation"
          : "Active policy with overlapping scope; higher priority wins at evaluation time",
        policyId: policy.id,
        policyName: policy.name,
        otherPolicyId: other.id,
        otherPolicyName: other.name,
        scopeOverlap: overlap,
      });
    }

    return {
      conflicts,
      canActivate: !conflicts.some((c) => c.severity === "blocking"),
    };
  }

  async detectOrgConflicts(
    orgId: string,
    policyType?: string,
  ): Promise<{ conflicts: PolicyConflict[] }> {
    const conditions = [
      eq(hrPolicies.orgId, orgId),
      eq(hrPolicies.status, "active"),
      isNull(hrPolicies.deletedAt),
    ];
    if (policyType) {
      conditions.push(sql`${hrPolicies.policyType} = ${policyType}`);
    }

    const active = await this.db.query.hrPolicies.findMany({
      where: and(...conditions),
      with: { scopes: true },
      limit: 200,
    });

    const conflicts: PolicyConflict[] = [];
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i];
        const b = active[j];
        if (a.policyType !== b.policyType) continue;
        if (!datesOverlap(a.effectiveFrom, a.effectiveTo, b.effectiveFrom, b.effectiveTo)) {
          continue;
        }
        const overlap = scopesOverlap(
          a.scopes.map((s) => ({ scopeType: s.scopeType, scopeValue: s.scopeValue })),
          b.scopes.map((s) => ({ scopeType: s.scopeType, scopeValue: s.scopeValue })),
        );
        if (overlap.length === 0) continue;
        const samePriority = a.priority === b.priority;
        conflicts.push({
          severity: samePriority ? "blocking" : "warning",
          reason: samePriority
            ? "Equal priority active policies with overlapping scope"
            : "Overlapping active policies; evaluation uses highest specificity then priority",
          policyId: a.id,
          policyName: a.name,
          otherPolicyId: b.id,
          otherPolicyName: b.name,
          scopeOverlap: overlap,
        });
      }
    }

    return { conflicts };
  }
}
