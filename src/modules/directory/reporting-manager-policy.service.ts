import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { DbOrTx } from "../../common/rbac/access-invalidate";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { isStructuralOrgAdmin, isStructuralOrgAdminContext } from "../../common/rbac/is-structural-org-admin";
import { AuditService } from "../../common/audit/audit.service";
import { hrEmployments, hrPeople, hrReportingManagerPolicies, users } from "../../db/schema";
import { AccessService } from "../access/access.service";
import { liveEmployment } from "./employment-query";
import { ReportingLineService } from "./reporting-line.service";
import { readReportingManagerPolicy } from "./reporting-line-queries";
import { ReportingLineException } from "./reporting-line-errors";
import {
  REPORTING_LINE_ERROR_CODES,
  REPORTING_LINE_EVENTS,
  REPORTING_LINE_PERMISSIONS,
  type PermittedActions,
  type ReportingActor,
  type ReportingManagerPolicy,
  type ReportingManagerPolicyPatch,
  type ReportingManagerPolicyView,
} from "./reporting-line.types";

@Injectable()
export class ReportingManagerPolicyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(AccessService) private readonly access: Pick<AccessService, "holds" | "resolveUserPermissions">,
    private readonly reportingLines: ReportingLineService,
    @Inject(AuditService) private readonly audit: Pick<AuditService, "logCritical">,
  ) {}

  /** The org's policy with defaults filled in, and the default manager as a person with live eligibility. */
  async get(orgId: string, db: DbOrTx = this.db): Promise<ReportingManagerPolicyView> {
    const policy = await readReportingManagerPolicy(db, orgId);
    return { ...policy, defaultPrimaryManager: await this.defaultManagerOf(policy, db) };
  }

  async update(actor: CurrentUserContext, patch: ReportingManagerPolicyPatch, tx: DbOrTx): Promise<ReportingManagerPolicyView> {
    const orgId = actor.orgId;
    const before = await readReportingManagerPolicy(tx, orgId);
    if (patch.expectedVersion !== before.version)
      throw new ConflictException({
        code: "CONFLICT",
        message: "Someone else changed the reporting manager policy. Reload it and try again.",
      });

    if (patch.defaultPrimaryManagerUserId) {
      const check = await this.reportingLines.checkManager(orgId, patch.defaultPrimaryManagerUserId, tx);
      if (!check.ok)
        throw new ReportingLineException(
          check.reason === "manager-not-in-organization" ? REPORTING_LINE_ERROR_CODES.MANAGER_NOT_FOUND : REPORTING_LINE_ERROR_CODES.MANAGER_NOT_ELIGIBLE,
          check.message,
          { field: "defaultPrimaryManagerUserId" },
        );
    }

    const next = {
      maxSecondaryManagersPerEmployee: patch.maxSecondaryManagersPerEmployee ?? before.maxSecondaryManagersPerEmployee,
      defaultPrimaryManagerUserId:
        patch.defaultPrimaryManagerUserId === undefined ? before.defaultPrimaryManagerUserId : patch.defaultPrimaryManagerUserId,
      fallbackOrder: patch.fallbackOrder ?? before.fallbackOrder,
      requireReasonAfterChanges: patch.requireReasonAfterChanges ?? before.requireReasonAfterChanges,
      allowTopLevelWithoutManager: patch.allowTopLevelWithoutManager ?? before.allowTopLevelWithoutManager,
      updatedBy: actor.userId,
      updatedAt: new Date(),
    };

    const [written] = await tx
      .insert(hrReportingManagerPolicies)
      .values({ orgId, ...next, version: 1 })
      .onConflictDoUpdate({
        target: hrReportingManagerPolicies.orgId,
        set: { ...next, version: sql`${hrReportingManagerPolicies.version} + 1` },
        setWhere: eq(hrReportingManagerPolicies.version, patch.expectedVersion),
      })
      .returning({ version: hrReportingManagerPolicies.version });
    if (!written)
      throw new ConflictException({
        code: "CONFLICT",
        message: "Someone else changed the reporting manager policy. Reload it and try again.",
      });

    const after = await readReportingManagerPolicy(tx, orgId);
    await this.audit.logCritical({
      action: REPORTING_LINE_EVENTS.POLICY_UPDATED,
      userId: actor.userId,
      orgId,
      targetType: "reporting_manager_policy",
      targetId: orgId,
      before: policySnapshot(before),
      after: policySnapshot(after),
    });
    return { ...after, defaultPrimaryManager: await this.defaultManagerOf(after, tx) };
  }

  /**
   * D2/D4 elevated authority, decided structurally: org owner or org admin by membership, or a
   * holder of `hr:reporting-lines:override` (HR_ADMIN holds it). Never by title or role name. An
   * unattended system actor never holds it.
   */
  async isElevated(actor: ReportingActor): Promise<boolean> {
    if ("system" in actor) return false;
    if ("sessionId" in actor)
      return isStructuralOrgAdminContext(actor) || (await this.access.holds(actor, REPORTING_LINE_PERMISSIONS.OVERRIDE));
    if (await isStructuralOrgAdmin(this.db, actor)) return true;
    const scope = (await this.access.resolveUserPermissions(actor.orgId, actor.userId)).get(REPORTING_LINE_PERMISSIONS.OVERRIDE);
    return scope !== undefined && scope !== "none";
  }

  /** What the caller may do on reporting lines, for `getLine`'s `permittedActions`. */
  async permittedActions(actor: CurrentUserContext): Promise<PermittedActions> {
    const [manage, review, override] = await Promise.all([
      this.access.holds(actor, REPORTING_LINE_PERMISSIONS.MANAGE),
      this.access.holds(actor, REPORTING_LINE_PERMISSIONS.REVIEW),
      this.isElevated(actor),
    ]);
    return { manage: manage || override, review: review || override, override };
  }

  private async defaultManagerOf(policy: ReportingManagerPolicy, db: DbOrTx): Promise<ReportingManagerPolicyView["defaultPrimaryManager"]> {
    const userId = policy.defaultPrimaryManagerUserId;
    if (userId === null) return null;
    const [person] = await db
      .select({
        name: sql<string>`coalesce(nullif(trim(${users.name}), ''), nullif(trim(concat_ws(' ', ${users.firstName}, ${users.lastName})), ''), ${users.email})`,
        designation: hrEmployments.designation,
      })
      .from(users)
      .leftJoin(hrPeople, and(eq(hrPeople.orgId, policy.orgId), eq(hrPeople.userId, users.id), sql`${hrPeople.deletedAt} IS NULL`))
      .leftJoin(hrEmployments, and(liveEmployment(policy.orgId), eq(hrEmployments.personId, hrPeople.id), eq(hrEmployments.isPrimary, true)))
      .where(eq(users.id, userId))
      .limit(1);
    const check = await this.reportingLines.checkManager(policy.orgId, userId, db);
    return { userId, name: person?.name ?? userId, designation: person?.designation ?? null, eligible: check.ok };
  }
}

function policySnapshot(policy: ReportingManagerPolicy): Record<string, unknown> {
  return {
    maxSecondaryManagersPerEmployee: policy.maxSecondaryManagersPerEmployee,
    defaultPrimaryManagerUserId: policy.defaultPrimaryManagerUserId,
    fallbackOrder: policy.fallbackOrder,
    requireReasonAfterChanges: policy.requireReasonAfterChanges,
    allowTopLevelWithoutManager: policy.allowTopLevelWithoutManager,
    version: policy.version,
  };
}
