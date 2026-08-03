import type { AutomationCondition } from "../../db/schema";
import { evaluateNormalizedConditions, type NormalizedCondition } from "./shared-condition-evaluator";

export type EventPayload = Record<string, unknown>;

export function evaluateConditions(conditions: AutomationCondition[], payload: EventPayload): boolean {
  const normalized: NormalizedCondition[] = conditions.map((c) => ({
    field: c.field,
    op: c.op,
    value: c.value,
  }));
  return evaluateNormalizedConditions(normalized, payload);
}
