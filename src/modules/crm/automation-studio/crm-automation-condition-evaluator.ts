import { evaluateNormalizedCondition, evaluateNormalizedConditions, type NormalizedCondition } from "../../automation/shared-condition-evaluator";

export type StudioEventPayload = {
  entityType: string;
  entityId: string;
  data: Record<string, unknown>;
  actorId?: string;
  depth?: number;
};

export interface StudioCondition {
  field: string;
  operator: "eq" | "neq" | "gt" | "lt" | "contains" | "in" | "changed_to";
  value: string | string[];
}

function toNormalized(c: StudioCondition): NormalizedCondition {
  return { field: c.field, op: c.operator, value: c.value };
}

export function evaluateCondition(cond: StudioCondition, data: Record<string, unknown>): boolean {
  return evaluateNormalizedCondition(toNormalized(cond), data);
}

export function evaluateConditions(conditions: StudioCondition[], data: Record<string, unknown>): boolean {
  return evaluateNormalizedConditions(conditions.map(toNormalized), data);
}
