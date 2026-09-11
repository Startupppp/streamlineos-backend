/**
 * `--self-test`. A guard that has never failed is not a guard: every assertion
 * below drives `compare()` from fixtures, and each false-positive control is
 * asserted in BOTH directions — the downgrade fires with its cause present and
 * the same shape still fails with it removed.
 */

import { coversAsPrefix, foreignKeyCovers, LIVE_CONSTRAINTS_QUERY, LIVE_INDEXES_QUERY } from "./catalog";
import type { DeclaredTable, LiveConstraint, LiveIndex } from "./catalog";
import { compare, unbaselined } from "./compare";
import { countDeclaredObjects, declaredTablesOf } from "./declared";
import * as schema from "../../db/schema";

export const MIN_DECLARED_TABLES = 700;
export const MIN_DECLARED_OBJECTS = 3000;
export const MIN_LIVE_INDEXES = 2000;
export const MIN_LIVE_CONSTRAINTS = 2000;

export function runSelfTest(): never {
  const failures: string[] = [];
  let passed = 0;
  const assert = (label: string, ok: boolean): void => {
    if (ok) passed += 1;
    else failures.push(label);
  };

  const idx = (over: Partial<LiveIndex> & Pick<LiveIndex, "table" | "name" | "columns">): LiveIndex => ({
    schema: "public",
    unique: false,
    primary: false,
    partial: false,
    predicate: "",
    ...over,
  });
  const con = (over: Partial<LiveConstraint> & Pick<LiveConstraint, "table" | "name" | "kind">): LiveConstraint => ({
    schema: "public",
    columns: "",
    foreignSchema: "",
    foreignTable: "",
    foreignColumns: "",
    ...over,
  });
  const table = (over: Partial<DeclaredTable> & Pick<DeclaredTable, "table">): DeclaredTable => ({
    schema: "public",
    uniques: [],
    indexes: [],
    foreignKeys: [],
    checks: [],
    ...over,
  });

  // The real defect, reduced: hr_people declares the org-person link unique and
  // the catalog has nothing on organization_person_id.
  const hrPeopleDeclared = table({
    table: "hr_people",
    uniques: [
      { name: "uniq_hr_people_org_id", unique: true, partial: false, columns: ["org_id", "id"] },
      {
        name: "uniq_hr_people_org_person_link",
        unique: true,
        partial: true,
        columns: ["org_id", "organization_person_id"],
      },
    ],
  });
  const hrPeopleLive: LiveIndex[] = [
    idx({ table: "hr_people", name: "hr_people_pkey", columns: "id", unique: true, primary: true }),
    idx({ table: "hr_people", name: "uniq_hr_people_org_id", columns: "org_id,id", unique: true }),
    idx({ table: "hr_people", name: "idx_hr_people_org", columns: "org_id" }),
  ];
  const bite = compare([hrPeopleDeclared], hrPeopleLive, []);
  assert(
    "the real defect is caught: uniq_hr_people_org_person_link is an integrity finding",
    bite.integrity.length === 1 && bite.integrity[0]?.name === "uniq_hr_people_org_person_link",
  );
  assert(
    "the tenant anchor that DOES exist does not fire",
    !bite.integrity.some((finding) => finding.name === "uniq_hr_people_org_id"),
  );
  assert(
    "migration 1048 clears it — with the index live the table is clean",
    compare(
      [hrPeopleDeclared],
      [
        ...hrPeopleLive,
        idx({
          table: "hr_people",
          name: "uniq_hr_people_org_person_link",
          columns: "org_id,organization_person_id",
          unique: true,
          partial: true,
          predicate: "(organization_person_id IS NOT NULL)",
        }),
      ],
      [],
    ).integrity.length === 0,
  );

  // Control A — a declared unique() satisfied by a bare unique INDEX of that
  // name, and a declared uniqueIndex() satisfied by a UNIQUE CONSTRAINT.
  const anchor = table({
    table: "t",
    uniques: [{ name: "uniq_t_org_id", unique: true, partial: false, columns: ["org_id", "id"] }],
  });
  assert(
    "a declared unique() matched by a bare unique index of the same name is clean",
    compare([anchor], [idx({ table: "t", name: "uniq_t_org_id", columns: "org_id,id", unique: true })], []).integrity
      .length === 0,
  );
  assert(
    "a declared unique matched by a UNIQUE CONSTRAINT of the same name is clean",
    compare([anchor], [], [con({ table: "t", name: "uniq_t_org_id", kind: "u", columns: "org_id,id" })]).integrity
      .length === 0,
  );
  assert(
    "a live index of the right name that is NOT unique does not satisfy a declared unique",
    compare([anchor], [idx({ table: "t", name: "uniq_t_org_id", columns: "org_id,id" })], []).integrity.length === 1,
  );

  // Control B — name reuse across an expand: the NAME is live on the legacy
  // columns and the declared columns are indexed under a different name.
  const expanded = table({
    table: "ai_chat_messages",
    indexes: [
      {
        name: "idx_ai_chat_messages_org_user_id",
        unique: false,
        partial: false,
        columns: ["org_id", "user_membership_id", "id"],
      },
    ],
  });
  const expandedLive: LiveIndex[] = [
    idx({ table: "ai_chat_messages", name: "idx_ai_chat_messages_org_user_id", columns: "org_id,user_id,id" }),
    idx({
      table: "ai_chat_messages",
      name: "idx_ai_chat_messages_org_user_membership_id",
      columns: "org_id,user_membership_id,id",
    }),
  ];
  const reuse = compare([expanded], expandedLive, []);
  assert(
    "a reused index NAME whose declared columns exist elsewhere is name drift, not a missing index",
    reuse.performance.length === 0 && reuse.nameDrift.length === 1,
  );
  assert(
    "without the membership index the SAME shape IS a performance finding — the downgrade is the sibling index's doing",
    compare([expanded], [expandedLive[0] ?? idx({ table: "x", name: "x", columns: "x" })], []).performance.length === 1,
  );

  // Control C — a tenant-anchored composite covers the declared single-column FK.
  const child = table({
    table: "credit_notes",
    foreignKeys: [
      { name: "credit_notes_client_id_clients_id_fk", columns: ["client_id"], foreignTable: "public.clients", foreignColumns: ["id"] },
    ],
  });
  const composite = con({
    table: "credit_notes",
    name: "fk_credit_notes_org_client",
    kind: "f",
    columns: "org_id,client_id",
    foreignSchema: "public",
    foreignTable: "clients",
    foreignColumns: "org_id,id",
  });
  assert(
    "a wider tenant-anchored composite satisfies the declared single-column foreign key",
    compare([child], [], [composite]).integrity.length === 0,
  );
  assert("...and is reported as name drift so the stale declaration is still visible", compare([child], [], [composite]).nameDrift.length === 1);
  assert(
    "a composite to a DIFFERENT parent does not satisfy it",
    compare([child], [], [{ ...composite, foreignTable: "vendors" }]).integrity.length === 1,
  );
  assert(
    "a NARROWER live foreign key missing a declared column does not satisfy it",
    compare(
      [
        table({
          table: "t",
          foreignKeys: [
            { name: "fk_t_org_member", columns: ["org_id", "membership_id"], foreignTable: "public.organization_members", foreignColumns: ["org_id", "id"] },
          ],
        }),
      ],
      [],
      [
        con({
          table: "t",
          name: "fk_t_member",
          kind: "f",
          columns: "membership_id",
          foreignSchema: "public",
          foreignTable: "organization_members",
          foreignColumns: "id",
        }),
      ],
    ).integrity.length === 1,
  );
  assert("foreignKeyCovers ignores non-foreign-key constraints", !foreignKeyCovers({ ...composite, kind: "u" }, { name: "x", columns: ["client_id"], foreignTable: "public.clients", foreignColumns: ["id"] }));

  // Control D — prefix coverage.
  assert("a leading prefix is covered", coversAsPrefix("org_id,status", "org_id"));
  assert("an identical column list is covered", coversAsPrefix("org_id", "org_id"));
  assert("a non-leading position is NOT covered", !coversAsPrefix("status,org_id", "org_id"));
  assert("a partial column-name match is NOT a prefix", !coversAsPrefix("org_id_legacy,x", "org_id"));
  const prefixed = table({ table: "t", indexes: [{ name: "idx_t_org", unique: false, partial: false, columns: ["org_id"] }] });
  assert(
    "a declared index covered as a prefix of a wider live index is name drift, not missing",
    compare([prefixed], [idx({ table: "t", name: "idx_t_org_status", columns: "org_id,status" })], []).performance
      .length === 0,
  );

  // Verdict separation: a unique is integrity, a plain index is performance.
  const both = table({
    table: "t",
    uniques: [{ name: "uq", unique: true, partial: false, columns: ["a"] }],
    indexes: [{ name: "ix", unique: false, partial: false, columns: ["b"] }],
  });
  const separated = compare([both], [idx({ table: "t", name: "other", columns: "z" })], []);
  assert(
    "a missing unique is integrity and a missing index is performance",
    separated.integrity.length === 1 && separated.performance.length === 1,
  );

  // A same-named object on a neighbouring table must not cross-fire.
  const crossFire = compare(
    [table({ table: "a", indexes: [{ name: "idx_shared", unique: false, partial: false, columns: ["x"] }] }), table({ table: "b" })],
    [idx({ table: "a", name: "a_pkey", columns: "id", unique: true, primary: true }), idx({ table: "b", name: "idx_shared", columns: "x" })],
    [],
  );
  assert(
    "an index on another table does not satisfy this table's declaration",
    crossFire.performance.length === 1 && crossFire.performance[0]?.table === "public.a",
  );

  // Schema qualification: build.tickets and public.tickets are different tables.
  const qualified = compare(
    [{ schema: "build", table: "tickets", uniques: [], indexes: [{ name: "i", unique: false, partial: false, columns: ["x"] }], foreignKeys: [], checks: [] }],
    [idx({ schema: "public", table: "tickets", name: "i", columns: "x" })],
    [],
  );
  assert("a declared table in another schema is not compared against the public one", qualified.missingTables.length === 1 && qualified.performance.length === 0);

  // Checks and undeclared.
  assert(
    "a declared CHECK with no live constraint of that name is an integrity finding",
    compare([table({ table: "t", checks: ["chk_t_row_version"] })], [idx({ table: "t", name: "i", columns: "x" })], []).integrity
      .length === 1,
  );
  const undeclaredOnly = compare([table({ table: "t" })], [idx({ table: "t", name: "idx_surprise", columns: "x" })], []);
  assert(
    "a live index no declaration names is REPORTED, never failed",
    undeclaredOnly.integrity.length === 0 && undeclaredOnly.performance.length === 0 && undeclaredOnly.undeclared.length === 1,
  );
  assert(
    "a primary-key index is never reported as undeclared",
    compare([table({ table: "t" })], [idx({ table: "t", name: "t_pkey", columns: "id", unique: true, primary: true })], []).undeclared
      .length === 0,
  );

  // The ratchet.
  const ratchet = compare([hrPeopleDeclared], hrPeopleLive, []);
  assert(
    "a baselined finding does not fail the gate",
    unbaselined(ratchet.integrity, new Set(["unique:public.hr_people:uniq_hr_people_org_person_link"])).length === 0,
  );
  assert("a finding absent from the baseline DOES fail the gate", unbaselined(ratchet.integrity, new Set()).length === 1);

  // Queries.
  assert("the constraint query excludes PG17 not-null rows", LIVE_CONSTRAINTS_QUERY.includes("con.contype <> 'n'"));
  assert("the index query excludes partition children", LIVE_INDEXES_QUERY.includes("relispartition"));
  assert("the index query reads the partial predicate", LIVE_INDEXES_QUERY.includes("indpred"));
  assert("the index query reads only KEY columns, not INCLUDE columns", LIVE_INDEXES_QUERY.includes("indnkeyatts"));

  // The real barrel, so an empty scan fails here rather than passing over nothing.
  const real = declaredTablesOf({ ...schema });
  const objects = countDeclaredObjects(real);
  assert(`the real schema yields at least ${String(MIN_DECLARED_TABLES)} tables (found ${String(real.length)})`, real.length >= MIN_DECLARED_TABLES);
  assert(`the real schema yields at least ${String(MIN_DECLARED_OBJECTS)} declared objects (found ${String(objects)})`, objects >= MIN_DECLARED_OBJECTS);
  assert(
    "the real schema still declares uniq_hr_people_org_person_link (the object migration 1048 creates)",
    real.some((t) => t.table === "hr_people" && t.uniques.some((u) => u.name === "uniq_hr_people_org_person_link")),
  );

  if (failures.length > 0) {
    for (const failure of failures) console.error(`  FAIL: ${failure}`);
    console.error(`check-declaration-constraint-drift self-tests: ${String(failures.length)} failed, ${String(passed)} passed`);
    process.exit(1);
  }
  console.log(`check-declaration-constraint-drift self-tests: ${String(passed)} passed`);
  process.exit(0);
}
