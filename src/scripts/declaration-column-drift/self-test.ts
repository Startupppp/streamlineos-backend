/**
 * `--self-test`. A gate that has never failed is not a gate: every assertion
 * below drives `compare()` from fixtures, and the discriminator that downgrades
 * a trigger-supplied column is asserted in BOTH directions — the downgrade
 * fires with the trigger present and the same shape still fails without it.
 *
 * The floors arrive as an argument rather than as constants here. They are the
 * numbers `baselines/ratchets.json` registers against the entry script, so they
 * stay declared there and this module asserts against whatever it is handed.
 */

import { INSERT_TRIGGERS_QUERY, LIVE_COLUMNS_QUERY } from "./catalog";
import type { LiveColumn, LiveTrigger } from "./catalog";
import { triggerNamesColumn } from "./catalog";
import { compare } from "./compare";
import { countDeclaredColumns, declaredTablesOf } from "./declared";
import type { DeclaredTable } from "./declared";

export interface DeclarationFloors {
  readonly declaredTables: number;
  readonly declaredColumns: number;
}

export function runSelfTest(barrel: Record<string, unknown>, floors: DeclarationFloors): never {
  const failures: string[] = [];
  let passed = 0;
  const assert = (label: string, ok: boolean): void => {
    if (ok) passed += 1;
    else failures.push(label);
  };

  const col = (over: Partial<LiveColumn> & Pick<LiveColumn, "table" | "column">): LiveColumn => ({
    schema: "public",
    notNull: false,
    hasDefault: false,
    isIdentity: false,
    isGenerated: false,
    ...over,
  });

  // The real defect, reduced: a declaration that lost a NOT NULL live column.
  const watchers: DeclaredTable = {
    schema: "public",
    table: "support_ticket_watchers",
    columns: new Set(["id", "org_id", "ticket_id", "user_membership_id", "created_at"]),
  };
  const watchersLive: LiveColumn[] = [
    col({ table: "support_ticket_watchers", column: "id", notNull: true, hasDefault: true }),
    col({ table: "support_ticket_watchers", column: "org_id", notNull: true }),
    col({ table: "support_ticket_watchers", column: "ticket_id", notNull: true }),
    col({ table: "support_ticket_watchers", column: "user_id", notNull: true }),
    col({ table: "support_ticket_watchers", column: "user_membership_id" }),
    col({ table: "support_ticket_watchers", column: "created_at", notNull: true, hasDefault: true }),
  ];
  const bite = compare([watchers], watchersLive);
  assert(
    "the real defect is caught: support_ticket_watchers.user_id is write-blocking",
    bite.writeBlocking.length === 1 &&
      bite.writeBlocking[0]?.key === "public.support_ticket_watchers" &&
      bite.writeBlocking[0]?.column === "user_id",
  );
  assert("the serial id column does not fire", !bite.writeBlocking.some((f) => f.column === "id"));
  assert("the defaulted created_at does not fire", !bite.writeBlocking.some((f) => f.column === "created_at"));
  assert("the contracted table is clean", compare([watchers], watchersLive.filter((c) => c.column !== "user_id")).writeBlocking.length === 0);

  // The 22 false positives the first real run produced, reduced: a NOT NULL,
  // no-default, undeclared column that a BEFORE INSERT row trigger fills.
  const items: DeclaredTable = { schema: "public", table: "invoice_items", columns: new Set(["id", "invoice_id"]) };
  const itemsLive: LiveColumn[] = [
    col({ table: "invoice_items", column: "id", notNull: true, hasDefault: true }),
    col({ table: "invoice_items", column: "invoice_id", notNull: true }),
    col({ table: "invoice_items", column: "org_id", notNull: true }),
  ];
  const setOrgId: LiveTrigger = {
    schema: "public",
    table: "invoice_items",
    trigger: "trg_set_org_id",
    definition:
      "CREATE TRIGGER trg_set_org_id BEFORE INSERT ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent('invoices', 'id', 'org_id', 'invoice_id')",
  };
  const supplied = compare([items], itemsLive, [setOrgId]);
  assert(
    "a trigger-filled tenant column is downgraded, not failed",
    supplied.writeBlocking.length === 0 &&
      supplied.triggerSupplied.length === 1 &&
      supplied.triggerSupplied[0]?.column === "org_id",
  );
  assert(
    "without the trigger the same column DOES fail — the downgrade is the trigger's doing, not the column's",
    compare([items], itemsLive).writeBlocking.length === 1,
  );
  assert(
    "a trigger that does not name the column does not downgrade it",
    compare([items], itemsLive, [{ ...setOrgId, definition: "CREATE TRIGGER t BEFORE INSERT ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION touch_updated_at()" }]).writeBlocking.length === 1,
  );
  assert(
    "a trigger on a different table does not downgrade",
    compare([items], itemsLive, [{ ...setOrgId, table: "other_table" }]).writeBlocking.length === 1,
  );
  assert(
    "the column match is word-bounded — source_org_id does not count as org_id",
    !triggerNamesColumn("EXECUTE FUNCTION f('source_org_id')", "org_id"),
  );
  assert("the column match finds the quoted argument", triggerNamesColumn("f('invoices', 'id', 'org_id', 'invoice_id')", "org_id"));
  assert(
    "support_ticket_watchers still fails with the trigger set present — it carries no trigger",
    compare([watchers], watchersLive, [setOrgId]).writeBlocking.length === 1,
  );
  assert("the trigger query selects BEFORE INSERT row triggers only", INSERT_TRIGGERS_QUERY.includes("t.tgtype & 1") && INSERT_TRIGGERS_QUERY.includes("t.tgtype & 2") && INSERT_TRIGGERS_QUERY.includes("t.tgtype & 4"));

  // A nullable or defaulted undeclared column is invisible, not blocking — this is
  // the bucket the other 72 expanded tables occupy.
  const t: DeclaredTable = { schema: "public", table: "t", columns: new Set(["id"]) };
  const nullableDrift = compare([t], [col({ table: "t", column: "id", notNull: true, hasDefault: true }), col({ table: "t", column: "note" })]);
  assert("a nullable undeclared column is reported, not failed", nullableDrift.writeBlocking.length === 0 && nullableDrift.invisible.length === 1);
  const defaulted = compare([t], [col({ table: "t", column: "id", notNull: true, hasDefault: true }), col({ table: "t", column: "n", notNull: true, hasDefault: true })]);
  assert("a NOT NULL undeclared column WITH a default does not fail", defaulted.writeBlocking.length === 0 && defaulted.invisible.length === 1);
  const identity = compare([t], [col({ table: "t", column: "id", notNull: true, hasDefault: true }), col({ table: "t", column: "n", notNull: true, isIdentity: true })]);
  assert("an identity column does not fail", identity.writeBlocking.length === 0);
  const generated = compare([t], [col({ table: "t", column: "id", notNull: true, hasDefault: true }), col({ table: "t", column: "n", notNull: true, hasDefault: true, isGenerated: true })]);
  assert("a generated column does not fail", generated.writeBlocking.length === 0);

  // The other direction: declared, not live.
  const missingColumn = compare([{ schema: "public", table: "t", columns: new Set(["id", "gone"]) }], [col({ table: "t", column: "id", notNull: true, hasDefault: true })]);
  assert("a declared column with no live counterpart is read-blocking", missingColumn.readBlocking.length === 1 && missingColumn.readBlocking[0]?.column === "gone");

  // A same-named column on a neighbouring table must not cross-fire.
  const crossFire = compare(
    [{ schema: "public", table: "a", columns: new Set(["user_id"]) }, { schema: "public", table: "b", columns: new Set(["id"]) }],
    [col({ table: "a", column: "user_id", notNull: true }), col({ table: "b", column: "id", notNull: true, hasDefault: true }), col({ table: "b", column: "user_id", notNull: true })],
  );
  assert(
    "a same-named column on another table is attributed to that table only",
    crossFire.writeBlocking.length === 1 && crossFire.writeBlocking[0]?.key === "public.b",
  );

  // Schema qualification: `build.tickets` and `public.tickets` are different tables.
  const schemaQualified = compare(
    [{ schema: "build", table: "tickets", columns: new Set(["id"]) }],
    [col({ schema: "public", table: "tickets", column: "id", notNull: true }), col({ schema: "public", table: "tickets", column: "legacy", notNull: true })],
  );
  assert(
    "a declared table in another schema is not compared against the public one",
    schemaQualified.writeBlocking.length === 0 && schemaQualified.missingTables.length === 1,
  );

  assert("the live query reads attnotnull", LIVE_COLUMNS_QUERY.includes("attnotnull"));
  assert("the live query excludes dropped columns", LIVE_COLUMNS_QUERY.includes("attisdropped"));
  assert("the live query excludes partition children", LIVE_COLUMNS_QUERY.includes("relispartition"));

  // The real barrel, so an empty scan fails here rather than passing over nothing.
  const real = declaredTablesOf(barrel);
  const realColumns = countDeclaredColumns(real);
  assert(`the real schema yields at least ${String(floors.declaredTables)} tables (found ${String(real.length)})`, real.length >= floors.declaredTables);
  assert(`the real schema yields at least ${String(floors.declaredColumns)} columns (found ${String(realColumns)})`, realColumns >= floors.declaredColumns);
  assert(
    "the real schema declares support_ticket_watchers without user_id (the shape 1046 contracted the database onto)",
    real.some((t2) => t2.table === "support_ticket_watchers" && !t2.columns.has("user_id") && t2.columns.has("user_membership_id")),
  );

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`check-declaration-column-drift self-tests: ${String(failures.length)} failed, ${String(passed)} passed`);
    process.exit(1);
  }
  console.log(`check-declaration-column-drift self-tests: ${String(passed)} passed`);
  process.exit(0);
}
