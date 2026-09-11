import {
  BadRequestException,
  ConflictException,
  Injectable,
  Inject,
} from "@nestjs/common";
import { and, eq, desc, asc, gt, isNull, lt, or, type SQL } from "drizzle-orm";
import {
  buildCursorPage,
  decodeCursor,
  type CursorPage,
} from "../../../common/pagination/cursor";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollRuns,
  payrollPolicies,
  payrollPolicyVersions,
  organizationMembers,
} from "../../../db/schema";
import type { ScopedRead } from "../../access/scoped-read";
import { buildRunChecklist } from "./lib/checklist";
import type {
  ListRunsQuery,
  ListRunEmployeesQuery,
  AddRunAdjustmentInput,
} from "./dto/runs.schemas";
import type {
  PayrollChecklistItem,
  PayrollToggles,
  VarianceSummary,
} from "../payroll.types";
import { AuditService } from "../../../common/audit/audit.service";
import { PayrollEntitiesService } from "../entities/entities.service";
import { describeCountryPack } from "../../hr/global/lib/country-pack-registry";
import { getIndiaBundleForMonth } from "./lib/statutory-registry";
import { PayrollRunVarianceService } from "./payroll-run-variance.service";
import { PayrollRunEmployeesService } from "./payroll-run-employees.service";

@Injectable()
export class RunsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly entities: PayrollEntitiesService,
    private readonly variance: PayrollRunVarianceService,
    private readonly employees: PayrollRunEmployeesService,
  ) {}

  async setEmployeeHold(
    orgId: string,
    runId: number,
    runEmployeeId: number,
    hold: boolean,
    reason: string | null,
    actorId: string,
  ): Promise<{ ok: boolean }> {
    return this.employees.setEmployeeHold(
      orgId,
      runId,
      runEmployeeId,
      hold,
      reason,
      actorId,
    );
  }

  async addRunAdjustment(
    orgId: string,
    runId: number,
    runEmployeeId: number,
    body: AddRunAdjustmentInput,
    actorId: string,
  ): Promise<{ ok: true } | { ok: false; reason: "not_found" | "locked" }> {
    return this.employees.addRunAdjustment(
      orgId,
      runId,
      runEmployeeId,
      body,
      actorId,
    );
  }

  async createRun(
    orgId: string,
    userId: string,
    month: string,
    opts?: {
      runType?: string;
      sourcePeriodKey?: string | null;
      sourceRunId?: number | null;
      entityId?: number | null;
    },
  ): Promise<{ ok: false; reason: "exists" } | { ok: true; runId: number }> {
    const runType = opts?.runType ?? "REGULAR";
    const entityId = opts?.entityId ?? null;

    let periodId: number | null = null;
    let statutoryRuleVersion: string | null = null;
    if (entityId != null) {
      const entity = await this.entities.getEntity(orgId, entityId);
      const period = await this.entities.ensurePeriod(orgId, month, {
        entityId,
      });
      periodId = period.id;
      const pack = describeCountryPack(entity.countryCode);
      statutoryRuleVersion =
        entity.countryCode === "IN"
          ? getIndiaBundleForMonth(month).bundleVersion
          : (pack?.payrollStatutoryBundle ?? null);
      if (statutoryRuleVersion) {
        const ruleCountry = statutoryRuleVersion.split("-")[0] ?? "";
        if (ruleCountry.length === 2) {
          this.entities.assertNoCountryContamination(
            entity.countryCode,
            ruleCountry,
          );
        }
      }
    }

    if (opts?.sourceRunId != null) {
      const source = await this.db
        .select({
          id: payrollRuns.id,
          entityId: payrollRuns.entityId,
        })
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.id, opts.sourceRunId),
            eq(payrollRuns.orgId, orgId),
          ),
        )
        .limit(1);
      if (!source[0]) {
        throw new BadRequestException(
          "Source payroll run not found in this organization",
        );
      }
      if (
        entityId != null &&
        source[0].entityId != null &&
        source[0].entityId !== entityId
      ) {
        throw new BadRequestException(
          `Source run belongs to entity ${source[0].entityId}, not entity ${entityId}`,
        );
      }
    }

    const existingWhere =
      entityId != null
        ? and(
            eq(payrollRuns.orgId, orgId),
            eq(payrollRuns.month, month),
            eq(payrollRuns.runType, runType),
            eq(payrollRuns.entityId, entityId),
          )
        : and(
            eq(payrollRuns.orgId, orgId),
            eq(payrollRuns.month, month),
            eq(payrollRuns.runType, runType),
            isNull(payrollRuns.entityId),
          );

    const existing = await this.db
      .select({ id: payrollRuns.id, entityId: payrollRuns.entityId })
      .from(payrollRuns)
      .where(existingWhere)
      .limit(1);

    if (existing.length > 0) return { ok: false, reason: "exists" };

    const policyVersion = await this.db
      .select({ id: payrollPolicyVersions.id })
      .from(payrollPolicies)
      .innerJoin(
        payrollPolicyVersions,
        and(
          eq(payrollPolicyVersions.policyId, payrollPolicies.id),
          eq(payrollPolicyVersions.status, "ACTIVE"),
        ),
      )
      .where(eq(payrollPolicies.orgId, orgId))
      .limit(1);

    const policyVersionId = policyVersion[0]?.id ?? null;

    const creatorMember = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.orgId, orgId),
      ),
      columns: { id: true },
    });
    const createdByMembershipId = creatorMember?.id ?? null;

    const inserted = await this.db
      .insert(payrollRuns)
      .values({
        orgId,
        month,
        runType,
        sourcePeriodKey: opts?.sourcePeriodKey ?? null,
        sourceRunId: opts?.sourceRunId ?? null,
        entityId,
        periodId,
        statutoryRuleVersion,
        calculationVersion: "1.0.0",
        status: "PREPARING",
        policyVersionId,
        createdBy: userId,
        createdByMembershipId,
      })
      .returning({ id: payrollRuns.id });

    const runId = inserted[0]?.id;
    if (!runId) return { ok: false, reason: "exists" };

    return { ok: true, runId };
  }

  async listRuns(
    orgId: string,
    query: ListRunsQuery,
  ): Promise<
    CursorPage<{
      id: number;
      month: string;
      status: string;
      runType: string;
      entityId: number | null;
      statutoryRuleVersion: string | null;
      grossTotal: string | null;
      netTotal: string | null;
      employeeCount: number | null;
      exceptionCount: number | null;
      createdAt: Date;
    }>
  > {
    const pageLimit = Math.min(query.limit, 100);
    const pos = decodeCursor(query.cursor);
    const conditions: SQL[] = [eq(payrollRuns.orgId, orgId)];
    if (query.entityId != null)
      conditions.push(eq(payrollRuns.entityId, query.entityId));
    const cursorCondition = pos
      ? or(
          lt(payrollRuns.month, pos.sortValue),
          and(
            eq(payrollRuns.month, pos.sortValue),
            lt(payrollRuns.id, Number(pos.id)),
          ),
        )
      : undefined;
    if (cursorCondition) conditions.push(cursorCondition);
    const rows = await this.db
      .select({
        id: payrollRuns.id,
        month: payrollRuns.month,
        status: payrollRuns.status,
        runType: payrollRuns.runType,
        entityId: payrollRuns.entityId,
        statutoryRuleVersion: payrollRuns.statutoryRuleVersion,
        grossTotal: payrollRuns.grossTotal,
        netTotal: payrollRuns.netTotal,
        employeeCount: payrollRuns.employeeCount,
        exceptionCount: payrollRuns.exceptionCount,
        createdAt: payrollRuns.createdAt,
      })
      .from(payrollRuns)
      .where(and(...conditions))
      .orderBy(desc(payrollRuns.month), desc(payrollRuns.id))
      .limit(pageLimit + 1);
    return buildCursorPage(rows, pageLimit, (row) => ({
      sortValue: row.month,
      id: String(row.id),
    }));
  }

  async getRunById(
    orgId: string,
    runId: number,
  ): Promise<{
    run: typeof payrollRuns.$inferSelect;
    checklist: PayrollChecklistItem[];
    varianceSummary: VarianceSummary | null;
    payoutHealth: { failedCount: number; heldCount: number } | null;
  } | null> {
    const run = await this.db
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!run[0]) return null;

    const [toggles, varianceSummary, payoutHealth] = await Promise.all([
      this.getTogglesForRun(orgId, run[0].policyVersionId),
      this.variance.buildSummary(
        orgId,
        run[0].id,
        run[0].month,
        run[0].netTotal,
      ),
      this.employees.getPayoutHealth(orgId, run[0].id, run[0].status),
    ]);

    const checklist = await buildRunChecklist(this.db, orgId, run[0], toggles);

    return { run: run[0], checklist, varianceSummary, payoutHealth };
  }

  async listRunEmployees(
    read: ScopedRead,
    runId: number,
    query: ListRunEmployeesQuery,
  ) {
    return this.employees.listRunEmployees(read, runId, query);
  }

  async getRunEmployee(orgId: string, runId: number, runEmployeeId: number) {
    return this.employees.getRunEmployee(orgId, runId, runEmployeeId);
  }

  async getVariance(orgId: string, runId: number) {
    return this.variance.getVariance(orgId, runId);
  }

  async buildVarianceSummary(
    orgId: string,
    runId: number,
    currentMonth: string,
    currentNetTotal: string | null,
  ): Promise<VarianceSummary | null> {
    return this.variance.buildSummary(
      orgId,
      runId,
      currentMonth,
      currentNetTotal,
    );
  }

  private async getTogglesForRun(
    orgId: string,
    policyVersionId: number | null,
  ): Promise<PayrollToggles | null> {
    if (!policyVersionId) return null;

    const version = await this.db
      .select({
        toggles: payrollPolicyVersions.toggles,
        config: payrollPolicyVersions.config,
      })
      .from(payrollPolicyVersions)
      .where(
        and(
          eq(payrollPolicyVersions.id, policyVersionId),
          eq(payrollPolicyVersions.orgId, orgId),
        ),
      )
      .limit(1);

    const rawToggles = version[0]?.toggles;
    return rawToggles &&
      typeof rawToggles === "object" &&
      !Array.isArray(rawToggles)
      ? (rawToggles as PayrollToggles)
      : null;
  }
}
