#!/usr/bin/env node
/**
 * Gate: every unique constraint, unique index, plain index, foreign key and check
 * constraint the Drizzle schema DECLARES must actually exist on a database
 * bootstrapped to journal head.
 *
 * The defect class this exists for is `uniq_hr_people_org_person_link`. It is
 * declared at `db/schema/hr/core-people.ts:85` and the only SQL that creates it
 * is `migrations/pending/hrms-phase1/0000_hrms_profiles_workforce.sql`, which is
 * NOT listed in `migrations/meta/_journal.json`. `drizzle-kit migrate` skips a
 * file the journal does not list and still prints success, so the constraint has
 * never existed. Two consequences, and the second is the one that hides:
 *
 *   1. Nothing stopped two `hr_people` rows pointing at the same directory person
 *      in one organisation.
 *   2. Five sites branch on `code === "23505" && constraint ===
 *      "uniq_hr_people_org_person_link"` (hr-people.service.ts:172,
 *      recruitment-handoff.service.ts:141/164/179,
 *      hr-import-commit.service.ts:142). Every one was unreachable: the
 *      constraint they name did not exist, so Postgres never raised 23505 under
 *      that name. Code that LOOKS like it handles a duplicate handled nothing.
 *
 * `check:declaration-column-drift` is the sibling gate and covers COLUMNS. A
 * missing constraint is invisible to it: `hr_people.organization_person_id` is
 * present and correctly typed on both sides. Nothing else in the repo compares
 * declared constraints against the catalog.
 *
 * FOUR FALSE-POSITIVE CONTROLS, all bite-proved in --self-test. The sibling
 * gate's first real run reported 23 findings of which 22 were false positives;
 * the same lesson applies here and the controls are what make the count usable.
 *
 *   A. Constraint/index equivalence. Postgres implements a UNIQUE CONSTRAINT
 *      with a unique index of the same name; a bare CREATE UNIQUE INDEX makes an
 *      index and no `pg_constraint` row. `unique("n")` and `uniqueIndex("n")`
 *      are therefore the same population and are matched against BOTH catalogs.
 *      Comparing only `pg_constraint` reports every `uniqueIndex` as missing.
 *
 *   B. Name reuse across an expand. `idx_ai_chat_messages_org_user_id` is
 *      declared on (org_id, user_membership_id, id) while the live index of that
 *      NAME is still on the legacy (org_id, user_id, id) and the declared
 *      columns are indexed under a different name
 *      (`idx_ai_chat_messages_org_user_membership_id`). Matching by name alone
 *      calls that missing; it is name drift and the index is present. Three
 *      tables sit in exactly this state.
 *
 *   C. Tenant-anchored composite foreign keys. Migrations 1006/1024/1025
 *      replaced single-column foreign keys with the organisation-scoped
 *      composite `(org_id, child_id) -> parent (org_id, id)`, which the
 *      declaration still writes as an inline `.references()` on the child column
 *      alone. A declared foreign key is satisfied by any live foreign key to the
 *      same parent whose column list CONTAINS it: the composite is strictly
 *      stronger. 19 of 124 raw findings are this.
 *
 *   D. Prefix coverage. A declared index on (org_id) is answered by a live btree
 *      on (org_id, status) by definition of a btree, so a declared index whose
 *      column list is a leading prefix of a live one is coverage, not absence.
 *      Migration 0999 dropped 337 indexes on exactly that reasoning.
 *
 * Two verdict classes, because they fail differently:
 *
 *   INTEGRITY   a declared unique with no live unique object over the same
 *               columns, a declared foreign key no live foreign key covers, or a
 *               declared CHECK with no live constraint of that name. Duplicate
 *               and orphan rows become insertable, and any 23505/23503 handler
 *               naming the constraint is dead code.
 *   PERFORMANCE a declared non-unique index with no live index on those columns
 *               and none covering them as a prefix. Reads that assume it walk
 *               more of the table than the author believed.
 *
 * Name drift, partial-predicate mismatches and live objects the ORM does not
 * declare are REPORTED, never failed. Undeclared is how a later `drop` surprises
 * someone; it does not break a write today.
 *
 * Ratchet: today's accepted findings live in
 * `baselines/declaration-constraint-drift.json`. The gate fails only on findings
 * that are NOT in it, which is the case that matters — a constraint added to the
 * schema in this change with no migration behind it. The baseline can only
 * shrink; `--emit-baseline` rewrites it.
 *
 * Usage:
 *   node -r ts-node/register/transpile-only src/scripts/check-declaration-constraint-drift.ts
 *   node -r ts-node/register/transpile-only src/scripts/check-declaration-constraint-drift.ts --self-test
 *   CONSTRAINT_DRIFT_GATE_DATABASE_URL=postgresql://… node -r ts-node/register/transpile-only \
 *     src/scripts/check-declaration-constraint-drift.ts [--emit-baseline]
 *
 * The URL is a dedicated variable rather than DATABASE_URL so a local run cannot
 * reach the shared instance by inheriting it. The gate only ever SELECTs from
 * pg_catalog.
 *
 * Exit codes:
 *   0  clean, or every finding is baselined, or accepted as PARTIAL via
 *      STREAMLINE_ALLOW_PARTIAL_GATES=1
 *   1  an un-baselined integrity or performance finding (or a self-test failure)
 *   2  INCONCLUSIVE — no database, or the scan is vacuous
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";

import * as schema from "../db/schema";

const SELF_TEST = process.argv.includes("--self-test");
const EMIT_BASELINE = process.argv.includes("--emit-baseline");
const GATE_URL = process.env.CONSTRAINT_DRIFT_GATE_DATABASE_URL;
const ALLOW_PARTIAL = process.env.STREAMLINE_ALLOW_PARTIAL_GATES === "1";
const BASELINE_PATH = resolve(__dirname, "baselines/declaration-constraint-drift.json");

/** Floors, not targets. A barrel rename would otherwise compare nothing against nothing. */
const MIN_DECLARED_TABLES = 700;
const MIN_DECLARED_OBJECTS = 3000;
const MIN_LIVE_INDEXES = 2000;
const MIN_LIVE_CONSTRAINTS = 2000;

export interface LiveIndex {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly unique: boolean;
  readonly primary: boolean;
  readonly partial: boolean;
  readonly predicate: string;
  readonly columns: string;
}

export interface LiveConstraint {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  /** `p` primary key · `u` unique · `f` foreign key · `c` check · `x` exclusion. */
  readonly kind: string;
  readonly columns: string;
  readonly foreignSchema: string;
  readonly foreignTable: string;
  readonly foreignColumns: string;
}

export interface DeclaredIndex {
  readonly name: string;
  readonly unique: boolean;
  readonly partial: boolean;
  readonly columns: readonly string[];
}

export interface DeclaredForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly foreignTable: string;
  readonly foreignColumns: readonly string[];
}

export interface DeclaredTable {
  readonly schema: string;
  readonly table: string;
  /** `unique()` and `uniqueIndex()` merged — control A. */
  readonly uniques: readonly DeclaredIndex[];
  readonly indexes: readonly DeclaredIndex[];
  readonly foreignKeys: readonly DeclaredForeignKey[];
  readonly checks: readonly string[];
}

export type FindingClass =
  | "integrity"
  | "performance"
  | "name-drift"
  | "partial-mismatch"
  | "undeclared";

export interface Finding {
  readonly id: string;
  readonly verdict: FindingClass;
  readonly table: string;
  readonly name: string;
  readonly detail: string;
}

export interface DriftReport {
  readonly integrity: readonly Finding[];
  readonly performance: readonly Finding[];
  readonly nameDrift: readonly Finding[];
  readonly partialMismatch: readonly Finding[];
  readonly undeclared: readonly Finding[];
  readonly comparedTables: number;
  readonly missingTables: readonly string[];
}

export const LIVE_INDEXES_QUERY = `
  SELECT n.nspname AS "schema",
         tc.relname AS "table",
         ic.relname AS "name",
         i.indisunique AS "unique",
         i.indisprimary AS "primary",
         (i.indpred IS NOT NULL) AS "partial",
         coalesce(pg_get_expr(i.indpred, i.indrelid), '') AS "predicate",
         coalesce((SELECT string_agg(CASE WHEN k.attnum = 0 THEN '<expr>' ELSE a.attname END, ',' ORDER BY k.ord)
                     FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                     LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                    WHERE k.ord <= i.indnkeyatts), '') AS "columns"
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class tc ON tc.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = tc.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'drizzle', 'pg_toast')
    AND tc.relkind IN ('r', 'p')
    AND NOT tc.relispartition
`;

/**
 * `contype` 'n' is excluded: Postgres 17 gave every NOT NULL its own
 * `pg_constraint` row, and on this schema those alone are 8,542 rows that no
 * declaration names and that the column gate already covers.
 */
export const LIVE_CONSTRAINTS_QUERY = `
  SELECT n.nspname AS "schema",
         c.relname AS "table",
         con.conname AS "name",
         con.contype AS "kind",
         coalesce((SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                     FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum), '') AS "columns",
         coalesce(fn.nspname, '') AS "foreignSchema",
         coalesce(fc.relname, '') AS "foreignTable",
         coalesce((SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                     FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                     JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum), '') AS "foreignColumns"
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_class fc ON fc.oid = con.confrelid
  LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'drizzle', 'pg_toast')
    AND c.relkind IN ('r', 'p')
    AND con.contype <> 'n'
`;

const list = (columns: readonly string[]): string => columns.join(",");

/** Control D: a btree answers any query its key columns lead. */
export function coversAsPrefix(liveColumns: string, declaredColumns: string): boolean {
  return liveColumns === declaredColumns || liveColumns.startsWith(`${declaredColumns},`);
}

/** Control C: a wider foreign key to the same parent is strictly stronger. */
export function foreignKeyCovers(live: LiveConstraint, declared: DeclaredForeignKey): boolean {
  if (live.kind !== "f") return false;
  if (`${live.foreignSchema}.${live.foreignTable}` !== declared.foreignTable) return false;
  const liveColumns = live.columns.split(",");
  const liveForeign = live.foreignColumns.split(",");
  return (
    declared.columns.every((column) => liveColumns.includes(column)) &&
    declared.foreignColumns.every((column) => liveForeign.includes(column))
  );
}

export function declaredTablesOf(barrel: Readonly<Record<string, unknown>>): DeclaredTable[] {
  const out: DeclaredTable[] = [];
  const seen = new Set<string>();
  for (const exported of Object.values(barrel)) {
    if (!(exported instanceof PgTable)) continue;
    const config = getTableConfig(exported);
    const key = `${config.schema ?? "public"}.${config.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const declaredIndexes: DeclaredIndex[] = config.indexes.map((index) => ({
      name: index.config.name,
      unique: index.config.unique === true,
      partial: index.config.where !== undefined,
      columns: index.config.columns.map((column) =>
        column instanceof Object && "name" in column && typeof column.name === "string" ? column.name : "<expr>",
      ),
    }));
    out.push({
      schema: config.schema ?? "public",
      table: config.name,
      uniques: [
        ...config.uniqueConstraints.map((constraint) => ({
          name: constraint.name ?? "",
          unique: true,
          partial: false,
          columns: constraint.columns.map((column) => column.name),
        })),
        ...declaredIndexes.filter((index) => index.unique),
      ],
      indexes: declaredIndexes.filter((index) => !index.unique),
      foreignKeys: config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        const target = getTableConfig(reference.foreignTable);
        return {
          name: foreignKey.getName(),
          columns: reference.columns.map((column) => column.name),
          foreignTable: `${target.schema ?? "public"}.${target.name}`,
          foreignColumns: reference.foreignColumns.map((column) => column.name),
        };
      }),
      checks: config.checks.map((check) => check.name),
    });
  }
  return out.sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`));
}

export function countDeclaredObjects(tables: readonly DeclaredTable[]): number {
  return tables.reduce(
    (sum, table) =>
      sum + table.uniques.length + table.indexes.length + table.foreignKeys.length + table.checks.length,
    0,
  );
}

export function compare(
  declared: readonly DeclaredTable[],
  liveIndexes: readonly LiveIndex[],
  liveConstraints: readonly LiveConstraint[],
): DriftReport {
  const indexesByTable = new Map<string, LiveIndex[]>();
  for (const index of liveIndexes) {
    const key = `${index.schema}.${index.table}`;
    const bucket = indexesByTable.get(key);
    if (bucket === undefined) indexesByTable.set(key, [index]);
    else bucket.push(index);
  }
  const constraintsByTable = new Map<string, LiveConstraint[]>();
  for (const constraint of liveConstraints) {
    const key = `${constraint.schema}.${constraint.table}`;
    const bucket = constraintsByTable.get(key);
    if (bucket === undefined) constraintsByTable.set(key, [constraint]);
    else bucket.push(constraint);
  }

  const integrity: Finding[] = [];
  const performance: Finding[] = [];
  const nameDrift: Finding[] = [];
  const partialMismatch: Finding[] = [];
  const undeclared: Finding[] = [];
  const missingTables: string[] = [];
  const declaredKeys = new Set<string>();
  let comparedTables = 0;

  for (const table of declared) {
    const key = `${table.schema}.${table.table}`;
    declaredKeys.add(key);
    const indexes = indexesByTable.get(key);
    const constraints = constraintsByTable.get(key);
    if (indexes === undefined && constraints === undefined) {
      missingTables.push(key);
      continue;
    }
    comparedTables += 1;
    const live = indexes ?? [];
    const cons = constraints ?? [];
    const declaredNames = new Set<string>([
      ...table.uniques.map((unique) => unique.name),
      ...table.indexes.map((index) => index.name),
      ...table.foreignKeys.map((foreignKey) => foreignKey.name),
      ...table.checks,
    ]);

    // ---- uniqueness. Control A: index and constraint catalogs are one population.
    for (const declaredUnique of table.uniques) {
      const columns = list(declaredUnique.columns);
      const named =
        live.find((index) => index.name === declaredUnique.name) ??
        cons.find((constraint) => constraint.name === declaredUnique.name);
      const enforcedElsewhere =
        live.find((index) => index.unique && index.columns === columns && index.name !== declaredUnique.name) ??
        cons.find(
          (constraint) =>
            (constraint.kind === "u" || constraint.kind === "p") &&
            constraint.columns === columns &&
            constraint.name !== declaredUnique.name,
        );
      const id = `unique:${key}:${declaredUnique.name}`;
      if (named !== undefined) {
        const isUnique = "unique" in named ? named.unique : named.kind === "u" || named.kind === "p";
        if (named.columns === columns && isUnique) {
          if ("partial" in named && named.partial !== declaredUnique.partial)
            partialMismatch.push({
              id,
              verdict: "partial-mismatch",
              table: key,
              name: declaredUnique.name,
              detail: `declared partial=${String(declaredUnique.partial)}, live partial=${String(named.partial)} "${named.predicate}"`,
            });
          continue;
        }
        if (enforcedElsewhere !== undefined) {
          nameDrift.push({
            id,
            verdict: "name-drift",
            table: key,
            name: declaredUnique.name,
            detail: `the NAME is live on (${named.columns}); the declared columns (${columns}) are unique live as "${enforcedElsewhere.name}". Any 23505 handler naming "${declaredUnique.name}" for this tuple is dead.`,
          });
          continue;
        }
        integrity.push({
          id,
          verdict: "integrity",
          table: key,
          name: declaredUnique.name,
          detail: `live "${declaredUnique.name}" is on (${named.columns}), not the declared (${columns}), and nothing live enforces uniqueness over (${columns})`,
        });
        continue;
      }
      if (enforcedElsewhere !== undefined) {
        nameDrift.push({
          id,
          verdict: "name-drift",
          table: key,
          name: declaredUnique.name,
          detail: `uniqueness over (${columns}) IS enforced live by "${enforcedElsewhere.name}"; only the NAME is absent, so a 23505 handler naming "${declaredUnique.name}" is dead`,
        });
        continue;
      }
      integrity.push({
        id,
        verdict: "integrity",
        table: key,
        name: declaredUnique.name,
        detail: `no live unique constraint or unique index over (${columns}) — duplicates are insertable and any 23505 handler naming it is unreachable`,
      });
    }

    // ---- plain indexes. Controls B and D.
    for (const declaredIndex of table.indexes) {
      const columns = list(declaredIndex.columns);
      const id = `index:${key}:${declaredIndex.name}`;
      const named = live.find((index) => index.name === declaredIndex.name);
      const elsewhere = live.find(
        (index) => index.name !== declaredIndex.name && coversAsPrefix(index.columns, columns),
      );
      if (named !== undefined && named.columns === columns) {
        if (named.partial !== declaredIndex.partial)
          partialMismatch.push({
            id,
            verdict: "partial-mismatch",
            table: key,
            name: declaredIndex.name,
            detail: `declared partial=${String(declaredIndex.partial)}, live partial=${String(named.partial)} "${named.predicate}"`,
          });
        continue;
      }
      if (elsewhere !== undefined) {
        nameDrift.push({
          id,
          verdict: "name-drift",
          table: key,
          name: declaredIndex.name,
          detail:
            named === undefined
              ? `(${columns}) is indexed live as "${elsewhere.name}" (${elsewhere.columns}); only the NAME is absent`
              : `the NAME is live on (${named.columns}); the declared (${columns}) is covered by "${elsewhere.name}" (${elsewhere.columns})`,
        });
        continue;
      }
      performance.push({
        id,
        verdict: "performance",
        table: key,
        name: declaredIndex.name,
        detail: `no live index on (${columns}) and none covering it as a leading prefix`,
      });
    }

    // ---- foreign keys. Control C: match by shape, not by name.
    for (const declaredForeignKey of table.foreignKeys) {
      const id = `foreign-key:${key}:${declaredForeignKey.name}`;
      const covering = cons.find((constraint) => foreignKeyCovers(constraint, declaredForeignKey));
      if (covering !== undefined) {
        if (covering.name !== declaredForeignKey.name)
          nameDrift.push({
            id,
            verdict: "name-drift",
            table: key,
            name: declaredForeignKey.name,
            detail: `covered live by "${covering.name}" (${covering.columns}) -> ${covering.foreignSchema}.${covering.foreignTable}(${covering.foreignColumns})`,
          });
        continue;
      }
      integrity.push({
        id,
        verdict: "integrity",
        table: key,
        name: declaredForeignKey.name,
        detail: `no live foreign key from (${list(declaredForeignKey.columns)}) to ${declaredForeignKey.foreignTable}(${list(declaredForeignKey.foreignColumns)}) — orphan rows are insertable`,
      });
    }

    // ---- checks. Name only: normalising a Drizzle SQL fragment against
    //      pg_get_constraintdef is not reachable without a SQL parser.
    for (const check of table.checks) {
      if (cons.some((constraint) => constraint.kind === "c" && constraint.name === check)) continue;
      integrity.push({
        id: `check:${key}:${check}`,
        verdict: "integrity",
        table: key,
        name: check,
        detail: "no live CHECK constraint of that name — the invariant is enforced only in the service layer, if at all",
      });
    }

    // ---- present-but-undeclared.
    for (const index of live) {
      if (index.primary) continue;
      if (declaredNames.has(index.name)) continue;
      undeclared.push({
        id: `undeclared-index:${key}:${index.name}`,
        verdict: "undeclared",
        table: key,
        name: index.name,
        detail: `live${index.unique ? " UNIQUE" : ""} index on (${index.columns}) that no declaration names`,
      });
    }
    for (const constraint of cons) {
      if (constraint.kind === "p") continue;
      if (declaredNames.has(constraint.name)) continue;
      if (constraint.kind === "f" && table.foreignKeys.some((fk) => foreignKeyCovers(constraint, fk))) continue;
      undeclared.push({
        id: `undeclared-constraint:${key}:${constraint.name}`,
        verdict: "undeclared",
        table: key,
        name: constraint.name,
        detail: `live ${constraint.kind} constraint on (${constraint.columns}) that no declaration names`,
      });
    }
  }

  const order = (a: Finding, b: Finding): number => a.id.localeCompare(b.id);
  return {
    integrity: integrity.sort(order),
    performance: performance.sort(order),
    nameDrift: nameDrift.sort(order),
    partialMismatch: partialMismatch.sort(order),
    undeclared: undeclared.sort(order),
    comparedTables,
    missingTables: missingTables.sort(),
  };
}

export function unbaselined(findings: readonly Finding[], baseline: ReadonlySet<string>): Finding[] {
  return findings.filter((finding) => !baseline.has(finding.id));
}

function readBaseline(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    if (parsed === null || typeof parsed !== "object" || !("accepted" in parsed)) return new Set();
    const accepted = parsed.accepted;
    if (!Array.isArray(accepted)) return new Set();
    return new Set(accepted.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function runSelfTest(): never {
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

function printFindings(label: string, findings: readonly Finding[], limit: number): void {
  for (const finding of findings.slice(0, limit)) console.error(`  ${label} ${finding.table}.${finding.name} — ${finding.detail}`);
  if (findings.length > limit) console.error(`  … and ${String(findings.length - limit)} more`);
}

async function main(): Promise<void> {
  if (SELF_TEST) runSelfTest();

  const declared = declaredTablesOf({ ...schema });
  const objects = countDeclaredObjects(declared);
  console.log(`Declared tables ${String(declared.length)}  ·  declared constraints/indexes ${String(objects)}`);
  if (declared.length < MIN_DECLARED_TABLES || objects < MIN_DECLARED_OBJECTS) {
    console.error(
      `INCONCLUSIVE — the declaration scan found ${String(declared.length)} tables (floor ${String(MIN_DECLARED_TABLES)}) and ${String(objects)} objects (floor ${String(MIN_DECLARED_OBJECTS)}). A clean result over an empty scan proves nothing.`,
    );
    process.exit(2);
  }

  if (GATE_URL === undefined || GATE_URL === "") {
    const stream = ALLOW_PARTIAL ? console.warn : console.error;
    stream(
      `${ALLOW_PARTIAL ? "PARTIAL" : "INCONCLUSIVE"} — the catalog half did not run. Whether a declared constraint exists is only in pg_constraint/pg_index; nothing static can see it, so all ${String(objects)} declared objects are UNVERIFIED.`,
    );
    stream("  Set CONSTRAINT_DRIFT_GATE_DATABASE_URL to a database bootstrapped to journal head to run it.");
    if (!ALLOW_PARTIAL) {
      console.error("  Or set STREAMLINE_ALLOW_PARTIAL_GATES=1 to accept a declaration-only run.");
      process.exit(2);
    }
    console.warn("  STREAMLINE_ALLOW_PARTIAL_GATES=1 — this run proves nothing about the catalog.");
    return;
  }

  const sql = postgres(GATE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const liveIndexes = await sql.unsafe<LiveIndex[]>(LIVE_INDEXES_QUERY);
    const liveConstraints = await sql.unsafe<LiveConstraint[]>(LIVE_CONSTRAINTS_QUERY);
    if (liveIndexes.length < MIN_LIVE_INDEXES || liveConstraints.length < MIN_LIVE_CONSTRAINTS) {
      console.error(
        `INCONCLUSIVE — the catalog reports ${String(liveIndexes.length)} indexes (floor ${String(MIN_LIVE_INDEXES)}) and ${String(liveConstraints.length)} constraints (floor ${String(MIN_LIVE_CONSTRAINTS)}). This database is not bootstrapped to head.`,
      );
      process.exit(2);
    }

    const report = compare(declared, liveIndexes, liveConstraints);
    console.log(
      `Live indexes ${String(liveIndexes.length)}  ·  live constraints ${String(liveConstraints.length)}  ·  tables compared ${String(report.comparedTables)}  ·  declared-but-absent tables ${String(report.missingTables.length)}`,
    );
    console.log(
      `Reported, never failed — name drift ${String(report.nameDrift.length)}  ·  partial-predicate mismatch ${String(report.partialMismatch.length)}  ·  live-but-undeclared ${String(report.undeclared.length)}`,
    );

    if (EMIT_BASELINE) {
      const accepted = [...report.integrity, ...report.performance].map((finding) => finding.id).sort();
      writeFileSync(
        BASELINE_PATH,
        `${JSON.stringify(
          {
            note: "Findings accepted at the time of writing. The gate fails only on findings NOT listed here. This list can only shrink — every entry is a declared constraint or index that does not exist at journal head.",
            generated: new Date().toISOString().slice(0, 10),
            accepted,
          },
          null,
          2,
        )}\n`,
      );
      console.log(`Wrote ${String(accepted.length)} accepted findings to ${BASELINE_PATH}`);
      return;
    }

    const baseline = readBaseline();
    const newIntegrity = unbaselined(report.integrity, baseline);
    const newPerformance = unbaselined(report.performance, baseline);
    console.log(
      `Integrity findings ${String(report.integrity.length)} (${String(newIntegrity.length)} new)  ·  performance findings ${String(report.performance.length)} (${String(newPerformance.length)} new)  ·  baseline ${String(baseline.size)}`,
    );

    if (newIntegrity.length > 0) {
      console.error(
        `\nFAIL — ${String(newIntegrity.length)} declared constraint(s) do not exist at journal head. Duplicates or orphans are insertable and any 23505/23503 handler naming them is unreachable:`,
      );
      printFindings("INTEGRITY", newIntegrity, 40);
    }
    if (newPerformance.length > 0) {
      console.error(`\nFAIL — ${String(newPerformance.length)} declared index(es) do not exist at journal head:`);
      printFindings("PERFORMANCE", newPerformance, 40);
    }
    if (newIntegrity.length > 0 || newPerformance.length > 0) {
      console.error(
        "\nFix: write the migration and register it in migrations/meta/_journal.json. A .sql under migrations/pending/ never runs — that is the whole defect class this gate exists for.",
      );
      process.exit(1);
    }
    console.log("Catalog half OK — every declared constraint and index either exists at head or is baselined.");
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(`check-declaration-constraint-drift: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
