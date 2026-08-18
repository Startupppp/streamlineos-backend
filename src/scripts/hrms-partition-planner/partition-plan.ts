import {
  approvedHashModulus,
  isHashFamily,
  isRangeFamily,
  monthSchema,
  partitionFamilies,
  type PartitionTable,
} from "./partition-config";

export type RangePartitionPlan = {
  kind: "range";
  parent: PartitionTable;
  child: string;
  month: string;
  from: string;
  to: string;
};

export type HashPartitionPlan = {
  kind: "hash";
  parent: PartitionTable;
  child: string;
  modulus: number;
  remainder: number;
};

export type PartitionPlanItem = RangePartitionPlan | HashPartitionPlan;

export type PartitionPlanInput = {
  tables: PartitionTable[];
  months: string[];
  hashModulus: number | null;
};

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

export function shiftMonth(month: string, offset: number): string {
  const parsed = monthSchema.parse(month);
  const year = Number(parsed.slice(0, 4));
  const monthIndex = Number(parsed.slice(5, 7)) - 1;
  const shiftedIndex = year * 12 + monthIndex + offset;
  const shiftedYear = Math.floor(shiftedIndex / 12);
  const shiftedMonth = (shiftedIndex % 12) + 1;
  if (shiftedYear < 1 || shiftedYear > 9999)
    throw new Error("shifted month is outside the supported range");
  return `${shiftedYear.toString().padStart(4, "0")}-${pad(shiftedMonth)}`;
}

export function currentAndNextThree(now: Date): string[] {
  const year = now.getUTCFullYear().toString().padStart(4, "0");
  const current = `${year}-${pad(now.getUTCMonth() + 1)}`;
  return [0, 1, 2, 3].map((offset) => shiftMonth(current, offset));
}

function rangeChildName(parent: PartitionTable, month: string): string {
  return `${parent}_y${month.slice(0, 4)}m${month.slice(5, 7)}`;
}

function hashChildName(parent: PartitionTable, remainder: number): string {
  return `${parent}_h${remainder.toString().padStart(2, "0")}`;
}

function assertIdentifier(identifier: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(identifier))
    throw new Error(`unsafe partition identifier: ${identifier}`);
}

function buildRangeItems(
  parent: PartitionTable,
  months: string[],
): RangePartitionPlan[] {
  return months.map((month) => {
    const parsed = monthSchema.parse(month);
    const child = rangeChildName(parent, parsed);
    assertIdentifier(child);
    return {
      kind: "range",
      parent,
      child,
      month: parsed,
      from: `${parsed}-01`,
      to: `${shiftMonth(parsed, 1)}-01`,
    };
  });
}

function buildHashItems(
  parent: PartitionTable,
  modulus: number,
): HashPartitionPlan[] {
  return Array.from({ length: modulus }, (_, remainder) => {
    const child = hashChildName(parent, remainder);
    assertIdentifier(child);
    return { kind: "hash", parent, child, modulus, remainder };
  });
}

export function buildPartitionPlan(input: PartitionPlanInput): PartitionPlanItem[] {
  const plan: PartitionPlanItem[] = [];
  for (const table of input.tables) {
    const family = partitionFamilies[table];
    if (isRangeFamily(family)) {
      plan.push(...buildRangeItems(table, input.months));
      continue;
    }
    if (isHashFamily(family)) {
      if (input.hashModulus !== approvedHashModulus)
        throw new Error(`hash modulus must be ${approvedHashModulus}`);
      plan.push(...buildHashItems(table, input.hashModulus));
    }
  }
  return plan;
}
