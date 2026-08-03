import { evaluateNormalizedConditions, type NormalizedCondition } from "../../automation/shared-condition-evaluator";

export interface StudioCondition {
  field: string;
  operator: "eq" | "neq" | "gt" | "lt" | "contains" | "in" | "changed_to";
  value: string | string[];
}

function toNormalized(c: StudioCondition): NormalizedCondition {
  return { field: c.field, op: c.operator, value: c.value };
}

export function evaluateConditions(conditions: StudioCondition[], data: Record<string, unknown>): boolean {
  return evaluateNormalizedConditions(conditions.map(toNormalized), data);
}
