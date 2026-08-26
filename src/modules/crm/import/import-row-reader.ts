import { customKeyFor, normaliseHeader, type MappedColumn } from "./column-mapping";
import { coerceFor, type ImportEntity } from "./import-entities";

/**
 * Turning one line of a file into named values, per the confirmed mapping.
 *
 * Its own file because both halves of the planner need it — the generic passes
 * and the party-specific blocking — and putting it in either would make the
 * other import that one, which is a cycle rather than a dependency.
 */

/** Read one spreadsheet row into named values, per the confirmed mapping. */
export function readRow(
  entity: ImportEntity,
  columns: readonly MappedColumn[],
  cells: readonly string[],
): { values: Record<string, string>; customFields: Record<string, string> } {
  const coerce = coerceFor(entity);
  const values: Record<string, string> = {};
  const customFields: Record<string, string> = {};

  columns.forEach((column, index) => {
    const cell = (cells[index] ?? "").trim();
    if (!cell) return;

    if (column.mapping.kind === "mapped") {
      const value = coerce(column.mapping.field, cell);
      if (value !== null) values[column.mapping.field] = value;
      // A cell that cannot be the field it was mapped to still came out of the
      // user's file, and a column they can see and cannot find afterwards is
      // data loss they discover months later. It keeps its own header's key.
      else customFields[customKeyFor(normaliseHeader(column.header))] = cell;
    } else if (column.mapping.kind === "custom") customFields[column.mapping.key] = cell;
    // `ambiguous` and `unmapped` contribute nothing: an unanswered question must
    // not quietly become an answer.
  });

  return { values, customFields };
}
