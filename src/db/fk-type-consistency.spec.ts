import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";

// A column narrower than the key it references overflows on a date nobody has diaried.

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
