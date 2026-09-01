import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { hrSimulations } from "../../../../db/schema/hr/enterprise-ops";
import { HrPolicyEvaluationService } from "../../policies/hr-policy-evaluation.service";
import type {
  SimulatePolicyInput,
  SimulateLeaveBalanceInput,
  SimulateApprovalRoutingInput,
  SimulatePayrollImpactInput,
  CompareInput,
  ListSimulationsInput,
} from "../dto/simulator.schemas";
import { buildCursorPage, decodeCursor } from "../../../../common/pagination/cursor";
import { keysetBeforeUuid } from "../../../../common/pagination/keyset";

const SIM_LABEL = "Simulation — no records changed";

@Injectable()
export class SimulatorService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly policyEval: HrPolicyEvaluationService,
  ) {}

  private async persist<
    I extends Record<string, unknown>,
    R extends Record<string, unknown>,
  >(
    orgId: string,
    createdBy: string,
    type: "policy" | "leave" | "attendance" | "approval" | "payroll",
    input: I,
    result: R,
  ) {
    await this.db.insert(hrSimulations).values({
      orgId,
      type,
      input,
      result,
      createdBy,
    });
  }

  async simulatePolicy(orgId: string, actorId: string, input: SimulatePolicyInput) {
    const today = new Date().toISOString().slice(0, 10);

    const policy = await this.policyEval.evaluatePolicy(
      orgId,
      input.employeeId,
      input.policyType as Parameters<typeof this.policyEval.evaluatePolicy>[2],
      today,
    );

    const result = {
      simulation: SIM_LABEL,
      matchedPolicy: policy ?? null,
      hypotheticalContext: input.hypotheticalContext,
    };

    await this.persist(orgId, actorId, "policy", input, result);
    return result;
  }

  async simulateLeaveBalance(orgId: string, actorId: string, input: SimulateLeaveBalanceInput) {
    const rows = await this.db.execute(
      sql`SELECT balance FROM hr_leave_ledger
          WHERE org_id = ${orgId} AND user_id = ${input.employeeId} AND leave_type_id = ${input.leaveTypeId}
          ORDER BY created_at DESC LIMIT 1`,
    );

    const currentBalance = rows.length > 0
      ? Number((rows[0] as Record<string, unknown>)["balance"] ?? 0)
      : 0;

    const projectionDate = new Date(input.projectionDate);
    const today = new Date();
    const monthsDiff = Math.max(
      0,
      (projectionDate.getFullYear() - today.getFullYear()) * 12 +
        (projectionDate.getMonth() - today.getMonth()),
    );

    const hypotheticalRate = input.hypotheticalAccrualRate ?? 1.5;
    const projectedBalance = currentBalance + hypotheticalRate * monthsDiff;

    const result = {
      simulation: SIM_LABEL,
      currentBalance,
      hypotheticalAccrualRate: hypotheticalRate,
      projectionMonths: monthsDiff,
      projectedBalance,
      projectionDate: input.projectionDate,
    };

    await this.persist(orgId, actorId, "leave", input, result);
    return result;
  }

  async simulateApprovalRouting(
    orgId: string,
    actorId: string,
    input: SimulateApprovalRoutingInput,
  ) {
    const rows = await this.db.execute(
      sql`SELECT wd.id, wd.name, ws.id as step_id, ws.step_order, ws.approver_type, ws.approver_value as approver_ref
          FROM hr_workflow_definitions wd
          INNER JOIN hr_workflow_steps ws ON ws.definition_id = wd.id
          WHERE wd.org_id = ${orgId} AND wd.object_type = ${input.objectType} AND wd.status = 'active'
          ORDER BY ws.step_order ASC`,
    );

    const steps = rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        stepId: String(row["step_id"] ?? ""),
        stepOrder: Number(row["step_order"] ?? 0),
        approverType: String(row["approver_type"] ?? ""),
        approverRef: row["approver_ref"],
        workflowName: String(row["name"] ?? ""),
      };
    });

    const result = {
      simulation: SIM_LABEL,
      objectType: input.objectType,
      resolvedSteps: steps,
      hypotheticalContext: input.hypotheticalContext,
    };

    await this.persist(orgId, actorId, "approval", input, result);
    return result;
  }

  async simulatePayrollImpact(
    orgId: string,
    actorId: string,
    input: SimulatePayrollImpactInput,
  ) {
    const rows = await this.db.execute(
      sql`SELECT annual_ctc FROM employee_salary_profiles
          WHERE org_id = ${orgId} AND user_id = ${input.employeeId} AND status = 'ACTIVE'
          ORDER BY effective_from DESC LIMIT 1`,
    );

    const lastGross = rows.length > 0
      ? Number((rows[0] as Record<string, unknown>)["annual_ctc"] ?? 0)
      : 0;

    let totalEarningsDelta = 0;
    let totalDeductionsDelta = 0;

    for (const comp of input.hypotheticalComponents) {
      if (comp.type === "earning") totalEarningsDelta += comp.amount;
      else totalDeductionsDelta += comp.amount;
    }

    const projectedGross = lastGross + totalEarningsDelta - totalDeductionsDelta;

    const result = {
      simulation: SIM_LABEL,
      currentGross: lastGross,
      hypotheticalComponents: input.hypotheticalComponents,
      totalEarningsDelta,
      totalDeductionsDelta,
      projectedGross,
      effectiveDate: input.effectiveDate,
    };

    await this.persist(orgId, actorId, "payroll", input, result);
    return result;
  }

  async compare(orgId: string, actorId: string, input: CompareInput) {
    const today = new Date().toISOString().slice(0, 10);

    const resolvedPolicy = await this.policyEval.evaluatePolicy(
      orgId,
      input.employeeId,
      input.policyType as Parameters<typeof this.policyEval.evaluatePolicy>[2],
      today,
    );

    const result = {
      simulation: SIM_LABEL,
      employeeId: input.employeeId,
      policyType: input.policyType,
      oldPolicyId: input.oldPolicyId,
      newPolicyId: input.newPolicyId,
      resolvedOldPolicy: resolvedPolicy,
      resolvedNewPolicy: resolvedPolicy,
    };

    await this.persist(orgId, actorId, "policy", input, result);
    return result;
  }

  async listHistory(orgId: string, input: ListSimulationsInput) {
    const { cursor, limit, type } = input;

    const conditions = [eq(hrSimulations.orgId, orgId)];
    if (type) conditions.push(eq(hrSimulations.type, type));
    const position = decodeCursor(cursor);
    if (cursor !== undefined && !position)
      throw new BadRequestException("Invalid pagination cursor");
    if (position)
      conditions.push(keysetBeforeUuid(hrSimulations.createdAt, hrSimulations.id, position));

    const where = and(...conditions);

    const rows = await this.db
      .select()
      .from(hrSimulations)
      .where(where)
      .orderBy(desc(hrSimulations.createdAt), desc(hrSimulations.id))
      .limit(limit + 1);
    const page = buildCursorPage(rows, limit, (simulation) => ({
      sortValue: simulation.createdAt.toISOString(),
      id: simulation.id,
    }));
    return { data: page.data, pagination: page.pagination };
  }
}
