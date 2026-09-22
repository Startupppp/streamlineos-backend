import type { hrWorkflowObjectTypeEnum } from "../../../db/schema/hr/workflow-engine";

export type HrWorkflowObjectType = typeof hrWorkflowObjectTypeEnum.enumValues[number];

export interface ResolvedStep {
  stepOrder: number;
  name: string;
  approverType: string;
  approverValue?: string | null;
  mode: string;
  slaHours?: number | null;
  escalationApproverType?: string | null;
  escalationApproverValue?: string | null;
  condition?: { field: string; operator: string; value: unknown } | null;
}

export interface WorkflowStepRouting {
  rung: string | null;
  approverUserIds: string[];
  assignedToUserId: string | null;
  delegation: { fromUserId: string; toUserId: string; endsAt: string } | null;
  explanation: string;
  dueAt: string;
  escalationRung: string | null;
}

export const APPROVAL_ROUTING_CONTEXT_KEY = "approvalRouting";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isWorkflowStepRouting(value: unknown): value is WorkflowStepRouting {
  if (typeof value !== "object" || value === null) return false;
  const routing = value as Record<string, unknown>;
  return (
    isStringArray(routing["approverUserIds"]) &&
    typeof routing["explanation"] === "string" &&
    typeof routing["dueAt"] === "string"
  );
}

export function persistedStepRouting(context: Record<string, unknown>, stepOrder: number): WorkflowStepRouting | null {
  const routing = context[APPROVAL_ROUTING_CONTEXT_KEY];
  if (typeof routing !== "object" || routing === null) return null;
  const entry = (routing as Record<string, unknown>)[String(stepOrder)];
  return isWorkflowStepRouting(entry) ? entry : null;
}

export function withStepRouting(
  context: Record<string, unknown>,
  stepOrder: number,
  routing: WorkflowStepRouting,
): Record<string, unknown> {
  const existing = context[APPROVAL_ROUTING_CONTEXT_KEY];
  const table = typeof existing === "object" && existing !== null ? { ...(existing as Record<string, unknown>) } : {};
  table[String(stepOrder)] = routing;
  return { ...context, [APPROVAL_ROUTING_CONTEXT_KEY]: table };
}
