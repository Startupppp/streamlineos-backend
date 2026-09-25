import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { users } from "../../../db/schema";
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
  distinctRoles,
  planBulkOnboarding,
  preloadEmployeeNumbers,
  rejectCyclesAndOrphans,
} from "./bulk-onboarding/bulk-onboarding-plan";
import { writeBulkOnboarding } from "./bulk-onboarding/bulk-onboarding-writes";
import type {
  BulkOnboardPlan,
  BulkOnboardWriteOutcome,
  PlannedEmployee,
  PlannedSecondaryManager,
} from "./bulk-onboarding/bulk-onboarding.types";
import { ReportingLineService } from "../../directory/reporting-line.service";
import { ReportingRelationshipService } from "../../directory/reporting-relationship.service";
import { ReportingManagerFallbackResolver } from "../../directory/reporting-manager-fallback.resolver";
import { readReportingManagerPolicy } from "../../directory/reporting-line-queries";
import {
  REPORTING_LINE_ERROR_CODES,
  REPORTING_LINE_WARNINGS,
  type ManagerAssignmentCheck,
} from "../../directory/reporting-line.types";
import { orgBusinessDate } from "../time/attendance-business-date";
import { normaliseManagerColumns, type ManagerColumnsResult } from "./reporting-manager-columns";
import { peopleByEmails } from "./reporting-manager-people";
import { invalidateReportingReads } from "./reporting-lines.service";
import type { BulkOnboardCommitResult, BulkOnboardPreview } from "./dto/reporting-lines-bulk.schemas";

function newRowManagerMessage(email: string): string {
  return `${email} is new in this file and has not accepted their invitation yet, so they cannot be a reporting manager. Onboard them first, or leave the manager blank to use the fallback.`;
}

function secondaryEmailsOf(columns: ManagerColumnsResult | undefined): string[] {
  return columns?.ok ? columns.secondaryManagerEmails.flatMap((email) => (email ? [email] : [])) : [];
}

function primaryManagerOf(employee: PlannedEmployee): BulkOnboardPreview["rows"][number]["primaryManager"] {
  const manager = employee.primaryManager;
  if (!manager) return null;
  return { userId: manager.userId, name: manager.name ?? manager.email ?? "", email: manager.email ?? "", resolution: manager.resolution };
}

@Injectable()
export class EmployeeBulkOnboardingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly hierarchyCache: OrgHierarchyCacheService,
    private readonly cache: CacheService,
    private readonly access: AccessService,
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
    const planned = await this.planRows(actor, rows, "preview");
    const accepted = new Map(planned.plan.accepted.map((employee) => [employee.row, employee]));
    const rejected = new Map(planned.plan.rejected.map((entry) => [entry.row, entry]));
    const counts = { ready: 0, warning: 0, error: 0, skipped: 0 };
    const previewRows = rows.map((source, index) => {
      const row = index + 1;
      const employee = accepted.get(row);
      const refusal = rejected.get(row);
      const email = canonicalAdmissionEmail(source.email);
      if (!employee) {
        const skipped = refusal?.skipped === true;
        counts[skipped ? "skipped" : "error"] += 1;
        return {
          row,
          email,
          status: skipped ? ("SKIPPED" as const) : ("ERROR" as const),
          codes: refusal?.code ? [refusal.code] : [],
          messages: refusal?.error ? [refusal.error] : [],
          primaryManager: null,
          secondaryManagers: [],
          dependsOnRow: refusal?.dependsOnRow ?? null,
        };
      }
      const warnings = this.warningsFor(employee, planned.departmentsToCreate);
      counts[warnings.codes.length > 0 ? "warning" : "ready"] += 1;
      return {
        row,
        email,
        status: warnings.codes.length > 0 ? ("WARNING" as const) : ("READY" as const),
        codes: warnings.codes,
        messages: warnings.messages,
        primaryManager: primaryManagerOf(employee),
        secondaryManagers: employee.secondaryManagers.map((manager) => ({ name: manager.name ?? manager.email, email: manager.email })),
        dependsOnRow: employee.primaryManager?.dependsOnRow ?? null,
      };
    });
    return { rows: previewRows, counts };
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
          codes: this.warningsFor(employee, planned.departmentsToCreate).codes,
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

  private warningsFor(employee: PlannedEmployee, departmentsToCreate: readonly string[]): { codes: string[]; messages: string[] } {
    const codes: string[] = [];
    const messages: string[] = [];
    const manager = employee.primaryManager;
    if (manager && (manager.resolution === "FALLBACK_CONFIGURED" || manager.resolution === "FALLBACK_UPLOADER")) {
      codes.push(REPORTING_LINE_WARNINGS.FALLBACK_ASSIGNED);
      messages.push(
        manager.resolution === "FALLBACK_CONFIGURED"
          ? `No manager given: ${manager.name ?? manager.email ?? "the default manager"} is assigned as the organization's default reporting manager.`
          : `No manager given: ${manager.name ?? manager.email ?? "you"} (the uploader) is assigned by the fallback policy.`,
      );
    }
    const department = employee.source.department?.trim();
    if (department && departmentsToCreate.some((name) => name.toLowerCase() === department.toLowerCase())) {
      codes.push("DEPARTMENT_WILL_BE_CREATED");
      messages.push(`Department "${department}" does not exist yet and will be created.`);
    }
    return { codes, messages };
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

    const plan = planBulkOnboarding(rows, catalog, screens, employeeNumberOwner, roleErrors, globallyInactiveUserIds);
    await this.assignManagers(actor, rows, normalised, plan);
    return { plan: rejectCyclesAndOrphans(plan), catalog, departmentsToCreate, legacyHeaderRows };
  }

  /** Fills each accepted row's primary (D2) and secondary managers, moving refused rows to `rejected`. */
  private async assignManagers(
    actor: CurrentUserContext,
    rows: readonly BulkOnboardEmployeeRow[],
    normalised: ReadonlyArray<ReturnType<typeof normaliseManagerColumns>>,
    plan: BulkOnboardPlan,
  ): Promise<void> {
    const orgId = actor.orgId;
    if (plan.accepted.length === 0) return;
    // The whole file is the roster (a manager row may itself have failed, which the orphan sweep
    // then reports), so every row is passed even though only accepted rows are read back.
    const resolved = await this.fallback.resolveMany(
      orgId,
      actor,
      rows.map((row, index) => ({
        key: index + 1,
        employeeEmail: canonicalAdmissionEmail(row.email),
        primaryManagerUserId: row.reportingManagerUserId ?? null,
        primaryManagerEmail: row.primaryManagerEmail ?? null,
      })),
    );
    const roster = new Set(plan.accepted.map((employee) => employee.email));
    const secondaryEmails = plan.accepted.flatMap((employee) => secondaryEmailsOf(normalised[employee.row - 1]));
    const people = await peopleByEmails(this.db, orgId, secondaryEmails);
    const policy = secondaryEmails.length > 0 ? await readReportingManagerPolicy(this.db, orgId) : null;
    const checks =
      people.size > 0 ? await this.reportingLines.checkManagers(orgId, [...people.values()].map((person) => person.userId)) : new Map<string, ManagerAssignmentCheck>();

    const kept: PlannedEmployee[] = [];
    for (const employee of plan.accepted) {
      const refuse = (code: string, error: string) => plan.rejected.push({ row: employee.row, email: employee.email, success: false, error, code });
      const columns = normalised[employee.row - 1];
      if (!columns?.ok) {
        refuse(REPORTING_LINE_ERROR_CODES.MANAGER_COLUMN_CONFLICT, `The manager columns disagree: ${columns?.ok === false ? columns.conflictingColumns.join(", ") : ""}.`);
        continue;
      }
      if (!employee.source.topLevelRole) {
        const result = resolved[employee.row - 1];
        if (!result?.ok) {
          refuse(result?.code ?? REPORTING_LINE_ERROR_CODES.MANAGER_NOT_FOUND, result && !result.ok ? result.message : "The reporting manager could not be resolved.");
          continue;
        }
        // The canonical service only accepts a manager who has accepted their invitation, and a
        // person this file creates cannot have. Refusing the row here keeps the rest of the file
        // committable instead of failing it whole at write time.
        if (result.managerUserId === null) {
          refuse(REPORTING_LINE_ERROR_CODES.MANAGER_NOT_ELIGIBLE, newRowManagerMessage(result.email ?? "the manager"));
          continue;
        }
        employee.primaryManager = {
          userId: result.managerUserId,
          name: result.name,
          email: result.email,
          resolution: result.resolution,
          dependsOnRow: result.dependsOnRow,
        };
        employee.reportingManagerUserId = result.managerUserId;
        employee.reportingManagerEmail = result.managerUserId === null ? result.email : null;
      }
      const secondaries: PlannedSecondaryManager[] = [];
      let problem: { code: string; error: string } | null = null;
      for (const email of secondaryEmailsOf(columns)) {
        const person = people.get(email);
        const check = person ? checks.get(person.userId) : undefined;
        if (email === employee.email) problem = { code: REPORTING_LINE_ERROR_CODES.SELF_REFERENCE, error: "An employee cannot be their own secondary manager." };
        else if (secondaries.some((entry) => entry.email === email)) problem = { code: REPORTING_LINE_ERROR_CODES.SECONDARY_DUPLICATE, error: `${email} is listed twice as a secondary manager.` };
        else if (email === employee.primaryManager?.email) problem = { code: REPORTING_LINE_ERROR_CODES.SECONDARY_DUPLICATES_PRIMARY, error: `${email} is already the primary manager.` };
        else if (person && !check?.ok) problem = { code: REPORTING_LINE_ERROR_CODES.MANAGER_NOT_ELIGIBLE, error: check?.message ?? `${email} cannot be a manager.` };
        else if (!person && roster.has(email)) problem = { code: REPORTING_LINE_ERROR_CODES.MANAGER_NOT_ELIGIBLE, error: newRowManagerMessage(email) };
        else if (!person) problem = { code: REPORTING_LINE_ERROR_CODES.MANAGER_NOT_FOUND, error: `No member of this organization or row of this file has the email ${email}.` };
        if (problem) break;
        secondaries.push({ email, userId: person?.userId ?? null, name: person?.name ?? null });
      }
      const cap = policy?.maxSecondaryManagersPerEmployee ?? 0;
      if (!problem && secondaries.length > cap)
        problem = {
          code: REPORTING_LINE_ERROR_CODES.SECONDARY_CAP_EXCEEDED,
          error: `This organization allows at most ${cap} secondary reporting manager(s) per employee.`,
        };
      if (!problem && employee.source.topLevelRole && secondaries.length > 0)
        problem = { code: REPORTING_LINE_ERROR_CODES.TOP_LEVEL_WITH_MANAGER, error: "A top-level role cannot have secondary managers." };
      if (problem) {
        refuse(problem.code, problem.error);
        continue;
      }
      employee.secondaryManagers = secondaries;
      kept.push(employee);
    }
    plan.accepted = kept;
    plan.rejected.sort((left, right) => left.row - right.row);
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
