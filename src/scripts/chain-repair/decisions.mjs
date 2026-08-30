export const CHAIN = "chain";
export const CONTROL_PLANE = "control-plane";

export const CONFLICTS = [
  {
    column: "public.journal_lines.department_id",
    winner: CHAIN,
    reason:
      "accounting.ts declares departmentId as text referencing orgUnits.id, which is text. The" +
      " control plane holds integer, which is why fk_journal_lines_department could never be" +
      " created there.",
  },
  {
    column: "public.fin_budget_lines.department_id",
    winner: CHAIN,
    reason:
      "finance-planning.ts declares departmentId as text referencing orgUnits.id. Same integer" +
      " drift as journal_lines, same missing foreign key.",
  },
  {
    column: "public.journal_lines.org_id",
    winner: CHAIN,
    reason:
      "0320 makes the denormalised tenant column NOT NULL so the RLS policy cannot be evaded by" +
      " a null. The control plane holds it nullable, so a row with no tenant is representable.",
  },
  {
    column: "public.custom_field_definitions.name",
    winner: CONTROL_PLANE,
    reason:
      "custom-field-engine.ts declares key, project_id, display_order, settings, is_sensitive and" +
      " category. 0352 renamed name to key; it fails on a cold build because project_id is absent," +
      " so the cell is stranded on the pre-0352 shape.",
  },
  {
    column: "public.custom_field_definitions.sort_order",
    winner: CONTROL_PLANE,
    reason: "Renamed to display_order by 0352, which cannot run on a cold build.",
  },
  {
    column: "public.custom_field_definitions.created_by",
    winner: CONTROL_PLANE,
    reason: "Dropped by 0352, which cannot run on a cold build.",
  },
];

export const DROP_IN_CELL = CONFLICTS.filter((c) => c.winner === CONTROL_PLANE).map(
  (c) => c.column,
);

const byColumn = new Map(CONFLICTS.map((c) => [c.column, c]));

export function winnerFor(columnKey) {
  return byColumn.get(columnKey)?.winner ?? null;
}

export function isSuppressed(columnKey, direction) {
  const winner = winnerFor(columnKey);
  if (winner === null) return false;
  return direction === "forward" ? winner === CHAIN : winner === CONTROL_PLANE;
}

export function dependsOnSuppressedColumn(object, direction) {
  for (const conflict of CONFLICTS) {
    if (!isSuppressed(conflict.column, direction)) continue;
    const parts = conflict.column.split(".");
    const column = parts[parts.length - 1];
    const tableKey = parts.slice(0, -1).join(".");
    if (object.tableKey !== tableKey) continue;
    if (new RegExp(`\\b${column}\\b`).test(object.def)) return true;
  }
  return false;
}
