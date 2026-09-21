#!/usr/bin/env node
/**
 * Gate: the migration corpus must install a column list on every composite
 * `ON DELETE SET NULL` foreign key the schema declares.
 *
 * This is the STATIC half of the pair whose other half needs a database.
 * `check-set-null-column-lists.ts` derives, from the schema module, which
 * foreign keys require `ON DELETE SET NULL (<nullable members>)` — and then
 * cannot verify them, because the column list lives only in
 * `pg_constraint.confdelsetcols`. Drizzle's `onDelete("set null")` has no
 * parameter for it, so the schema is silent on what the database carries.
 *
 * The migration SQL is NOT silent. `ON DELETE SET NULL ("customer_id")` is
 * ordinary text in `migrations/*.sql`, and the corpus is the only thing that
 * installs these constraints. So for every declared key requiring a column
 * list, this gate finds the LAST statement in journal order that installs that
 * constraint name and reads the column list out of the DDL.
 *
 * What this proves and what it does not:
 *
 *   PROVES  — the migration corpus, applied in full from empty, installs the
 *             correct column list. A bare `ON DELETE SET NULL` over a composite
 *             key is caught here with no database at all.
 *
 *   DOES NOT PROVE — that the live catalog matches. A migration may be
 *             unapplied (1142 is), partially executed, or the constraint may
 *             have been altered out of band. Only the catalog half settles
 *             that. This gate narrows the unverified set; it does not empty it.
 *
 * Usage:
 *   node -r ts-node/register/transpile-only src/scripts/check-set-null-migration-text.ts
 *   node -r ts-node/register/transpile-only src/scripts/check-set-null-migration-text.ts --self-test
 *   node -r ts-node/register/transpile-only src/scripts/check-set-null-migration-text.ts --report
 *
 * Exit codes:
 *   0  every required column list is installed by the corpus
 *   1  a violation (or a self-test failure)
 *   2  INCONCLUSIVE — the scan resolved too little to mean anything
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import * as schema from "../db/schema";
import { deriveSetNullDeclarations } from "../db/schema/set-null-column-lists";

const SELF_TEST = process.argv.includes("--self-test");
const REPORT = process.argv.includes("--report");

const BACKEND_ROOT = resolve(__dirname, "../..");
const MIGRATIONS_DIR = resolve(BACKEND_ROOT, "migrations");
const JOURNAL = resolve(MIGRATIONS_DIR, "meta/_journal.json");

/**
 * Postgres truncates an identifier to 63 bytes. Drizzle's generated constraint
 * names run past that, so the name the schema derives and the name the catalog
 * (and the DDL) carries are different strings. Matching on the derived name
 * alone silently skips those keys.
 */
const PG_NAME_MAX = 63;

/**
 * Floors, not targets. A refactor that moves the schema barrel or renames the
 * migrations directory would otherwise leave this gate resolving nothing and
 * reporting clean.
 */
const MIN_REQUIRING = 200;
const MIN_RESOLVED = 200;

/**
 * Composite SET NULL keys this gate FOUND bare and that are not this change's
 * to repair, each with the migration that installed it and the SQL that fixes
 * it. Both were installed after 0992, so no sweep reaches them, and both are
 * reachable: nothing else in the corpus creates the constraint, so the
 * `duplicate_object` / `IF NOT EXISTS` guard wrapping each add does not fire.
 *
 * This is a ledger, not an excuse list. An entry that no longer matches a bare
 * key is a FAILURE, not a pass — otherwise a repaired key leaves its exemption
 * behind and the map silently re-authorises the next occurrence on that name.
 * The same rule KNOWN_UNFIXED carries in check-composite-fk-set-null.mjs.
 *
 * Neither is verified against the catalog, because no non-production database
 * exists to read. The catalog may already differ; that is exactly the gap
 * docs/build-module/p08-composite-fk-status.md records as BLOCKED.
 */
export const KNOWN_BARE = new Map<string, string>([
  [
    "fk_inv_sales_orders_channel_id_org",
    "0580a_inventory_channel_pools (journal 806) — repair: ON DELETE SET NULL (channel_id)",
  ],
  [
    "fk_inv_stock_adjustments_scrap_location_id_org",
    "0545a_stock_write_off (journal 787) — repair: ON DELETE SET NULL (scrap_location_id)",
  ],
]);

type Verdict =
  | "installed"
  | "swept"
  | "bare"
  | "drift"
  | "not-set-null"
  | "dropped"
  | "untraceable";

type Finding = {
  key: string;
  constraint: string;
  expected: string[];
  verdict: Verdict;
  tag: string;
  actual: string[] | null;
  action: string | null;
};

type MigrationFile = { tag: string; sql: string; position: number };

type ForeignKeyInstall = {
  name: string;
  action: string | null;
  setNullColumns: string[] | null;
  /**
   * True when the statement only adds the constraint if it is not already
   * there. 58 migrations wrap 2,721 adds in
   * `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = …)`,
   * so "the last ADD in the file order wins" is simply false: 0576 re-adds
   * `fk_calendar_events_linked_lead_party_id` with a bare SET NULL, and that
   * statement is dead because 0662a — earlier in JOURNAL order, though later by
   * filename — already created it with NO ACTION.
   */
  guarded: boolean;
};

type Event =
  | { kind: "add"; tag: string; position: number; install: ForeignKeyInstall }
  | { kind: "drop"; tag: string; position: number };

/**
 * Strips comments and splits on statement boundaries, respecting single quotes,
 * double-quoted identifiers and dollar quoting. A `;` inside a DO $$ … $$ body
 * is not a statement boundary, and a constraint name inside a `--` comment is
 * not a DDL statement — 0619 and 1097 both contain prose naming constraints
 * they do not touch.
 */
export function splitStatements(sqlText: string): string[] {
  const sql = sqlText.replace(/\r\n/g, "\n");
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];

    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "'") {
      cur += c;
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          cur += "''";
          i += 2;
          continue;
        }
        cur += sql[i];
        const done = sql[i] === "'";
        i++;
        if (done) break;
      }
      continue;
    }
    if (c === '"') {
      cur += c;
      i++;
      while (i < n) {
        cur += sql[i];
        const done = sql[i] === '"';
        i++;
        if (done) break;
      }
      continue;
    }
    if (c === "$") {
      const match = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (match !== null) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      if (cur.trim() !== "") out.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

const NAMED_FK = /CONSTRAINT\s+"?([A-Za-z0-9_$]+)"?\s+FOREIGN\s+KEY/gi;
const DROP_FK = /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_$]+)"?/gi;
const ON_DELETE =
  /ON\s+DELETE\s+(SET\s+NULL|SET\s+DEFAULT|CASCADE|RESTRICT|NO\s+ACTION)(\s*\(([^)]*)\))?/i;

/**
 * True when this statement adds `name` only if `name` is not already present.
 *
 * The corpus writes that in two idioms and they are not interchangeable:
 *
 *   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '<name>')
 *     — 2,721 of these. Name-specific, so it must be matched per name: one DO
 *       body routinely guards on one constraint and adds another.
 *
 *   DO $$ BEGIN ALTER TABLE … ADD CONSTRAINT …;
 *   EXCEPTION WHEN duplicate_object THEN NULL; END $$
 *     — 333 of these. Not name-specific at all: it swallows the duplicate for
 *       whatever the block adds. Missing this idiom is what made 0581a's bare
 *       `ON DELETE set null` look like a live regression when 0767b had
 *       already created the same constraint with `(warehouse_id)`.
 */
export function isGuardedFor(flatStatement: string, name: string): boolean {
  if (!/^\s*DO\b/i.test(flatStatement)) return false;
  if (/EXCEPTION\s+WHEN\s+duplicate_object/i.test(flatStatement)) return true;
  const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Bounded, and never across an intervening ADD CONSTRAINT: a guard belongs to
  // the add that follows it, not to some later add in the same DO body.
  return new RegExp(
    `NOT\\s+EXISTS\\s*\\((?:(?!ADD\\s+CONSTRAINT)[\\s\\S]){0,400}?conname\\s*=\\s*'${quoted}'`,
    "i",
  ).test(flatStatement);
}

/**
 * Every foreign key this statement installs, whether by `ADD CONSTRAINT` or
 * inline in a `CREATE TABLE`. A statement may install several, so the scope of
 * each key's `ON DELETE` clause runs to the start of the next named key.
 */
export function parseInstalls(statement: string): ForeignKeyInstall[] {
  const flat = statement.replace(/\s+/g, " ");
  const bounds: { name: string; at: number }[] = [];
  NAMED_FK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAMED_FK.exec(flat)) !== null) bounds.push({ name: m[1], at: m.index });

  return bounds.map((b, idx) => {
    const end = idx + 1 < bounds.length ? bounds[idx + 1].at : flat.length;
    const scope = flat.slice(b.at, end);
    const guarded = isGuardedFor(flat, b.name);
    const od = ON_DELETE.exec(scope);
    if (od === null) return { name: b.name, action: null, setNullColumns: null, guarded };
    const action = od[1].replace(/\s+/g, " ").toUpperCase();
    const list =
      od[3] === undefined
        ? null
        : od[3]
            .split(",")
            .map((c) => c.trim().replace(/^"|"$/g, ""))
            .filter((c) => c !== "");
    return { name: b.name, action, setNullColumns: list, guarded };
  });
}

export function parseDrops(statement: string): string[] {
  const flat = statement.replace(/\s+/g, " ");
  const names: string[] = [];
  DROP_FK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DROP_FK.exec(flat)) !== null) names.push(m[1]);
  return names;
}

type Timeline = Map<string, Event[]>;

export function buildTimeline(files: { tag: string; sql: string; position?: number }[]): Timeline {
  const timeline: Timeline = new Map();
  const push = (name: string, entry: Event): void => {
    const list = timeline.get(name);
    if (list === undefined) timeline.set(name, [entry]);
    else list.push(entry);
  };

  for (const [index, file] of files.entries()) {
    const position = file.position ?? index;
    for (const statement of splitStatements(file.sql)) {
      for (const install of parseInstalls(statement))
        push(install.name, { kind: "add", tag: file.tag, position, install });
      for (const name of parseDrops(statement))
        push(name, { kind: "drop", tag: file.tag, position });
    }
  }
  return timeline;
}

/**
 * A migration that ends by COUNTING the remaining defects across pg_constraint
 * and raising if any survive. 0770 and 0992 are both of this shape, and 0992's
 * terminal count is `UNREACHABLE_SET_NULL_QUERY` verbatim: zero SET NULL keys
 * whose effective column set contains a NOT NULL column, at any arity.
 *
 * This is what makes a text scan possible at all. Those sweeps repair by
 * looping over the catalog and issuing `EXECUTE format(...)`, so they name no
 * constraint and no text scan can attribute their work. What they DO leave in
 * the text is a proof obligation: if the migration applied, the property holds
 * for every constraint standing at that moment. So the corpus is only
 * authoritative AFTER the last such sweep — and before it, the sweep is.
 */
export function findFixpoints(files: MigrationFile[]): MigrationFile[] {
  return files.filter((file) => {
    const flat = file.sql.replace(/\r\n/g, "\n");
    return (
      /confdeltype\s*=\s*'n'/i.test(flat) &&
      /attnotnull/i.test(flat) &&
      /RAISE\s+EXCEPTION/i.test(flat) &&
      /IF\s+remaining\s*>\s*0\s+THEN/i.test(flat)
    );
  });
}

/**
 * Replays the corpus in journal order and returns the constraint that is
 * standing at the end, which is the only one the database will carry. A
 * guarded add over a constraint that is already present is dead text.
 */
export function replay(
  constraint: string,
  timeline: Timeline,
): { install: ForeignKeyInstall; tag: string; position: number } | null | undefined {
  const events = timeline.get(constraint) ?? timeline.get(constraint.slice(0, PG_NAME_MAX));
  if (events === undefined || events.length === 0) return undefined;

  let standing: { install: ForeignKeyInstall; tag: string; position: number } | null = null;
  for (const event of events) {
    if (event.kind === "drop") {
      standing = null;
      continue;
    }
    if (event.install.guarded && standing !== null) continue;
    standing = { install: event.install, tag: event.tag, position: event.position };
  }
  return standing;
}

export function judge(
  constraint: string,
  expected: string[],
  timeline: Timeline,
  sweptThrough = -1,
): { verdict: Verdict; tag: string; actual: string[] | null; action: string | null } {
  const standing = replay(constraint, timeline);
  if (standing === undefined)
    return { verdict: "untraceable", tag: "-", actual: null, action: null };
  if (standing === null) return { verdict: "dropped", tag: "-", actual: null, action: null };

  const { install, tag, position } = standing;
  if (install.action !== "SET NULL")
    return { verdict: "not-set-null", tag, actual: null, action: install.action };

  if (install.setNullColumns !== null) {
    const actual = [...install.setNullColumns].sort();
    const want = [...expected].sort();
    return {
      verdict: actual.join(",") === want.join(",") ? "installed" : "drift",
      tag,
      actual,
      action: "SET NULL",
    };
  }

  // Bare in the text. That only survives if no later sweep rewrote it, and the
  // sweeps name nothing, so position is the only thing that can settle it.
  if (position <= sweptThrough)
    return { verdict: "swept", tag, actual: null, action: "SET NULL" };
  return { verdict: "bare", tag, actual: null, action: "SET NULL" };
}

/**
 * Journal ARRAY order, which is what every applier iterates — not the numeric
 * filename order, which disagrees. `0662a` is journal entry 824 and
 * `0576_tenant_fks_public_a` is 839, so the repair lands before the file whose
 * name reads five hundred lower.
 */
function readCorpus(): MigrationFile[] {
  const journal = JSON.parse(readFileSync(JOURNAL, "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const files: MigrationFile[] = [];
  journal.entries.forEach((entry, position) => {
    const path = resolve(MIGRATIONS_DIR, `${entry.tag}.sql`);
    if (!existsSync(path)) return;
    files.push({ tag: entry.tag, sql: readFileSync(path, "utf8"), position });
  });
  return files;
}

function runSelfTest(): never {
  let passed = 0;
  const failures: string[] = [];
  const assert = (label: string, condition: boolean): void => {
    if (condition) passed++;
    else failures.push(label);
  };

  const tl = (sql: string): Timeline => buildTimeline([{ tag: "t", sql }]);

  assert(
    "a bare composite SET NULL is reported bare, not installed",
    judge(
      "fk_a",
      ["owner_id"],
      tl(
        'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL;',
      ),
    ).verdict === "bare",
  );
  assert(
    "a column list matching the nullable member is installed",
    judge(
      "fk_a",
      ["owner_id"],
      tl(
        'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL ("owner_id") NOT VALID;',
      ),
    ).verdict === "installed",
  );
  assert(
    "a column list naming the wrong column is drift, not installed",
    judge(
      "fk_a",
      ["owner_id"],
      tl(
        'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL ("org_id");',
      ),
    ).verdict === "drift",
  );
  assert(
    "a later re-add overrides an earlier correct add",
    judge(
      "fk_a",
      ["owner_id"],
      buildTimeline([
        {
          tag: "0001",
          sql: 'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL ("owner_id");',
        },
        {
          tag: "0002",
          sql: 'ALTER TABLE "t" DROP CONSTRAINT "fk_a";\nALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL;',
        },
      ]),
    ).verdict === "bare",
  );
  assert(
    "a trailing DROP with no re-add is reported dropped",
    judge(
      "fk_a",
      ["owner_id"],
      buildTimeline([
        {
          tag: "0001",
          sql: 'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL ("owner_id");',
        },
        { tag: "0002", sql: 'ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "fk_a";' },
      ]),
    ).verdict === "dropped",
  );
  assert(
    "a different delete action is reported, not silently accepted",
    judge(
      "fk_a",
      ["owner_id"],
      tl(
        'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE CASCADE;',
      ),
    ).verdict === "not-set-null",
  );
  assert(
    "a constraint the corpus never installs is untraceable, not clean",
    judge("fk_missing", ["owner_id"], tl("SELECT 1")).verdict === "untraceable",
  );

  // Guarded adds. This is the rule the first cut of this gate got wrong, and
  // getting it wrong reported 88 violations that are all dead text.
  const guardedBareAdd = (name: string): string =>
    `DO $$ BEGIN IF to_regclass('public.t') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND conrelid = to_regclass('public.t')) THEN ALTER TABLE "t" ADD CONSTRAINT "${name}" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL NOT VALID; END IF; END $$;`;

  assert(
    "a guarded bare add is recognised as guarded",
    parseInstalls(splitStatements(guardedBareAdd("fk_a"))[0])[0].guarded,
  );
  assert(
    "an unguarded add is not recognised as guarded",
    parseInstalls(
      splitStatements(
        'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL;',
      )[0],
    )[0].guarded === false,
  );
  assert(
    "a guard naming a DIFFERENT constraint does not shield this add",
    parseInstalls(
      splitStatements(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_other') THEN ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL; END IF; END $$;`,
      )[0],
    )[0].guarded === false,
  );
  assert(
    "a guarded bare add AFTER a correct unguarded add is dead text, not a regression",
    judge(
      "fk_a",
      ["owner_id"],
      buildTimeline([
        {
          tag: "0662a",
          sql: 'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL ("owner_id");',
        },
        { tag: "0576", sql: guardedBareAdd("fk_a") },
      ]),
    ).verdict === "installed",
  );
  assert(
    "a guarded add DOES install when nothing created the constraint first",
    judge("fk_a", ["owner_id"], buildTimeline([{ tag: "0576", sql: guardedBareAdd("fk_a") }]))
      .verdict === "bare",
  );
  assert(
    "a guarded add revives a constraint that was dropped after being created",
    judge(
      "fk_a",
      ["owner_id"],
      buildTimeline([
        {
          tag: "0001",
          sql: 'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL ("owner_id");',
        },
        { tag: "0002", sql: 'ALTER TABLE "t" DROP CONSTRAINT "fk_a";' },
        { tag: "0576", sql: guardedBareAdd("fk_a") },
      ]),
    ).verdict === "bare",
  );

  // The second guard idiom, which the second cut of this gate got wrong and
  // which turned 0581a's dead re-add into nine reported regressions.
  const swallowingBareAdd = (name: string): string =>
    `DO $$ BEGIN ALTER TABLE "inv_asns" ADD CONSTRAINT "${name}" FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "inv_warehouses"("org_id", "id") ON DELETE set null NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;

  assert(
    "an add wrapped in EXCEPTION WHEN duplicate_object is recognised as guarded",
    parseInstalls(splitStatements(swallowingBareAdd("fk_a"))[0])[0].guarded,
  );
  assert(
    "a duplicate_object-guarded bare re-add does not override an earlier correct add",
    judge(
      "fk_a",
      ["warehouse_id"],
      buildTimeline([
        {
          tag: "0767b",
          position: 462,
          sql: 'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","warehouse_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL ("warehouse_id");',
        },
        { tag: "0581a", position: 807, sql: swallowingBareAdd("fk_a") },
      ]),
      639,
    ).verdict === "installed",
  );
  assert(
    "a duplicate_object-guarded add still installs when nothing created it first",
    judge(
      "fk_a",
      ["warehouse_id"],
      buildTimeline([{ tag: "0581a", position: 807, sql: swallowingBareAdd("fk_a") }]),
      639,
    ).verdict === "bare",
  );
  assert(
    "lowercase `ON DELETE set null` is read as SET NULL",
    parseInstalls(splitStatements(swallowingBareAdd("fk_a"))[0])[0].action === "SET NULL",
  );
  assert(
    "a guard is not borrowed across an intervening ADD CONSTRAINT",
    parseInstalls(
      splitStatements(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_first') THEN ALTER TABLE "t" ADD CONSTRAINT "fk_first" FOREIGN KEY ("org_id","a_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL ("a_id"); END IF; ALTER TABLE "t" ADD CONSTRAINT "fk_second" FOREIGN KEY ("org_id","b_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL; END $$;`,
      )[0],
    ).find((i) => i.name === "fk_second")?.guarded === false,
  );

  // Journal order, not filename order. 0662a sits at journal index 824 and
  // 0576_tenant_fks_public_a at 839, so the repair is applied FIRST despite the
  // lower-looking number. Replaying by filename inverts the two.
  assert(
    "the corpus is replayed in journal order, and journal order is not filename order",
    (() => {
      const journal = JSON.parse(readFileSync(JOURNAL, "utf8")) as {
        entries: { idx: number; tag: string }[];
      };
      const pos = (tag: string): number => journal.entries.findIndex((e) => e.tag === tag);
      return pos("0662a_composite_fk_set_null_nulls_tenant") < pos("0576_tenant_fks_public_a");
    })(),
  );

  // Catalog-driven sweeps. 0770 and 0992 repair by looping over pg_constraint
  // and issuing EXECUTE format(...), so they name no constraint. Treating text
  // as authoritative across them reports every key they fixed as still broken.
  const sweepSql = `
DO $$
DECLARE r record; remaining integer;
BEGIN
  FOR r IN SELECT con.oid FROM pg_constraint con
    WHERE con.contype = 'f' AND con.confdeltype = 'n'
      AND EXISTS (SELECT 1 FROM unnest(con.conkey) z(attnum)
                  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = z.attnum
                  WHERE a.attnotnull)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', r.sch, r.tbl, r.name);
  END LOOP;
  SELECT count(*) INTO remaining FROM pg_constraint con
   WHERE con.contype = 'f' AND con.confdeltype = 'n'
     AND EXISTS (SELECT 1 FROM unnest(COALESCE(con.confdelsetcols, con.conkey)) z(attnum)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = z.attnum
                 WHERE a.attnotnull);
  IF remaining > 0 THEN
    RAISE EXCEPTION 'sweep: % remain', remaining;
  END IF;
END $$;`;

  assert(
    "a catalog-driven sweep that asserts its own fixpoint is detected",
    findFixpoints([{ tag: "0992", sql: sweepSql, position: 5 }]).length === 1,
  );
  assert(
    "an ordinary migration is NOT detected as a sweep",
    findFixpoints([
      {
        tag: "0668",
        sql: 'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL;',
        position: 3,
      },
    ]).length === 0,
  );
  assert(
    "a bare add BEFORE the last sweep is swept, not reported bare",
    judge(
      "fk_a",
      ["owner_id"],
      buildTimeline([
        {
          tag: "0668",
          position: 3,
          sql: 'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL;',
        },
      ]),
      5,
    ).verdict === "swept",
  );
  assert(
    "a bare add AFTER the last sweep is still reported bare",
    judge(
      "fk_a",
      ["owner_id"],
      buildTimeline([
        {
          tag: "1150",
          position: 9,
          sql: 'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL;',
        },
      ]),
      5,
    ).verdict === "bare",
  );
  assert(
    "a WRONG column list after the last sweep is drift, and a sweep does not excuse it",
    judge(
      "fk_a",
      ["owner_id"],
      buildTimeline([
        {
          tag: "1150",
          position: 9,
          sql: 'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL ("org_id");',
        },
      ]),
      5,
    ).verdict === "drift",
  );

  // The real corpus must actually contain the sweeps. If a refactor deletes or
  // rewrites them, every pre-sweep key silently becomes "swept" on a claim
  // nothing backs any more.
  const realFixpoints = findFixpoints(readCorpus());
  assert(
    `the real corpus contains at least two catalog-driven sweeps (found ${realFixpoints.length}: ${realFixpoints.map((f) => f.tag).join(", ")})`,
    realFixpoints.length >= 2,
  );
  assert(
    "the last sweep is 0992_set_null_referential_actions_repair",
    realFixpoints[realFixpoints.length - 1]?.tag === "0992_set_null_referential_actions_repair",
  );
  assert(
    "0992's terminal assertion is UNREACHABLE_SET_NULL_QUERY's predicate, so it covers the stale-column-list form too",
    (realFixpoints[realFixpoints.length - 1]?.sql ?? "").includes(
      "COALESCE(con.confdelsetcols, con.conkey)",
    ),
  );

  // Name truncation. Postgres cuts identifiers at 63 bytes, so the derived name
  // and the installed name are different strings for Drizzle's longest keys.
  const longName = "managed_products_org_id_owner_membership_id_organization_members_org_id_id_fk";
  assert(
    "a name longer than 63 bytes is matched against its truncated form",
    judge(
      longName,
      ["owner_membership_id"],
      tl(
        `ALTER TABLE "t" ADD CONSTRAINT "${longName.slice(0, PG_NAME_MAX)}" FOREIGN KEY ("org_id","owner_membership_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL ("owner_membership_id");`,
      ),
    ).verdict === "installed",
  );

  // Text-scan traps. A constraint named only in prose must not register as DDL,
  // and a `;` inside a DO body must not split a statement in half.
  assert(
    "a constraint named in a -- comment is not read as an install",
    judge(
      "fk_a",
      ["owner_id"],
      tl('-- ADD CONSTRAINT "fk_a" FOREIGN KEY (org_id, owner_id) ON DELETE SET NULL\nSELECT 1;'),
    ).verdict === "untraceable",
  );
  assert(
    "a statement inside a dollar-quoted body is not split on its semicolons",
    judge(
      "fk_a",
      ["owner_id"],
      tl(
        'DO $$ BEGIN RAISE NOTICE \'x\'; END $$;\nALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL ("owner_id");',
      ),
    ).verdict === "installed",
  );
  assert(
    "two keys added in one CREATE TABLE do not share one ON DELETE clause",
    (() => {
      const t = tl(
        'CREATE TABLE "t" ("org_id" uuid, "a_id" uuid, "b_id" uuid, CONSTRAINT "fk_a" FOREIGN KEY ("org_id","a_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL ("a_id"), CONSTRAINT "fk_b" FOREIGN KEY ("org_id","b_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL);',
      );
      return (
        judge("fk_a", ["a_id"], t).verdict === "installed" &&
        judge("fk_b", ["b_id"], t).verdict === "bare"
      );
    })(),
  );
  assert(
    "a REFERENCES column list is not mistaken for a SET NULL column list",
    judge(
      "fk_a",
      ["owner_id"],
      tl(
        'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON DELETE SET NULL;',
      ),
    ).actual === null,
  );
  assert(
    "ON UPDATE SET NULL is not read as the delete action",
    judge(
      "fk_a",
      ["owner_id"],
      tl(
        'ALTER TABLE "t" ADD CONSTRAINT "fk_a" FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id") ON UPDATE SET NULL ON DELETE CASCADE;',
      ),
    ).verdict === "not-set-null",
  );
  assert(
    "a CRLF migration parses the same as an LF one",
    judge(
      "fk_a",
      ["owner_id"],
      tl(
        'ALTER TABLE "t"\r\n  ADD CONSTRAINT "fk_a"\r\n  FOREIGN KEY ("org_id","owner_id") REFERENCES "p"("org_id","id")\r\n  ON DELETE SET NULL ("owner_id");\r\n',
      ),
    ).verdict === "installed",
  );

  // The ledger. Every entry must still name a bare key in the real corpus, or
  // it is silently re-authorising that name for the next occurrence.
  {
    const corpusForLedger = readCorpus();
    const timelineForLedger = buildTimeline(corpusForLedger);
    const sweeps = findFixpoints(corpusForLedger);
    const through = sweeps[sweeps.length - 1]?.position ?? -1;
    const requiringForLedger = deriveSetNullDeclarations(
      schema as unknown as Record<string, unknown>,
    ).declared.filter((fk) => fk.requiresColumnList);

    for (const [name] of KNOWN_BARE) {
      const fk = requiringForLedger.find((f) => f.constraint === name);
      assert(`KNOWN_BARE entry ${name} still names a declared composite SET NULL key`, fk !== undefined);
      if (fk === undefined) continue;
      const v = judge(fk.constraint, fk.setNullColumns, timelineForLedger, through).verdict;
      assert(`KNOWN_BARE entry ${name} is still installed bare by the corpus (found "${v}")`, v === "bare");
    }
  }

  // The real corpus, so a moved directory or an emptied barrel fails here
  // rather than producing a clean run over nothing.
  const real = deriveSetNullDeclarations(schema as unknown as Record<string, unknown>).declared.filter(
    (fk) => fk.requiresColumnList,
  );
  assert(
    `the real schema yields at least ${MIN_REQUIRING} keys requiring a column list (found ${real.length})`,
    real.length >= MIN_REQUIRING,
  );
  const corpus = readCorpus();
  assert(`the real corpus reads at least 800 migration files (found ${corpus.length})`, corpus.length >= 800);

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`check-set-null-migration-text self-tests: ${failures.length} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-set-null-migration-text self-tests: ${passed} passed`);
  process.exit(0);
}

function main(): void {
  if (SELF_TEST) runSelfTest();

  const requiring = deriveSetNullDeclarations(
    schema as unknown as Record<string, unknown>,
  ).declared.filter((fk) => fk.requiresColumnList);

  if (requiring.length < MIN_REQUIRING) {
    console.error(
      `INCONCLUSIVE — the declaration scan found ${requiring.length} keys requiring a column list (floor ${MIN_REQUIRING}). A clean result over an empty scan proves nothing.`,
    );
    process.exit(2);
  }

  const corpus = readCorpus();
  const timeline = buildTimeline(corpus);

  const fixpoints = findFixpoints(corpus);
  if (fixpoints.length === 0) {
    console.error(
      "INCONCLUSIVE — no catalog-driven SET NULL sweep found in the corpus. 0770 and 0992 are what make the pre-sweep history safe to ignore; without them every pre-sweep key would have to be judged from text that the sweeps overrode.",
    );
    process.exit(2);
  }
  const lastSweep = fixpoints[fixpoints.length - 1];

  const findings: Finding[] = requiring.map((fk) => {
    const verdict = judge(fk.constraint, fk.setNullColumns, timeline, lastSweep.position);
    return {
      key: `${fk.schema}.${fk.table}.${fk.constraint}`,
      constraint: fk.constraint,
      expected: fk.setNullColumns,
      ...verdict,
    };
  });

  const by = (v: Verdict): Finding[] => findings.filter((f) => f.verdict === v);
  const installed = by("installed");
  const resolved = findings.filter((f) => f.verdict !== "untraceable" && f.verdict !== "dropped");

  console.log(
    `Migration files ${corpus.length}  ·  keys requiring a column list ${requiring.length}  ·  resolved to an install ${resolved.length}`,
  );
  console.log(
    `Catalog-driven sweeps ${fixpoints.length} (${fixpoints.map((f) => f.tag).join(", ")}) — text is authoritative only after journal position ${lastSweep.position}`,
  );
  console.log(
    `  installed ${installed.length}  ·  swept ${by("swept").length}  ·  bare ${by("bare").length}  ·  drift ${by("drift").length}  ·  not-set-null ${by("not-set-null").length}  ·  dropped ${by("dropped").length}  ·  untraceable ${by("untraceable").length}`,
  );

  if (resolved.length < MIN_RESOLVED) {
    console.error(
      `INCONCLUSIVE — only ${resolved.length} of ${requiring.length} keys resolved to an installing statement (floor ${MIN_RESOLVED}). The corpus scan is not seeing the DDL.`,
    );
    process.exit(2);
  }

  if (REPORT) {
    for (const f of findings.filter((x) => x.verdict !== "installed"))
      console.log(
        `  ${f.verdict.padEnd(13)} ${f.key}\n      last: ${f.tag}  action: ${f.action ?? "-"}  list: [${(f.actual ?? []).join(", ")}]  expected: [${f.expected.join(", ")}]`,
      );
  }

  const defective = [...by("bare"), ...by("drift")];
  const unexpected = defective.filter((f) => !KNOWN_BARE.has(f.constraint));
  const accepted = defective.filter((f) => KNOWN_BARE.has(f.constraint));
  const stale = [...KNOWN_BARE.keys()].filter(
    (name) => !defective.some((f) => f.constraint === name),
  );

  for (const f of accepted)
    console.log(`\n  KNOWN BARE  ${f.key}\n              ${KNOWN_BARE.get(f.constraint)}`);

  if (unexpected.length > 0 || stale.length > 0) {
    if (unexpected.length > 0)
      console.error(
        `\nFAIL — ${unexpected.length} composite SET NULL key(s) are installed AFTER the last sweep (${lastSweep.tag}) without the column list the declaration requires:`,
      );
    for (const f of unexpected)
      console.error(
        `  ${f.key}\n    last installing migration: ${f.tag}\n    installs: ON DELETE ${f.action ?? "<none>"}${f.actual === null ? "" : ` (${f.actual.join(", ")})`}\n    requires: ON DELETE SET NULL (${f.expected.join(", ")})`,
      );
    for (const name of stale)
      console.error(
        `  STALE  ${name} is in KNOWN_BARE but the corpus no longer installs it bare.\n         Remove it; a leftover entry re-authorises the name.`,
      );
    if (unexpected.length > 0)
      console.error(
        "\nA bare ON DELETE SET NULL over a composite key nulls EVERY member, including the NOT NULL tenant column, so the parent DELETE aborts with 23502.",
      );
    process.exit(1);
  }

  const divergent = by("not-set-null");
  const unresolved = [...by("untraceable"), ...by("dropped")];
  console.log(
    `\nOK — ${installed.length} composite SET NULL key(s) are installed with the required column list by the migration corpus, ${accepted.length} known bare, 0 new.`,
  );
  console.log(
    `  ${by("swept").length} more were installed bare before ${lastSweep.tag} and rewritten by it, which asserts its own fixpoint before committing.`,
  );

  if (divergent.length > 0) {
    console.log(
      `\n  DECLARATION DIVERGENCE — ${divergent.length} key(s) where the schema declares SET NULL and the corpus installs something else. 0662a chose NO ACTION for the erasure path and did not touch src/db/schema, so this is expected; it is printed because the catalog half of check:set-null-column-lists skips these silently:`,
    );
    for (const f of divergent)
      console.log(`    ${f.key}  declares SET NULL, corpus installs ${f.action ?? "NO ACTION"}  (${f.tag})`);
  }

  if (unresolved.length > 0) {
    console.log(
      `\n  NOT COVERED — ${unresolved.length} key(s) could not be resolved to an installing statement, printed here rather than counted as clean:`,
    );
    for (const f of unresolved) console.log(`    ${f.verdict}  ${f.key}  (last seen: ${f.tag})`);
  }
  console.log(
    "\n  This gate reads migration TEXT. It does not prove the live catalog agrees:\n  a migration may be unapplied, partially executed, or altered out of band.\n  Only check:set-null-column-lists with SET_NULL_GATE_DATABASE_URL settles that.",
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error: unknown) {
    console.error(
      `check-set-null-migration-text: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
