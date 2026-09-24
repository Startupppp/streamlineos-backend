import { AUTOMATION_TRIGGERS, type AutomationAction, type AutomationCondition } from "../../db/schema";
import type { ActionResult } from "./automation-action-executor.service";

export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export function isValidTrigger(value: string): value is AutomationTrigger {
  return AUTOMATION_TRIGGERS.some((t) => t === value);
}

export interface RuleDefinition {
  id: number;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
}

export interface EvaluationResult {
  matched: boolean;
  actionResults: ActionResult[];
}
