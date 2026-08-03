export type ConditionOp =
  | "eq"
  | "neq"
  | "contains"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "in"
  | "exists"
  | "changed_to";

export interface NormalizedCondition {
  field: string;
  op: ConditionOp;
  value?: string | number | boolean | string[];
}

function getFieldValue(payload: Record<string, unknown>, field: string): unknown {
  return Object.prototype.hasOwnProperty.call(payload, field) ? payload[field] : undefined;
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : String(v);
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function getPrevFieldValue(payload: Record<string, unknown>, field: string): unknown {
  const prev = payload["_prev"];
  if (typeof prev !== "object" || prev === null) return undefined;
  return Object.prototype.hasOwnProperty.call(prev, field)
    ? (prev as Record<string, unknown>)[field]
    : undefined;
}

export function evaluateNormalizedCondition(
  condition: NormalizedCondition,
  payload: Record<string, unknown>,
): boolean {
  const actual = getFieldValue(payload, condition.field);

  switch (condition.op) {
    case "exists":
      return actual !== undefined && actual !== null && actual !== "";
    case "eq":
      return toStr(actual) === toStr(condition.value);
    case "neq":
      return toStr(actual) !== toStr(condition.value);
    case "contains":
      return toStr(actual).toLowerCase().includes(toStr(condition.value).toLowerCase());
    case "gt": {
      const a = toNum(actual);
      const b = toNum(condition.value);
      return a !== null && b !== null && a > b;
    }
    case "lt": {
      const a = toNum(actual);
      const b = toNum(condition.value);
      return a !== null && b !== null && a < b;
    }
    case "gte": {
      const a = toNum(actual);
      const b = toNum(condition.value);
      return a !== null && b !== null && a >= b;
    }
    case "lte": {
      const a = toNum(actual);
      const b = toNum(condition.value);
      return a !== null && b !== null && a <= b;
    }
    case "in": {
      const arr = Array.isArray(condition.value)
        ? condition.value
        : condition.value !== undefined
          ? [String(condition.value)]
          : [];
      return arr.map(toStr).includes(toStr(actual));
    }
    case "changed_to": {
      const prevVal = getPrevFieldValue(payload, condition.field);
      return (
        toStr(actual) === toStr(condition.value) &&
        toStr(prevVal) !== toStr(condition.value)
      );
    }
  }
}

export function evaluateNormalizedConditions(
  conditions: NormalizedCondition[],
  payload: Record<string, unknown>,
): boolean {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  return conditions.every((c) => evaluateNormalizedCondition(c, payload));
}
