import type { AutomationCondition } from "../../db/schema";

export type EventPayload = Record<string, unknown>;

function getFieldValue(payload: EventPayload, field: string): unknown {
  return Object.prototype.hasOwnProperty.call(payload, field) ? payload[field] : undefined;
}

function toComparable(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function evaluateCondition(condition: AutomationCondition, payload: EventPayload): boolean {
  const actual = getFieldValue(payload, condition.field);

  switch (condition.op) {
    case "exists":
      return actual !== undefined && actual !== null && actual !== "";
    case "eq":
      return toComparable(actual) === toComparable(condition.value);
    case "neq":
      return toComparable(actual) !== toComparable(condition.value);
    case "contains":
      return toComparable(actual).toLowerCase().includes(toComparable(condition.value).toLowerCase());
    case "gt": {
      const a = toNumber(actual);
      const b = toNumber(condition.value);
      return a !== null && b !== null && a > b;
    }
    case "lt": {
      const a = toNumber(actual);
      const b = toNumber(condition.value);
      return a !== null && b !== null && a < b;
    }
    default:
      return false;
  }
}

export function evaluateConditions(conditions: AutomationCondition[], payload: EventPayload): boolean {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  return conditions.every((condition) => evaluateCondition(condition, payload));
}
