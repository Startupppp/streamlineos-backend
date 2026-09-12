import { BadRequestException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { payrollPolicyVersions } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertBelongsToOrg, RISKY_TOGGLES } from "./lib/policy-builders";
import { normalizePayrollToggles, toPayrollPolicyConfig } from "../dto/payroll.schemas";
import { DEFAULT_PAYROLL_POLICY_CONFIG } from "./payroll-policy-defaults.constants";
import { isPayrollToggleKey, type PayrollToggles, type PayrollPolicyConfig } from "../payroll.types";
import type { CreatePolicyVersionInput } from "./dto/setup.schemas";

export async function buildPolicyVersion(
  db: Db,
  u: CurrentUserContext,
  policyId: number,
  input: CreatePolicyVersionInput,
) {
  const policy = await assertBelongsToOrg(db, u.orgId, policyId);
  if (policy.status !== "ACTIVE") {
    throw new BadRequestException("Policy must be ACTIVE before creating a new version");
  }

  const activeVersion = policy.activeVersionId
    ? await db.query.payrollPolicyVersions.findFirst({
        where: and(
          eq(payrollPolicyVersions.id, policy.activeVersionId),
          eq(payrollPolicyVersions.orgId, u.orgId),
        ),
      })
    : null;

  const newToggles: PayrollToggles = {
    ...normalizePayrollToggles(activeVersion?.toggles),
    ...(input.toggleOverrides ?? {}),
  };

  const baseConfig = toPayrollPolicyConfig(activeVersion?.config) ?? DEFAULT_PAYROLL_POLICY_CONFIG;
  const newConfig: PayrollPolicyConfig = { ...baseConfig, ...(input.config ?? {}) };

  const hasRiskyChange = input.toggleOverrides
    ? Object.keys(input.toggleOverrides).some((k) => isPayrollToggleKey(k) && RISKY_TOGGLES.has(k))
    : false;

  if (hasRiskyChange && !input.reason) {
    throw new BadRequestException(
      "A reason is required when changing statutory or workflow toggles",
    );
  }

  const versionsResult = await db
    .select({
      maxVersion: sql<number>`COALESCE(MAX(${payrollPolicyVersions.version}), 0)`,
    })
    .from(payrollPolicyVersions)
    .where(eq(payrollPolicyVersions.policyId, policyId));

  const nextVersion = (versionsResult[0]?.maxVersion ?? 0) + 1;

  const [newVersion] = await db
    .insert(payrollPolicyVersions)
    .values({
      orgId: u.orgId,
      policyId,
      version: nextVersion,
      templateKey: activeVersion?.templateKey ?? undefined,
      toggles: newToggles,
      config: newConfig,
      status: "DRAFT",
      effectiveFrom: input.effectiveFrom,
      reason: input.reason,
      createdBy: u.userId,
    })
    .returning();

  return newVersion;
}
