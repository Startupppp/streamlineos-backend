import assert from "node:assert/strict";
import {
  UnsupportedTableShapeError,
  addColumn,
  addConstraint,
  columnClause,
  createIndex,
  createPolicy,
  createSchema,
  createTable,
  createTrigger,
  createType,
  enableRls,
  grantAppRole,
  guarded,
  ident,
  join,
  literal,
  qualify,
} from "../chain-repair/emit-ddl.mjs";
import {
  CHAIN,
  CONFLICTS,
  CONTROL_PLANE,
  DROP_IN_CELL,
  dependsOnSuppressedColumn,
  isSuppressed,
  winnerFor,
} from "../chain-repair/decisions.mjs";

const BREAK = "--> statement-breakpoint";

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`PASS  ${name}\n`);
  } catch (e) {
    process.stderr.write(`FAIL  ${name}\n`);
    process.stderr.write(`      ${e.message}\n`);
    process.exitCode = 1;
  }
}

function doBlocksIn(sql) {
  return sql.match(/DO \$repair\$ BEGIN[\s\S]*?END \$repair\$;/g) ?? [];
}

const column = (over = {}) => ({
  schema: "public",
  table: "widgets",
  name: "org_id",
  ord: 1,
  type: "text",
  notnull: false,
  identity: "",
  generated: "",
  defaultExpr: null,
  collation: null,
  ...over,
});

const constraint = (over = {}) => ({
  schema: "public",
  table: "widgets",
  tableKey: "public.widgets",
  name: "widgets_org_id_fk",
  type: "f",
  def: 'FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE',
  ...over,
});

test("identifiers and literals are quoted, and embedded quotes are escaped", () => {
  assert.equal(ident('we"ird'), '"we""ird"');
  assert.equal(literal("O'Brien"), "'O''Brien'");
  assert.equal(qualify("public", "widgets"), '"public"."widgets"');
});

// The invariant the whole file format depends on. Drizzle splits a migration on the
// statement-breakpoint marker, so a marker inside a DO block tears it into fragments that
// are not valid SQL on their own -- and the failure is a syntax error a long way from
// its cause.
test("a guarded block never contains a statement-breakpoint marker", () => {
  const block = guarded("SELECT 1 FROM pg_class", "ALTER TABLE x ADD COLUMN y text");
  assert.ok(!block.includes(BREAK));
  assert.ok(block.startsWith("DO $repair$ BEGIN"));
  assert.ok(block.trimEnd().endsWith("END $repair$;"));
});

test("no emitter puts a statement-breakpoint inside a DO block", () => {
  const emitted = [
    addConstraint(constraint()),
    createTrigger({
      schema: "public",
      table: "widgets",
      name: "trg_set_org_id",
      def: "CREATE TRIGGER trg_set_org_id BEFORE INSERT ON widgets FOR EACH ROW EXECUTE FUNCTION f()",
    }),
    createPolicy({
      schema: "public",
      table: "widgets",
      name: "tenant_isolation",
      permissive: "PERMISSIVE",
      roles: ["streamline_app"],
      cmd: "ALL",
      qual: "org_id = app.current_org_id()",
      withCheck: "org_id = app.current_org_id()",
    }),
    createType({ schema: "public", name: "mood" }, [
      { label: "ok", ord: 1 },
      { label: "sad", ord: 2 },
    ]),
    addColumn(column({ notnull: true })),
  ];
  for (const sql of emitted)
    for (const block of doBlocksIn(sql))
      assert.ok(!block.includes(BREAK), `block contained the marker:\n${block}`);
});

test("addColumn separates ADD COLUMN from SET NOT NULL with a marker OUTSIDE the block", () => {
  const sql = addColumn(column({ notnull: true }));
  assert.ok(sql.includes(BREAK), "the two statements must be separable");
  const blocks = doBlocksIn(sql);
  assert.equal(blocks.length, 1);
  assert.ok(!blocks[0].includes(BREAK));
});

test("a nullable column emits no NOT NULL statement at all", () => {
  const sql = addColumn(column({ notnull: false }));
  assert.ok(!sql.includes("SET NOT NULL"));
  assert.ok(!sql.includes(BREAK));
});

test("join separates statements with the marker", () => {
  assert.equal(join(["a;", "b;"]), `a;\n${BREAK}\nb;`);
});

test("join drops nulls and empty strings rather than emitting blank statements", () => {
  assert.equal(join(["a;", null, "", "b;"]), `a;\n${BREAK}\nb;`);
});

// Idempotence is what makes the file safe to replay against the database that supplied it.
test("every emitted statement is idempotent", () => {
  assert.ok(createSchema({ name: "build" }).includes("IF NOT EXISTS"));
  assert.ok(
    createTable({ schema: "public", name: "widgets", kind: "r", parent: null }, [
      column(),
    ]).includes("CREATE TABLE IF NOT EXISTS"),
  );
  assert.ok(addColumn(column()).includes("ADD COLUMN IF NOT EXISTS"));
  assert.ok(
    createIndex({ def: "CREATE INDEX idx_a ON public.widgets USING btree (org_id)" }).includes(
      "CREATE INDEX IF NOT EXISTS",
    ),
  );
  assert.ok(
    createIndex({
      def: "CREATE UNIQUE INDEX idx_b ON public.widgets USING btree (org_id)",
    }).includes("CREATE UNIQUE INDEX IF NOT EXISTS"),
  );
  assert.ok(addConstraint(constraint()).startsWith("DO $repair$"));
  assert.ok(enableRls({ schema: "public", name: "widgets" }).includes("ENABLE ROW LEVEL SECURITY"));
});

test("createIndex terminates the statement even when pg_get_indexdef does not", () => {
  const sql = createIndex({ def: "CREATE INDEX idx_a ON public.widgets USING btree (org_id)" });
  assert.ok(sql.trimEnd().endsWith(";"));
});

// A partitioned parent emitted as a plain table loses its partition key and every partition,
// and a partition emitted standalone is silently detached. Both are worse than refusing.
test("createTable refuses a partitioned parent rather than flattening it", () => {
  assert.throws(
    () => createTable({ schema: "public", name: "notifications", kind: "p", parent: null }, [column()]),
    UnsupportedTableShapeError,
  );
});

test("createTable refuses a partition rather than detaching it", () => {
  assert.throws(
    () =>
      createTable(
        { schema: "public", name: "notifications_2026_01", kind: "r", parent: "public.notifications" },
        [column()],
      ),
    UnsupportedTableShapeError,
  );
});

test("createTable accepts a plain table", () => {
  const sql = createTable({ schema: "public", name: "widgets", kind: "r", parent: null }, [column()]);
  assert.ok(sql.includes('"public"."widgets"'));
});

test("columnClause carries identity, generated, default and nullability", () => {
  assert.ok(columnClause(column({ identity: "a" })).includes("GENERATED ALWAYS AS IDENTITY"));
  assert.ok(columnClause(column({ identity: "d" })).includes("GENERATED BY DEFAULT AS IDENTITY"));
  assert.ok(
    columnClause(column({ generated: "s", defaultExpr: "lower(name)" })).includes(
      "GENERATED ALWAYS AS (lower(name)) STORED",
    ),
  );
  assert.ok(columnClause(column({ defaultExpr: "'x'::text" })).includes("DEFAULT 'x'::text"));
  assert.ok(columnClause(column({ notnull: true })).endsWith("NOT NULL"));
});

// "GENERATED BY DEFAULT AS IDENTITY" contains the word DEFAULT, so the property to assert is
// that the column's default EXPRESSION is not emitted -- an identity column with a nextval
// default would otherwise produce a clause Postgres rejects.
test("an identity column never emits its default expression", () => {
  const clause = columnClause(column({ identity: "d", defaultExpr: "nextval('s')" }));
  assert.ok(!clause.includes("nextval('s')"), clause);
  assert.ok(clause.includes("GENERATED BY DEFAULT AS IDENTITY"));
});

test("createPolicy emits PUBLIC when the policy names no role", () => {
  const sql = createPolicy({
    schema: "public",
    table: "widgets",
    name: "p",
    permissive: "PERMISSIVE",
    roles: [],
    cmd: "SELECT",
    qual: "true",
    withCheck: null,
  });
  assert.ok(sql.includes("TO PUBLIC"));
  assert.ok(!sql.includes("WITH CHECK"));
});

test("grantAppRole revokes PUBLIC before granting the app role", () => {
  const sql = grantAppRole({ schema: "public", name: "widgets" }, "streamline_app");
  assert.ok(sql.indexOf("REVOKE ALL") < sql.indexOf("GRANT SELECT"));
});

// Which side wins each conflict is the whole decision, so it is declared data with a reason
// rather than a branch buried in the generator.
test("every declared conflict names a winner and a reason", () => {
  assert.ok(CONFLICTS.length > 0);
  for (const c of CONFLICTS) {
    assert.ok([CHAIN, CONTROL_PLANE].includes(c.winner), `${c.column} has no valid winner`);
    assert.ok(c.reason.length > 40, `${c.column} has no substantive reason`);
  }
});

test("a conflict is suppressed in exactly one direction, never both", () => {
  for (const c of CONFLICTS) {
    const forward = isSuppressed(c.column, "forward");
    const drift = isSuppressed(c.column, "drift");
    assert.notEqual(forward, drift, `${c.column} is suppressed in both or neither direction`);
  }
});

test("a column with no declared conflict is suppressed in neither direction", () => {
  assert.equal(winnerFor("public.widgets.org_id"), null);
  assert.equal(isSuppressed("public.widgets.org_id", "forward"), false);
  assert.equal(isSuppressed("public.widgets.org_id", "drift"), false);
});

test("DROP_IN_CELL holds exactly the control-plane winners", () => {
  const expected = CONFLICTS.filter((c) => c.winner === CONTROL_PLANE).map((c) => c.column);
  assert.deepEqual(DROP_IN_CELL, expected);
});

// A constraint or index that mentions a suppressed column must be suppressed with it, or the
// migration references a column that was deliberately not created.
test("an object depending on a suppressed column is suppressed with it", () => {
  const suppressed = CONFLICTS.find((c) => c.winner === CONTROL_PLANE);
  const parts = suppressed.column.split(".");
  const col = parts[parts.length - 1];
  const tableKey = parts.slice(0, -1).join(".");
  assert.equal(
    dependsOnSuppressedColumn({ tableKey, def: `UNIQUE (org_id, ${col})` }, "drift"),
    true,
  );
});

test("dependency suppression does not fire on a different table", () => {
  const suppressed = CONFLICTS.find((c) => c.winner === CONTROL_PLANE);
  const col = suppressed.column.split(".").pop();
  assert.equal(
    dependsOnSuppressedColumn({ tableKey: "public.unrelated", def: `UNIQUE (${col})` }, "drift"),
    false,
  );
});

test("dependency suppression matches whole words, not substrings", () => {
  const suppressed = CONFLICTS.find((c) => c.winner === CONTROL_PLANE);
  const parts = suppressed.column.split(".");
  const col = parts[parts.length - 1];
  const tableKey = parts.slice(0, -1).join(".");
  assert.equal(
    dependsOnSuppressedColumn({ tableKey, def: `UNIQUE (${col}_archived)` }, "drift"),
    false,
  );
});

if (process.exitCode === 1) process.stderr.write("\nchain-repair tests FAILED\n");
else process.stdout.write("\nAll chain-repair tests passed.\n");
