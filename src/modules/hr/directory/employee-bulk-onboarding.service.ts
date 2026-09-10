import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { logger } from "../../../common/logger/logger.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { scheduleMembershipBustMany } from "../../../common/org/membership-bust";
import { assertMayGrantRole } from "../../../common/rbac/assert-may-grant-role";
import { OrgHierarchyCacheService } from "../../../common/cache/org-hierarchy-cache.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import {
  runInNewTenantTransaction,
  runInTenantTransaction,
} from "../../../common/tenant/run-in-tenant-transaction";
import { AccessService } from "../../access/access.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import { EmailService } from "../../email/email.service";
import { AutomationService } from "../../automation/automation.service";
import { WebhooksDispatchService } from "../../webhooks/webhooks-dispatch.service";
import { PersonEmploymentSyncService } from "../core/person-employment-sync.service";
import type { BulkOnboardEmployeeRow } from "./dto/hr-directory.schemas";
import {
  ensureDepartments,
  loadDepartmentCatalog,
} from "./bulk-onboarding/bulk-onboarding-departments";
import {
  canonicalizeEmail,
  distinctRoles,
  planBulkOnboarding,
  preloadIdentities,
} from "./bulk-onboarding/bulk-onboarding-plan";
import { writeBulkOnboarding } from "./bulk-onboarding/bulk-onboarding-writes";
import type {
  BulkOnboardRowResult,
  BulkOnboardWriteOutcome,
  PlannedEmployee,
} from "./bulk-onboarding/bulk-onboarding.types";

@Injectable()
export class EmployeeBulkOnboardingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly hierarchyCache: OrgHierarchyCacheService,
    private readonly cache: CacheService,
    private readonly access: AccessService,
    private readonly planLimits: PlanLimitsService,
    private readonly seatLedger: SeatLedgerService,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
    private readonly webhooks: WebhooksDispatchService,
    private readonly personEmploymentSync: PersonEmploymentSyncService,
  ) {}

  // Per-row rejections come from the preloaded maps, so every row still names its reason; the accepted set then commits or rolls back as a unit.
  async onboardEmployeesBulk(actor: CurrentUserContext, rows: BulkOnboardEmployeeRow[]) {
    const catalog = await loadDepartmentCatalog(this.db, actor.orgId);

    const roleErrors = new Map<string, string>();
    for (const role of distinctRoles(rows)) {
      try {
        await assertMayGrantRole(this.access, actor.orgId, actor, role);
      } catch (err) {
        roleErrors.set(role, err instanceof Error ? err.message : "Role cannot be granted");
      }
    }

    await ensureDepartments(
      this.db,
      actor.orgId,
      catalog,
      rows.flatMap((row) => (row.departmentId == null && row.department ? [row.department] : [])),
    );

    const identities = await preloadIdentities(
      this.db,
      actor.orgId,
      [...new Set(rows.map((row) => canonicalizeEmail(row.email)))],
      [
        ...new Set(
          rows.flatMap((row) => (row.employeeId?.trim() ? [row.employeeId.trim()] : [])),
        ),
      ],
    );

    const plan = planBulkOnboarding(rows, catalog, identities, roleErrors);

    let outcome: BulkOnboardWriteOutcome = { createdUserIds: [], welcomeEmails: [] };
    const results: BulkOnboardRowResult[] = [...plan.rejected];
    if (plan.accepted.length > 0) {
      outcome = await runInTenantTransaction(
        this.db,
        (tx) =>
          writeBulkOnboarding(tx, actor, plan.accepted, {
            planLimits: this.planLimits,
            seatLedger: this.seatLedger,
            personEmploymentSync: this.personEmploymentSync,
          }),
        { orgId: actor.orgId },
      );
      for (const employee of plan.accepted)
        results.push({
          row: employee.row,
          email: employee.email,
          success: true,
          userId: employee.userId,
        });
    }

    this.deferDelivery(actor, plan.accepted, outcome, catalog.created);

    await this.audit.logCritical({
      action: "hr.employees_bulk_onboarded",
      userId: actor.userId,
      orgId: actor.orgId,
      targetType: "employee",
      metadata: {
        total: rows.length,
        created: plan.accepted.length,
        failed: plan.rejected.length,
      },
    });

    results.sort((left, right) => left.row - right.row);
    return {
      total: rows.length,
      created: plan.accepted.length,
      failed: plan.rejected.length,
      results,
    };
  }

  private deferDelivery(
    actor: CurrentUserContext,
    accepted: readonly PlannedEmployee[],
    outcome: BulkOnboardWriteOutcome,
    hierarchyChanged: boolean,
  ): void {
    if (accepted.length === 0 && !hierarchyChanged) return;

    for (const employee of accepted)
      if (employee.isNewUser)
        this.webhooks.dispatch(actor.orgId, "employee.hired", {
          userId: employee.userId,
          email: employee.email,
          firstName: employee.firstName,
          lastName: employee.lastName,
          joiningDate: employee.joiningDate,
        });

    const deliver = () => this.runDelivery(actor, accepted, outcome, hierarchyChanged);
    if (!registerAfterCommit(deliver)) void deliver();
  }

  private async runDelivery(
    actor: CurrentUserContext,
    accepted: readonly PlannedEmployee[],
    outcome: BulkOnboardWriteOutcome,
    hierarchyChanged: boolean,
  ): Promise<void> {
    await scheduleMembershipBustMany(this.cache, outcome.createdUserIds);
    await this.invalidateHrDashboardCache(actor.orgId);
    if (hierarchyChanged) await this.hierarchyCache.invalidateAfterMutation(actor.orgId);

    for (const message of outcome.welcomeEmails) {
      try {
        await this.email.sendWelcomeEmail(message.email, message.name, message.signInUrl);
      } catch (err) {
        logger.error("Failed to send welcome email", { email: message.email, error: err });
      }
    }

    if (accepted.length === 0) return;
    try {
      await runInNewTenantTransaction(this.db, actor.orgId, async () => {
        for (const employee of accepted)
          await this.automation.runAutomationsForEvent(actor.orgId, "onboarding.started", {
            userId: employee.userId,
            employeeName: `${employee.firstName} ${employee.lastName}`,
            employeeEmail: employee.email,
            departmentId: employee.departmentId,
            joiningDate: employee.joiningDate,
            startedAt: new Date().toISOString(),
          });
      });
    } catch (err) {
      logger.error("Bulk onboarding automations failed", { orgId: actor.orgId, error: err });
    }
  }

  private async invalidateHrDashboardCache(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidateNamespaceForOrg(orgId, "hr:analytics"),
      this.cache.invalidate(`hr:dashboard:metrics:${orgId}`),
      this.cache.invalidate(`hr:dashboard:headcount-trends:${orgId}`),
      this.cache.invalidateNamespaceForOrg(orgId, "hr:celebrations"),
      this.cache.invalidateNamespace(CACHE_KEYS.hrEmployeesListNamespace(orgId)),
    ]);
  }
}
