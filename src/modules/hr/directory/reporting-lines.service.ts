import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { OrgHierarchyCacheService } from "../../../common/cache/org-hierarchy-cache.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { AccessService } from "../../access/access.service";
import { ReportingLineService } from "../../directory/reporting-line.service";
import { ReportingManagerPolicyService } from "../../directory/reporting-manager-policy.service";
import { ReportingManagerFallbackResolver } from "../../directory/reporting-manager-fallback.resolver";
import { ReportingRelationshipService } from "../../directory/reporting-relationship.service";
import type { ManagerCoverageReport, ReportingLineView } from "../../directory/reporting-line.types";
import { orgBusinessDate } from "../time/attendance-business-date";
import { EmployeesService } from "./employees.service";
import { resolveEmployeesScope, selfEmployeeRead } from "./employees-scope";
import { subjectEmployments } from "../../directory/reporting-line-queries";
import { peopleByUserIds, searchManagerCandidates } from "./reporting-manager-people";
import type {
  ManagerCandidatesQuery,
  MyReportingLine,
  ReportingManagerPolicy,
  SetReportingLineInput,
  UpdateReportingManagerPolicyInput,
} from "./dto/reporting-lines-line.schemas";
import type { ManagerRef } from "./dto/reporting-lines-shared.schemas";

/**
 * After a reporting relationship commits, every read that walks the hierarchy is stale: the org
 * chart and headcount namespaces, and the employee list that shows each person's manager. Both
 * run after commit (BE-85: inline when there is no transaction to wait for).
 */
export async function invalidateReportingReads(
  hierarchyCache: OrgHierarchyCacheService,
  cache: CacheService,
  orgId: string,
): Promise<void> {
  await hierarchyCache.invalidateAfterMutation(orgId);
  const bustEmployees = () => cache.invalidateNamespace(CACHE_KEYS.hrEmployeesListNamespace(orgId));
  if (!registerAfterCommit(bustEmployees)) await bustEmployees();
}

@Injectable()
export class HrReportingLinesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly employees: EmployeesService,
    private readonly reportingLines: ReportingLineService,
    private readonly policies: ReportingManagerPolicyService,
    private readonly fallback: ReportingManagerFallbackResolver,
    private readonly relationships: ReportingRelationshipService,
    private readonly hierarchyCache: OrgHierarchyCacheService,
    private readonly cache: CacheService,
  ) {}

  async getPolicy(actor: CurrentUserContext): Promise<ReportingManagerPolicy> {
    const [view, qualifies] = await Promise.all([
      this.policies.get(actor.orgId),
      this.fallback.actorQualifiesAsFallback(actor.orgId, actor),
    ]);
    return this.policyResponse(actor.orgId, view, qualifies);
  }

  async updatePolicy(actor: CurrentUserContext, patch: UpdateReportingManagerPolicyInput): Promise<ReportingManagerPolicy> {
    const view = await runInTenantTransaction(this.db, (tx) => this.policies.update(actor, patch, tx), { orgId: actor.orgId });
    return this.policyResponse(actor.orgId, view, await this.fallback.actorQualifiesAsFallback(actor.orgId, actor));
  }

  async getLine(actor: CurrentUserContext, employeeUserId: string): Promise<ReportingLineView> {
    const [read, permittedActions] = await Promise.all([
      resolveEmployeesScope(this.access, actor),
      this.policies.permittedActions(actor),
    ]);
    const line = await this.reportingLines.getLine(read, employeeUserId, { permittedActions });
    if (!line) throw new NotFoundException("Employee not found.");
    return line;
  }

  async setLine(
    actor: CurrentUserContext,
    employeeUserId: string,
    body: SetReportingLineInput,
  ): Promise<{ line: ReportingLineView; warnings: string[] }> {
    await this.employees.assertEmployeeVisible(await resolveEmployeesScope(this.access, actor), employeeUserId);
    const effectiveFrom = body.effectiveFrom ?? (await orgBusinessDate(this.db, actor.orgId));
    const result = await runInTenantTransaction(
      this.db,
      (tx) =>
        this.relationships.setRelationships(tx, {
          orgId: actor.orgId,
          actor,
          subjectUserId: employeeUserId,
          primaryManagerUserId: body.primaryManagerUserId,
          topLevelReason: body.topLevelReason ?? null,
          secondary: body.secondaryManagers?.map((entry) => ({ managerUserId: entry.managerUserId, label: entry.label ?? null })),
          effectiveFrom,
          source: "MANUAL",
          reason: body.reason ?? null,
          emergency: body.emergency === true,
        }),
      { orgId: actor.orgId },
    );
    if (result.changed) await invalidateReportingReads(this.hierarchyCache, this.cache, actor.orgId);
    return { line: await this.getLine(actor, employeeUserId), warnings: result.warnings };
  }

  async confirmFallback(actor: CurrentUserContext, employeeUserId: string): Promise<ReportingLineView> {
    await this.employees.assertEmployeeVisible(await resolveEmployeesScope(this.access, actor), employeeUserId);
    const confirmed = await runInTenantTransaction(
      this.db,
      (tx) => this.relationships.confirmFallback(tx, { orgId: actor.orgId, actor, subjectUserId: employeeUserId }),
      { orgId: actor.orgId },
    );
    if (confirmed.confirmed) await invalidateReportingReads(this.hierarchyCache, this.cache, actor.orgId);
    return this.getLine(actor, employeeUserId);
  }

  /** §4.13 — the caller's own line, read through an own-scope; reasons are never included. */
  async myLine(actor: CurrentUserContext): Promise<MyReportingLine> {
    const [subject] = await subjectEmployments(this.db, actor.orgId, { userIds: [actor.userId] });
    const line = subject ? await this.reportingLines.getLine(selfEmployeeRead(actor), actor.userId) : null;
    if (!line) return { hasEmployment: false, primary: null, secondary: [], topLevel: null };
    const current = line.current;
    return {
      hasEmployment: true,
      primary: current
        ? {
            lineId: current.lineId,
            relationshipType: "PRIMARY",
            label: null,
            manager: {
              userId: current.managerUserId ?? "",
              name: current.managerName ?? "Unnamed manager",
              email: current.managerEmail,
              designation: current.managerDesignation,
              state: current.managerState,
            },
            effectiveFrom: current.effectiveFrom,
            effectiveTo: current.effectiveTo,
            source: current.source,
            isFallback: current.isFallback,
            fallbackConfirmedAt: current.fallbackConfirmedAt,
            recordedAt: current.recordedAt,
            changeReason: null,
          }
        : null,
      secondary: line.secondary.map((entry) => ({ ...entry, changeReason: null })),
      topLevel: line.topLevel ? { effectiveFrom: line.topLevel.effectiveFrom } : null,
    };
  }

  coverage(actor: CurrentUserContext): Promise<ManagerCoverageReport> {
    return this.reportingLines.coverage(actor.orgId);
  }

  async managerCandidates(actor: CurrentUserContext, query: ManagerCandidatesQuery): Promise<{ items: ManagerRef[] }> {
    const items = await searchManagerCandidates(this.db, actor.orgId, {
      q: query.q,
      excludeUserIds: query.excludeUserId ? [query.excludeUserId] : [],
      limit: query.limit,
    });
    return { items };
  }

  private async policyResponse(
    orgId: string,
    view: Awaited<ReturnType<ReportingManagerPolicyService["get"]>>,
    actorQualifiesAsFallback: boolean,
  ): Promise<ReportingManagerPolicy> {
    const configured = view.defaultPrimaryManager;
    let defaultPrimaryManager: ManagerRef | null = null;
    if (configured) {
      const person = (await peopleByUserIds(this.db, orgId, [configured.userId])).get(configured.userId);
      defaultPrimaryManager = person
        ? { userId: person.userId, name: person.name, email: person.email, designation: person.designation, state: person.state }
        : { userId: configured.userId, name: configured.name, email: null, designation: configured.designation, state: "inactive" };
    }
    return {
      maxSecondaryManagersPerEmployee: view.maxSecondaryManagersPerEmployee,
      defaultPrimaryManager,
      defaultPrimaryManagerEligible: configured?.eligible ?? false,
      fallbackOrder: view.fallbackOrder,
      requireReasonAfterChanges: view.requireReasonAfterChanges,
      allowTopLevelWithoutManager: view.allowTopLevelWithoutManager,
      version: view.version,
      updatedAt: view.updatedAt,
      isConfigured: view.isConfigured,
      actorQualifiesAsFallback,
    };
  }
}
