import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/**
 * A foreign key whose column is narrower than the key it references is a bug with a delivery date.
 *
 * SCH-001 widened `notifications.id` from int4 to bigint "while the table held 3 rows", because a
 * fan-out-on-write feed reaches 2,147,483,647 at the stated scale. Its dependent key was missed:
 * `notification_audit_logs.notification_id` stayed `integer`. Postgres accepts the constraint, so
 * nothing complains until the day an id exceeds int4 and every audit insert starts failing.
 *
 * c21-04 asks for exactly this class of widening ahead of volume, so the invariant is worth pinning
 * rather than fixing once.
 *
 * Types are resolved by name from each table's own config. Calling `getSQLType()` on the column
 * objects a foreign-key reference hands back overflows the stack — they are `ExtraConfigColumn`
 * proxies that delegate to themselves — which is the same Drizzle self-reference that makes
 * `JSON.stringify` throw on a captured condition.
 */

const INTEGER_WIDTH: Record<string, number> = {
  smallint: 2,
  integer: 4,
  bigint: 8,
};

function buildTypeIndex(): Map<string, Map<string, string>> {
  const index = new Map<string, Map<string, string>>();
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);
    const columns = new Map<string, string>();
    for (const column of config.columns) columns.set(column.name, column.getSQLType());
    index.set(config.name, columns);
  }
  return index;
}

interface Mismatch {
  readonly from: string;
  readonly to: string;
  readonly fromType: string;
  readonly toType: string;
}

function collectMismatches(): { mismatches: Mismatch[]; comparisons: number } {
  const types = buildTypeIndex();
  const mismatches: Mismatch[] = [];
  let comparisons = 0;

  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);
    const localTypes = types.get(config.name);
    if (!localTypes) continue;

    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      const foreignTable = getTableConfig(ref.foreignTable).name;
      const foreignTypes = types.get(foreignTable);
      if (!foreignTypes) continue;

      for (let i = 0; i < ref.columns.length; i += 1) {
        const local = ref.columns[i];
        const foreign = ref.foreignColumns[i];
        if (!local || !foreign) continue;

        const localType = localTypes.get(local.name);
        const foreignType = foreignTypes.get(foreign.name);
        if (!localType || !foreignType) continue;

        comparisons += 1;
        if (localType === foreignType) continue;

        const localWidth = INTEGER_WIDTH[localType];
        const foreignWidth = INTEGER_WIDTH[foreignType];
        if (localWidth === undefined || foreignWidth === undefined) continue;
        if (localWidth >= foreignWidth) continue;

        mismatches.push({
          from: `${config.name}.${local.name}`,
          to: `${foreignTable}.${foreign.name}`,
          fromType: localType,
          toType: foreignType,
        });
      }
    }
  }

  return { mismatches, comparisons };
}

describe("foreign key type consistency", () => {
  it("actually compares foreign keys, so a broken walk cannot pass vacuously", () => {
    expect(collectMismatches().comparisons).toBeGreaterThan(100);
  });

  it("never references a wider key from a narrower column", () => {
    const offenders = collectMismatches().mismatches.map(
      (m) => `${m.from} (${m.fromType}) -> ${m.to} (${m.toType})`,
    );
    expect(offenders).toEqual([]);
  });
});
