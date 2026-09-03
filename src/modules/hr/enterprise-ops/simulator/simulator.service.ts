import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { hrSimulations } from "../../../../db/schema/hr/enterprise-ops";
import {
  hrWorkflowDefinitions,
  hrWorkflowObjectTypeEnum,
  hrWorkflowSteps,
  organizationMembers,
  users,
} from "../../../../db/schema";
import { HrPolicyEvaluationService } from "../../policies/hr-policy-evaluation.service";
import { HrWorkflowApproverService } from "../../workflows/hr-workflow-approver.service";
import type { HrWorkflowObjectType } from "../../workflows/hr-workflow-engine.types";
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

const HR_WORKFLOW_OBJECT_TYPES: readonly string[] = hrWorkflowObjectTypeEnum.enumValues;

function isHrWorkflowObjectType(value: string): value is HrWorkflowObjectType {
  return HR_WORKFLOW_OBJECT_TYPES.includes(value);
}

@Injectable()
export class SimulatorService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly policyEval: HrPolicyEvaluationService,
    private readonly approvers: HrWorkflowApproverService,
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
    const [subject] = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, input.employeeId)))
      .limit(1);
    if (!subject) throw new NotFoundException("Employee not found");

    const definition = isHrWorkflowObjectType(input.objectType)
      ? (await this.db
          .select({
            id: hrWorkflowDefinitions.id,
            name: hrWorkflowDefinitions.name,
            version: hrWorkflowDefinitions.version,
          })
          .from(hrWorkflowDefinitions)
          .where(
            and(
              eq(hrWorkflowDefinitions.orgId, orgId),
              eq(hrWorkflowDefinitions.objectType, input.objectType),
              eq(hrWorkflowDefinitions.status, "active"),
              eq(hrWorkflowDefinitions.isDefault, true),
              isNull(hrWorkflowDefinitions.deletedAt),
            ),
          )
          .limit(1))[0] ?? null
      : null;

    const steps = definition
      ? await this.db
          .select()
          .from(hrWorkflowSteps)
          .where(and(eq(hrWorkflowSteps.orgId, orgId), eq(hrWorkflowSteps.definitionId, definition.id)))
          .orderBy(asc(hrWorkflowSteps.stepOrder))
          .limit(20)
      : [];

    const approverIdsPerStep = await Promise.all(
      steps.map((step) => this.approvers.resolveApprovers(step, input.employeeId, orgId)),
    );

    const allApproverIds = [...new Set(approverIdsPerStep.flat())];
    const approverRows = allApproverIds.length > 0
      ? await this.db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, allApproverIds))
          .limit(allApproverIds.length)
      : [];
    const approverById = new Map(approverRows.map((row) => [row.id, row]));

    const resolvedSteps = steps.map((step, index) => ({
      stepId: String(step.id),
      stepOrder: step.stepOrder,
      stepName: step.name,
      approverType: step.approverType,
      approverRef: step.approverValue,
      mode: step.mode,
      workflowName: definition?.name ?? "",
      approvers: (approverIdsPerStep[index] ?? []).map((userId) => ({
        userId,
        name: approverById.get(userId)?.name ?? null,
        email: approverById.get(userId)?.email ?? null,
      })),
    }));

    const result = {
      simulation: SIM_LABEL,
      objectType: input.objectType,
      employeeId: input.employeeId,
      matchedWorkflow: definition
        ? { id: definition.id, name: definition.name, version: definition.version }
        : null,
      resolvedSteps,
      unresolvedSteps: resolvedSteps.filter((step) => step.approvers.length === 0).map((step) => step.stepOrder),
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
