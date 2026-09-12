/**
 * The VERDICT: put a live column and a declared column side by side and say
 * which of the four buckets the difference falls in. Split out of the entry
 * script under CLAUDE.md §7; the entry file carries the defect narrative.
 *
 *   writeBlocking     live, required on INSERT, undeclared, and no BEFORE
 *                     INSERT row trigger supplies it — Drizzle raises 23502.
 *                     "Supplies" means the trigger's args name the column OR its
 *                     function body assigns it; a shared function names its target
 *                     only in the body, and reading the args alone reported a false
 *                     23502 on organization_saga_steps.
 *   readBlocking      declared with no live column — an unprojected read
 *                     raises 42703.
 *   triggerSupplied   required on INSERT but filled by a trigger, so it is
 *                     undeclared on purpose. Reported, never failed.
 *   invisible         nullable or defaulted and undeclared. Reported, never
 *                     failed.
 */

import type { LiveColumn, LiveTrigger } from "./catalog";
import { requiresValueOnInsert, triggerSuppliesColumn } from "./catalog";
import type { DeclaredTable } from "./declared";

export interface DriftFinding {
  readonly key: string;
  readonly column: string;
  readonly detail: string;
}

export interface DriftReport {
  readonly writeBlocking: readonly DriftFinding[];
  readonly readBlocking: readonly DriftFinding[];
  readonly triggerSupplied: readonly DriftFinding[];
  readonly invisible: readonly DriftFinding[];
  readonly undeclaredTables: readonly string[];
  readonly missingTables: readonly string[];
  readonly comparedTables: number;
}

export function compare(
  declared: readonly DeclaredTable[],
  live: readonly LiveColumn[],
  triggers: readonly LiveTrigger[] = [],
): DriftReport {
  const triggersByTable = new Map<string, LiveTrigger[]>();
  for (const trigger of triggers) {
    const key = `${trigger.schema}.${trigger.table}`;
    const bucket = triggersByTable.get(key);
    if (bucket === undefined) triggersByTable.set(key, [trigger]);
    else bucket.push(trigger);
  }

  const liveByTable = new Map<string, LiveColumn[]>();
  for (const column of live) {
    const key = `${column.schema}.${column.table}`;
    const bucket = liveByTable.get(key);
    if (bucket === undefined) liveByTable.set(key, [column]);
    else bucket.push(column);
  }

  const writeBlocking: DriftFinding[] = [];
  const readBlocking: DriftFinding[] = [];
  const triggerSupplied: DriftFinding[] = [];
  const invisible: DriftFinding[] = [];
  const missingTables: string[] = [];
  const declaredKeys = new Set<string>();
  let comparedTables = 0;

  for (const table of declared) {
    const key = `${table.schema}.${table.table}`;
    declaredKeys.add(key);
    const liveColumns = liveByTable.get(key);
    if (liveColumns === undefined) {
      missingTables.push(key);
      continue;
    }
    comparedTables += 1;
    const liveNames = new Set(liveColumns.map((column) => column.column));

    for (const column of liveColumns) {
      if (table.columns.has(column.column)) continue;
      if (requiresValueOnInsert(column)) {
        const supplier = (triggersByTable.get(key) ?? []).find((trigger) =>
          triggerSuppliesColumn(trigger, column.column),
        );
        if (supplier === undefined)
          writeBlocking.push({
            key,
            column: column.column,
            detail: "live NOT NULL with no default and undeclared — every Drizzle INSERT raises 23502",
          });
        else
          triggerSupplied.push({
            key,
            column: column.column,
            detail: `supplied by BEFORE INSERT trigger ${supplier.trigger} — undeclared on purpose`,
          });
      } else
        invisible.push({
          key,
          column: column.column,
          detail: column.notNull ? "live NOT NULL with a default, undeclared" : "live nullable, undeclared",
        });
    }

    for (const name of table.columns) {
      if (liveNames.has(name)) continue;
      readBlocking.push({
        key,
        column: name,
        detail: "declared with no live column — every unprojected read raises 42703",
      });
    }
  }

  const undeclaredTables = [...liveByTable.keys()].filter((key) => !declaredKeys.has(key)).sort();

  const order = (a: DriftFinding, b: DriftFinding): number =>
    `${a.key}.${a.column}`.localeCompare(`${b.key}.${b.column}`);
  return {
    writeBlocking: writeBlocking.sort(order),
    readBlocking: readBlocking.sort(order),
    triggerSupplied: triggerSupplied.sort(order),
    invisible: invisible.sort(order),
    undeclaredTables,
    missingTables: missingTables.sort(),
    comparedTables,
  };
}
