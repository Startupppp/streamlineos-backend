import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  hrLeavePolicyTemplateDismissals,
  leavePolicies,
  leaveTypes,
  organizationMembers,
} from "../../../db/schema";
import {
  LEAVE_POLICY_TEMPLATES,
  normalizeLeaveTypeName,
  templateByKey,
  type LeavePolicyTemplateKey,
} from "./leave-policy-templates";

export interface LeavePolicyTemplateImportItem {
  key: LeavePolicyTemplateKey;
  leaveTypeName: string;
  policyName: string;
  daysPerYear: number;
  carryForward: boolean;
  accrualType: string;
  accrualRate: string;
  maxBalance?: string;
  carryForwardDays: string;
  encashable: boolean;
  probationRestricted: boolean;
  effectiveFrom: string;
}

export interface LeavePolicyTemplateOffer {
  templates: typeof LEAVE_POLICY_TEMPLATES;
  /** Names already present in this organisation, matched case- and space-insensitively. */
  alreadyPresent: LeavePolicyTemplateKey[];
  dismissedAt: string | null;
  policyCount: number;
  /** The one flag the client acts on: offer the templates, or say nothing. */
  shouldOffer: boolean;
}

@Injectable()
export class LeavePolicyTemplatesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async offer(orgId: string): Promise<LeavePolicyTemplateOffer> {
    const [dismissedAt, existingTypes, policies] = await Promise.all([
      this.dismissedAt(orgId),
      this.db
        .select({ id: leaveTypes.id, name: leaveTypes.name })
        .from(leaveTypes)
        .where(eq(leaveTypes.orgId, orgId))
        .limit(100),
      this.db
        .select({ id: leavePolicies.id })
        .from(leavePolicies)
        .where(eq(leavePolicies.orgId, orgId))
        .limit(1),
    ]);

    const present = new Set(existingTypes.map((row) => normalizeLeaveTypeName(row.name)));
    const alreadyPresent = LEAVE_POLICY_TEMPLATES.filter((template) =>
      present.has(normalizeLeaveTypeName(template.leaveTypeName)),
    ).map((template) => template.key);

    return {
      templates: LEAVE_POLICY_TEMPLATES,
      alreadyPresent,
      dismissedAt,
      policyCount: policies.length,
      // First visit means: nothing configured and nobody has refused. An
      // organisation that already has a policy is past being offered a starting
      // point, and a refusal is permanent.
      shouldOffer:
        dismissedAt === null &&
        policies.length === 0 &&
        alreadyPresent.length < LEAVE_POLICY_TEMPLATES.length,
    };
  }

  /**
   * Permanent, per organisation, and idempotent: a second "Not now" from another
   * administrator keeps the first refusal's timestamp rather than creating a
   * second row or moving the date.
   */
  async dismiss(orgId: string, userId: string): Promise<{ dismissedAt: string }> {
    const [membership] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);
    const membershipId = membership?.id ?? null;

    const [row] = await this.db
      .insert(hrLeavePolicyTemplateDismissals)
      .values({ orgId, dismissedByMembershipId: membershipId })
      .onConflictDoNothing({ target: hrLeavePolicyTemplateDismissals.orgId })
      .returning({ dismissedAt: hrLeavePolicyTemplateDismissals.dismissedAt });

    if (row) return { dismissedAt: row.dismissedAt.toISOString() };

    const existing = await this.dismissedAt(orgId);
    return { dismissedAt: existing ?? new Date().toISOString() };
  }

  /**
   * Creates the leave types the selected templates need and one policy each,
   * inside the request transaction. Re-running it adds nothing: an existing
   * leave type of the same name is reused, and a leave type that already carries
   * a policy is skipped rather than given a second one.
   */
  async importTemplates(
    orgId: string,
    items: LeavePolicyTemplateImportItem[],
  ): Promise<{ created: number; skipped: LeavePolicyTemplateKey[] }> {
    if (items.length === 0) return { created: 0, skipped: [] };

    const existingTypes = await this.db
      .select({ id: leaveTypes.id, name: leaveTypes.name })
      .from(leaveTypes)
      .where(eq(leaveTypes.orgId, orgId))
      .limit(100);
    const typeIdByName = new Map(
      existingTypes.map((row) => [normalizeLeaveTypeName(row.name), row.id]),
    );

    const existingTypeIds = existingTypes.map((row) => row.id);
    const policiedTypeIds = new Set(
      existingTypeIds.length === 0
        ? []
        : (
            await this.db
              .select({ leaveTypeId: leavePolicies.leaveTypeId })
              .from(leavePolicies)
              .where(
                and(
                  eq(leavePolicies.orgId, orgId),
                  inArray(leavePolicies.leaveTypeId, existingTypeIds),
                ),
              )
              .limit(100)
          ).map((row) => row.leaveTypeId),
    );

    for (const item of items) templateByKey(item.key);

    const missingByName = new Map<string, LeavePolicyTemplateImportItem>();
    for (const item of items) {
      const normalized = normalizeLeaveTypeName(item.leaveTypeName);
      if (!typeIdByName.has(normalized) && !missingByName.has(normalized))
        missingByName.set(normalized, item);
    }
    if (missingByName.size > 0) {
      const missing = [...missingByName.values()];
      const inserted = await this.db
        .insert(leaveTypes)
        .values(
          missing.map((item) => ({
            orgId,
            name: item.leaveTypeName,
            daysPerYear: item.daysPerYear,
            carryForward: item.carryForward,
          })),
        )
        .onConflictDoNothing({
          target: [leaveTypes.orgId, leaveTypes.name],
        })
        .returning({ id: leaveTypes.id, name: leaveTypes.name });
      for (const row of inserted) typeIdByName.set(normalizeLeaveTypeName(row.name), row.id);

      const racedNames = missing
        .map((item) => item.leaveTypeName)
        .filter((name) => !typeIdByName.has(normalizeLeaveTypeName(name)));
      if (racedNames.length > 0) {
        const raced = await this.db
          .select({ id: leaveTypes.id, name: leaveTypes.name })
          .from(leaveTypes)
          .where(and(eq(leaveTypes.orgId, orgId), inArray(leaveTypes.name, racedNames)))
          .limit(racedNames.length);
        for (const row of raced) typeIdByName.set(normalizeLeaveTypeName(row.name), row.id);
      }
    }

    const skipped: LeavePolicyTemplateKey[] = [];
    const policies: (typeof leavePolicies.$inferInsert)[] = [];
    for (const item of items) {
      const leaveTypeId = typeIdByName.get(normalizeLeaveTypeName(item.leaveTypeName));
      if (leaveTypeId === undefined || policiedTypeIds.has(leaveTypeId)) {
        skipped.push(item.key);
        continue;
      }
      policies.push({
        orgId,
        leaveTypeId,
        name: item.policyName,
        accrualType: item.accrualType,
        accrualRate: item.accrualRate,
        maxBalance: item.maxBalance,
        carryForwardDays: item.carryForwardDays,
        encashable: item.encashable,
        probationRestricted: item.probationRestricted,
        appliesTo: "ALL",
        effectiveFrom: item.effectiveFrom,
        isActive: true,
      });
      policiedTypeIds.add(leaveTypeId);
    }
    if (policies.length > 0) await this.db.insert(leavePolicies).values(policies);
    const created = policies.length;

    return { created, skipped };
  }

  private async dismissedAt(orgId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ dismissedAt: hrLeavePolicyTemplateDismissals.dismissedAt })
      .from(hrLeavePolicyTemplateDismissals)
      .where(eq(hrLeavePolicyTemplateDismissals.orgId, orgId))
      .limit(1);
    return row?.dismissedAt.toISOString() ?? null;
  }
}
