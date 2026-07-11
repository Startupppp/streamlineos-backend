import { Injectable } from "@nestjs/common";
import { hrWorkflowObjectTypeEnum } from "../../db/schema/hr/workflow-engine";
import type { HrWorkflowStarterPort } from "../hr-automations/hr-workflow-starter.port";
import { HrWorkflowEngineService } from "./hr-workflow-engine.service";

type HrWorkflowObjectType = (typeof hrWorkflowObjectTypeEnum.enumValues)[number];

function isObjectType(value: string): value is HrWorkflowObjectType {
  return hrWorkflowObjectTypeEnum.enumValues.some((candidate) => candidate === value);
}

function readContextString(context: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = context[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

@Injectable()
export class HrWorkflowStarterAdapter implements HrWorkflowStarterPort {
  constructor(private readonly engine: HrWorkflowEngineService) {}

  async startWorkflow(
    orgId: string,
    workflowId: string,
    context: Record<string, unknown>,
  ): Promise<{ executionId: string } | null> {
    if (!isObjectType(workflowId)) return null;
    const subjectEmployeeId = readContextString(context, ["subjectEmployeeId", "employeeId", "userId"]);
    const requestedByUserId =
      readContextString(context, ["actorUserId", "requestedByUserId", "userId"]) ?? subjectEmployeeId;
    const objectId = readContextString(context, ["objectId", "entityId"]) ?? subjectEmployeeId;
    if (!subjectEmployeeId || !requestedByUserId || !objectId) return null;
    const instance = await this.engine.startWorkflow({
      orgId,
      objectType: workflowId,
      objectId,
      requestedByUserId,
      subjectEmployeeId,
      context,
    });
    return { executionId: String(instance.id) };
  }
}
