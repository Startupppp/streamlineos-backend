/**
 * The gate for the defect class 0770 swept once and 0923/0927 immediately
 * reintroduced: an `ON DELETE SET NULL` that writes a non-nullable column.
 *
 * Two halves, because neither alone is sufficient.
 *
 * The declaration half runs in the default hermetic suite. It catches the one
 * shape Drizzle can express and get wrong — a SET NULL foreign key with no
 * nullable member at all — at the moment the schema is edited, before any
 * migration is written.
 *
 * The catalog half needs a bootstrapped database, because the column list lives
 * only in `pg_constraint.confdelsetcols`. Drizzle cannot declare it and
 * drizzle-kit cannot introspect it: it reads
 * `information_schema.referential_constraints.delete_rule`, which answers
 * "SET NULL" for the correct form and the broken form alike. So no static check
 * over the schema files can see this, and the catalog has to be asked.
 *
 * Run it against a bootstrapped target:
 *   SET_NULL_GATE_DATABASE_URL=postgresql://… \
 *     npx jest src/db/schema/set-null-column-lists.db.spec.ts --maxWorkers=1
 */
import postgres from "postgres";
import * as schema from "./index";
import {
  deriveSetNullDeclarations,
  SET_NULL_COLUMN_SETS_QUERY,
  UNREACHABLE_SET_NULL_QUERY,
} from "./set-null-column-lists";

const GATE_URL = process.env.SET_NULL_GATE_DATABASE_URL;
const describeCatalog = GATE_URL ? describe : describe.skip;

type UnreachableRow = {
  schema: string;
  table: string;
  constraint_name: string;
  definition: string;
};

type ColumnSetRow = {
  schema: string;
  table: string;
  constraint_name: string;
  key_columns: string[];
  set_null_columns: string[];
};

const declarations = () => deriveSetNullDeclarations(schema as Record<string, unknown>);

describe("ON DELETE SET NULL declarations", () => {
  it("declares no SET NULL foreign key whose columns are all non-nullable", () => {
    const offenders = declarations().unreachable.map(
      (fk) => `${fk.table}.${fk.constraint} (${fk.columns.join(", ")})`,
    );
    expect(offenders).toEqual([]);
  });

  it("finds composite SET NULL foreign keys that the catalog must carry a column list for", () => {
    const needList = declarations().declared.filter((fk) => fk.requiresColumnList);
    expect(needList.length).toBeGreaterThan(0);
  });
});

describeCatalog("ON DELETE SET NULL column lists in pg_catalog", () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    if (!GATE_URL) throw new Error("SET_NULL_GATE_DATABASE_URL is required");
    sql = postgres(GATE_URL, { max: 1, prepare: false, onnotice: () => {} });
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it("has no SET NULL foreign key that writes a non-nullable column", async () => {
    const rows = await sql.unsafe<UnreachableRow[]>(UNREACHABLE_SET_NULL_QUERY);
    const offenders = rows.map(
      (row) => `${row.schema}.${row.table}.${row.constraint_name} — ${row.definition}`,
    );
    expect(offenders).toEqual([]);
  });

  it("carries the column list the declaration's nullability implies", async () => {
    const rows = await sql.unsafe<ColumnSetRow[]>(SET_NULL_COLUMN_SETS_QUERY);
    const live = new Map(
      rows.map((row) => [`${row.schema}.${row.table}.${row.constraint_name}`, row]),
    );

    const mismatches: string[] = [];
    for (const fk of declarations().declared) {
      const key = `${fk.schema}.${fk.table}.${fk.constraint}`;
      const row = live.get(key);
      if (!row) continue;
      const expected = [...fk.setNullColumns].sort();
      const actual = [...(row.set_null_columns ?? [])].sort();
      if (expected.join(",") !== actual.join(",")) {
        mismatches.push(`${key}: catalog nulls [${actual.join(", ")}], declaration implies [${expected.join(", ")}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("reaches the constraints it is meant to police", async () => {
    const rows = await sql.unsafe<ColumnSetRow[]>(SET_NULL_COLUMN_SETS_QUERY);
    expect(rows.length).toBeGreaterThan(100);
  });
});
