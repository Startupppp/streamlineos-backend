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

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : String(v);
}

export function evaluateCondition(cond: StudioCondition, data: Record<string, unknown>): boolean {
  const actual = data[cond.field];
  switch (cond.operator) {
    case "eq":
      return toStr(actual) === toStr(cond.value);
    case "neq":
      return toStr(actual) !== toStr(cond.value);
    case "gt": {
      const a = toNum(actual);
      const b = toNum(cond.value);
      return a !== null && b !== null && a > b;
    }
    case "lt": {
      const a = toNum(actual);
      const b = toNum(cond.value);
      return a !== null && b !== null && a < b;
    }
    case "contains":
      return toStr(actual).toLowerCase().includes(toStr(cond.value).toLowerCase());
    case "in": {
      const arr = Array.isArray(cond.value) ? cond.value : [cond.value];
      return arr.map(toStr).includes(toStr(actual));
    }
    case "changed_to": {
      const prev = data["_prev"];
      const prevVal = typeof prev === "object" && prev !== null ? (prev as Record<string, unknown>)[cond.field] : undefined;
      return toStr(actual) === toStr(cond.value) && toStr(prevVal) !== toStr(cond.value);
    }
    default:
      return false;
  }
}

export function evaluateConditions(conditions: StudioCondition[], data: Record<string, unknown>): boolean {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  return conditions.every((c) => evaluateCondition(c, data));
}
