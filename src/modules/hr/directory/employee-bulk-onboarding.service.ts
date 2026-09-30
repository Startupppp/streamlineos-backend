import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { invitations, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { logger } from "../../../common/logger/logger.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { withMembershipMutations } from "../../../common/org/membership-mutations";
import { assertMayGrantRole } from "../../../common/rbac/assert-may-grant-role";
import { OrgHierarchyCacheService } from "../../../common/cache/org-hierarchy-cache.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import {
  runInNewTenantTransaction,
  runInTenantTransaction,
} from "../../../common/tenant/run-in-tenant-transaction";
import { AccessService } from "../../access/access.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import {
  MembershipAdmissionService,
  canonicalAdmissionEmail,
} from "../../organization/core/membership-admission.service";
import { EmailService } from "../../email/email.service";
import { AutomationService } from "../../automation/automation.service";
import { WebhooksDispatchService } from "../../webhooks/webhooks-dispatch.service";
import { PersonEmploymentSyncService } from "../core/person-employment-sync.service";
import type { BulkOnboardEmployeeRow } from "./dto/hr-directory.schemas";
import {
  ensureDepartments,
  loadDepartmentCatalog,
  previewDepartments,
} from "./bulk-onboarding/bulk-onboarding-departments";
import {
  loadLocationCatalog,
  type LocationCatalog,
} from "./bulk-onboarding/bulk-onboarding-locations";
import {
  distinctRoles,
  planBulkOnboarding,
  preloadEmployeeNumbers,
  rejectCyclesAndOrphans,
} from "./bulk-onboarding/bulk-onboarding-plan";
import { writeBulkOnboarding } from "./bulk-onboarding/bulk-onboarding-writes";
import type { BulkOnboardWriteOutcome } from "./bulk-onboarding/bulk-onboarding.types";
import { assignBulkManagers } from "./bulk-onboarding/bulk-onboarding-managers";
import { buildOnboardingPreview, onboardingWarnings, primaryManagerOf } from "./bulk-onboarding/bulk-onboarding-results";
import { ReportingLineService } from "../../directory/reporting-line.service";
import { ReportingRelationshipService } from "../../directory/reporting-relationship.service";
import { ReportingManagerFallbackResolver } from "../../directory/reporting-manager-fallback.resolver";
import { orgBusinessDate } from "../time/attendance-business-date";
import { normaliseManagerColumns } from "./reporting-manager-columns";
import { invalidateReportingReads } from "../../directory/reporting-line-cache";
import type { BulkOnboardCommitResult, BulkOnboardPreview } from "./dto/reporting-lines-bulk.schemas";

const EMPTY_LOCATION_CATALOG: LocationCatalog = { byKey: new Map(), activeIds: new Set() };

@Injectable()
export class EmployeeBulkOnboardingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly hierarchyCache: OrgHierarchyCacheService,
    private readonly cache: CacheService,
    private readonly access: AccessService,
    private readonly planLimits: PlanLimitsService,
    private readonly admission: MembershipAdmissionService,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
    private readonly webhooks: WebhooksDispatchService,
    private readonly personEmploymentSync: PersonEmploymentSyncService,
    private readonly reportingLines: ReportingLineService,
    private readonly fallback: ReportingManagerFallbackResolver,
    private readonly relationships: ReportingRelationshipService,
  ) {}

  /** HRM-15 §4.20: the same plan the commit runs, returned per row, with nothing written. */
  async previewEmployeesBulk(actor: CurrentUserContext, rows: BulkOnboardEmployeeRow[]): Promise<BulkOnboardPreview> {
    const [planned, seats] = await Promise.all([
      this.planRows(actor, rows, "preview"),
      this.previewSeatHeadroom(actor.orgId, rows),
    ]);
    return buildOnboardingPreview(rows, planned, seats);
  }

  /**
   * BUG-HRMS-002. Seats free at commit time, not merely seats free now.
   *
   * An onboard admits an organization member, so every created row spends a
   * seat. `admitMany` cancels any PENDING invitation for a candidate's own email
   * BEFORE it asks `assertWithinLimit`, so those invitations are not really in
   * the way of this file — counting them as occupied would make the preview
   * refuse rows the commit accepts. They are credited back here for the same
   * emails, and only those.
   */
  private async previewSeatHeadroom(
    orgId: string,
    rows: readonly BulkOnboardEmployeeRow[],
  ): Promise<{ limit: number | null; used: number; available: number | null }> {
    const headroom = await this.planLimits.headroomFor(orgId, "members");
    if (headroom.available === null) return headroom;

    const emails = [...new Set(rows.map((row) => canonicalAdmissionEmail(row.email)))];
    if (emails.length === 0) return headroom;

    const supersedable = await this.db
      .select({ email: invitations.email })
      .from(invitations)
      .where(
        and(
          eq(invitations.orgId, orgId),
          eq(invitations.status, "PENDING"),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date()),
          inArray(invitations.email, emails),
        ),
      );
    const credited = supersedable.length;
    return {
      limit: headroom.limit,
      used: Math.max(0, headroom.used - credited),
      available: headroom.available + credited,
    };
  }

  async onboardEmployeesBulk(actor: CurrentUserContext, rows: BulkOnboardEmployeeRow[]): Promise<BulkOnboardCommitResult> {
    const planned = await this.planRows(actor, rows, "commit");
    const { plan, catalog } = planned;

    let outcome: BulkOnboardWriteOutcome = { admitted: [], rejected: [], welcomeEmails: [] };
    const results: BulkOnboardCommitResult["results"] = plan.rejected.map((entry) => ({
      row: entry.row,
      email: entry.email,
      success: false,
      error: entry.error,
      status: entry.skipped ? ("SKIPPED" as const) : ("FAILED" as const),
      codes: entry.code ? [entry.code] : [],
      primaryManager: null,
    }));
    if (plan.accepted.length > 0) {
      const today = await orgBusinessDate(this.db, actor.orgId);
      outcome = await withMembershipMutations(this.cache, (membership) =>
        runInTenantTransaction(
          this.db,
          (tx) =>
            writeBulkOnboarding(tx, actor, plan.accepted, {
              admission: this.admission,
              personEmploymentSync: this.personEmploymentSync,
              membership,
              relationships: this.relationships,
              today,
            }),
          { orgId: actor.orgId },
        ),
      );
      for (const employee of outcome.admitted)
        results.push({
          row: employee.row,
          email: employee.email,
          success: true,
          userId: employee.userId,
          status: "CREATED",
          codes: onboardingWarnings(employee, planned.departmentsToCreate).codes,
          primaryManager: primaryManagerOf(employee),
        });
      for (const entry of outcome.rejected)
        results.push({ row: entry.row, email: entry.email, success: false, error: entry.error, status: "FAILED", codes: entry.code ? [entry.code] : [], primaryManager: null });
    }

    this.deferDelivery(actor, outcome, catalog.created);
    if (outcome.admitted.length > 0) await invalidateReportingReads(this.hierarchyCache, this.cache, actor.orgId);

    const skipped = results.filter((result) => result.status === "SKIPPED").length;
    const failed = results.filter((result) => result.status === "FAILED").length;
    results.sort((left, right) => left.row - right.row);
    // Addendum 2: the audit event IS the bulk-onboarding job record — no PII beyond the email.
    await this.audit.logCritical({
      action: "hr.employees_bulk_onboarded",
      userId: actor.userId,
      orgId: actor.orgId,
      targetType: "employee",
      metadata: {
        total: rows.length,
        created: outcome.admitted.length,
        failed,
        skipped,
        legacyManagerHeader: planned.legacyHeaderRows > 0,
        legacyManagerHeaderRows: planned.legacyHeaderRows,
        rows: results.map((result) => ({ row: result.row, email: result.email, status: result.status, codes: result.codes })),
      },
    });

    return { total: rows.length, created: outcome.admitted.length, failed, skipped, results };
  }


  /**
   * One plan for preview and commit: headers normalised, admission screened, the primary manager
   * resolved by D2 (in-file managers included), secondaries checked, and dependants of a failed
   * manager row skipped. Every lookup is one statement for the whole file.
   */
  private async planRows(actor: CurrentUserContext, input: readonly BulkOnboardEmployeeRow[], mode: "preview" | "commit") {
    const normalised = input.map((row) =>
      normaliseManagerColumns({
        reportingManagerEmail: row.reportingManagerEmail,
        primaryManagerEmail: row.primaryManagerEmail,
        secondaryManagerEmail1: row.secondaryManagerEmail1,
        secondaryManagerEmail2: row.secondaryManagerEmail2,
        secondaryManagerEmail3: row.secondaryManagerEmail3,
      }),
    );
    const rows = input.map((row, index) => {
      const columns = normalised[index];
      return columns?.ok ? { ...row, reportingManagerEmail: undefined, primaryManagerEmail: columns.primaryManagerEmail ?? undefined } : row;
    });
    const legacyHeaderRows = normalised.filter((columns) => columns.ok && columns.legacyHeader !== null).length;

    const catalog = await loadDepartmentCatalog(this.db, actor.orgId);
    const departmentNames = rows.flatMap((row) => (row.departmentId == null && row.department ? [row.department] : []));
    const departmentsToCreate = mode === "preview" ? previewDepartments(catalog, departmentNames) : [];
    if (mode === "commit") await ensureDepartments(this.db, actor.orgId, catalog, departmentNames);

    const roleErrors = new Map<string, string>();
    for (const role of distinctRoles(rows)) {
      try {
        await assertMayGrantRole(this.access, actor.orgId, actor, role);
      } catch (err) {
        roleErrors.set(role, err instanceof Error ? err.message : "Role cannot be granted");
      }
    }
    const employeeNumberOwner = await preloadEmployeeNumbers(this.db, actor.orgId, [
      ...new Set(rows.flatMap((row) => (row.employeeId?.trim() ? [row.employeeId.trim()] : []))),
    ]);
    const screens = await this.admission.screenMany(this.db, {
      orgId: actor.orgId,
      emails: [...new Set(rows.map((row) => canonicalAdmissionEmail(row.email)))],
    });
    const existingUserIds: string[] = [];
    for (const screen of screens.values()) if (screen.kind === "clear" && screen.userId !== null) existingUserIds.push(screen.userId);
    const globallyInactiveUserIds = new Set<string>();
    if (existingUserIds.length > 0) {
      const inactive = await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, existingUserIds), eq(users.isActive, false)))
        .limit(existingUserIds.length);
      for (const row of inactive) globallyInactiveUserIds.add(row.id);
    }

    // BUG-HRMS-006. Only drained when the file actually names a location, so a
    // file that names none costs exactly what it did before.
    const locations = rows.some((row) => row.locationId != null || row.location != null)
      ? await loadLocationCatalog(this.db, actor.orgId)
      : EMPTY_LOCATION_CATALOG;

    const plan = planBulkOnboarding(rows, catalog, screens, employeeNumberOwner, roleErrors, globallyInactiveUserIds, locations);
    await assignBulkManagers(this.db, this.fallback, this.reportingLines, actor, rows, normalised, plan);
    return { plan: rejectCyclesAndOrphans(plan), catalog, departmentsToCreate, legacyHeaderRows };
  }


  private deferDelivery(
    actor: CurrentUserContext,
    outcome: BulkOnboardWriteOutcome,
    hierarchyChanged: boolean,
  ): void {
    if (outcome.admitted.length === 0 && !hierarchyChanged) return;

    for (const employee of outcome.admitted)
      if (employee.createdUser)
        this.webhooks.dispatch(actor.orgId, "employee.hired", {
          userId: employee.userId,
          email: employee.email,
          firstName: employee.firstName,
          lastName: employee.lastName,
          joiningDate: employee.joiningDate,
        });

    const deliver = () => this.runDelivery(actor, outcome, hierarchyChanged);
    if (!registerAfterCommit(deliver)) void deliver();
  }

  private async runDelivery(
    actor: CurrentUserContext,
    outcome: BulkOnboardWriteOutcome,
    hierarchyChanged: boolean,
  ): Promise<void> {
    await this.invalidateHrDashboardCache(actor.orgId);
    if (hierarchyChanged) await this.hierarchyCache.invalidateAfterMutation(actor.orgId);

    for (const message of outcome.welcomeEmails) {
      try {
        await this.email.sendWelcomeEmail(message.email, message.name, message.signInUrl);
      } catch (err) {
        logger.error("Failed to send welcome email", { email: message.email, error: err });
      }
    }

    if (outcome.admitted.length === 0) return;
    try {
      await runInNewTenantTransaction(this.db, actor.orgId, async () => {
        for (const employee of outcome.admitted)
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
