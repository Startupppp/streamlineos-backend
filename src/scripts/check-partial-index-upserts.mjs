/**
 * check-partial-index-upserts.mjs
 *
 * An `ON CONFLICT` target that names a PARTIAL unique index, without repeating
 * that index's predicate, is not a weaker guarantee — it is a statement
 * PostgreSQL refuses outright:
 *
 *   there is no unique or exclusion constraint matching the ON CONFLICT
 *   specification
 *
 * Every insert through that path throws. Inventory shipped one: the webhook
 * emitter's upsert named `(org_id, webhook_id, dedupe_key)` and the index is
 * `WHERE dedupe_key IS NOT NULL`, so no webhook was ever enqueued, the outbox
 * dispatch that called it threw and dead-lettered, and nine unit suites over
 * those files passed throughout — none of them inserts against a real partial
 * index.
 *
 * That is why this is a gate rather than a code review note. The failure is
 * invisible to every test with a fake database and to every reading of the
 * call site, because the missing half is in the schema file.
 *
 * Usage:
 *   node src/scripts/check-partial-index-upserts.mjs
 *   node src/scripts/check-partial-index-upserts.mjs --self-test
 *
 * Exit codes:
 *   0 — every upsert onto a partial unique index repeats its predicate
 *   1 — one or more do not
 *   2 — vacuity guard (no partial unique indexes found — the scan is broken)
 *   3 — self-test failure
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(__dirname, "../..");
const SCHEMA_ROOT = join(BACKEND_ROOT, "src", "db", "schema");
const CODE_ROOTS = [join(BACKEND_ROOT, "src", "modules"), join(BACKEND_ROOT, "src", "common")];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (/\.(spec|e2e-spec|db\.spec)\.ts$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Every partial unique index, keyed by the Drizzle table export it belongs to.
 *
 * Column names alone are not enough to identify an index: `(orgId, moduleKey)`
 * is a partial unique index on one table and an ordinary one on another. A
 * check that matched on columns alone reported 32 hits, of which the real
 * count was one. So the table has to come along.
 *
 * Read from the schema rather than the database, so the check runs with no
 * connection and in CI before a migration has been applied anywhere.
 */
export function partialUniqueIndexes(source) {
  const found = [];
  // Each `export const x = pgTable(...)` owns everything up to the next one.
  const chunks = source.split(/\bexport\s+const\s+/g);
  for (const chunk of chunks) {
    const decl = /^([A-Za-z0-9_$]+)\s*=\s*pgTable\(/.exec(chunk);
    if (!decl) continue;
    const table = decl[1];
    // `uniqueIndex("name")` … `.on(a, b, c)` … `.where(` — across lines, which
    // is how every one of them is written.
    //
    // The gaps are TEMPERED: no further index declaration may appear inside
    // them. Without that, a plain `uniqueIndex(...).on(...)` followed by a
    // partial `index(...).on(...).where(...)` two lines down reads as one
    // partial unique index, and the check invents four findings that the
    // database flatly denies. Tempering is the difference between this gate
    // and a rumour.
    const GAP = "(?:(?!(?:uniqueIndex|index|primaryKey|foreignKey|check)\\()[\\s\\S])";
    const re = new RegExp(
      `uniqueIndex\\(\\s*["'\`]([^"'\`]+)["'\`]\\s*\\)${GAP}{0,400}?\\.on\\(([^)]*)\\)${GAP}{0,200}?\\.where\\(`,
      "g",
    );
    for (const match of chunk.matchAll(re)) {
      const columns = match[2]
        .split(",")
        .map((part) => part.trim().split(".").pop())
        .filter(Boolean);
      if (columns.length > 0) found.push({ name: match[1], table, columns });
    }
  }
  return found;
}

/**
 * Every `onConflictDo*` with an explicit target, the table being inserted into,
 * and whether the call repeats a predicate.
 */
export function upsertTargets(source) {
  const found = [];
  // Drizzle spells the target predicate differently per operation, and the
  // near-miss spellings are the trap:
  //
  //   onConflictDoNothing({ target, where })            -> where       qualifies the TARGET
  //   onConflictDoUpdate ({ target, targetWhere, set,
  //                         setWhere })                 -> targetWhere qualifies the TARGET
  //                                                        setWhere    qualifies the UPDATE
  //
  // `setWhere` reads like a predicate and satisfies nothing: PostgreSQL still
  // refuses the statement. Accepting it would have hidden a live bug, and
  // rejecting `targetWhere` invented one. Both happened here before this split.
  const re = /onConflictDo(Nothing|Update)\(\s*\{([\s\S]{0,600}?)\}\s*\)/g;
  for (const match of source.matchAll(re)) {
    const operation = match[1];
    const body = match[2];
    const predicateKey = operation === "Nothing" ? "where" : "targetWhere";
    const target = /target:\s*\[([^\]]*)\]/.exec(body);
    if (!target) continue;
    const columns = target[1]
      .split(",")
      .map((part) => part.trim().split(".").pop())
      .filter(Boolean);
    // The nearest `.insert(<table>)` above the call is the table it lands on.
    const before = source.slice(0, match.index);
    const inserts = [...before.matchAll(/\.insert\(\s*([A-Za-z0-9_$]+)\s*\)/g)];
    const table = inserts.length > 0 ? inserts[inserts.length - 1][1] : null;
    found.push({
      line: before.split("\n").length,
      table,
      columns,
      operation,
      predicateKey,
      hasWhere: new RegExp(`(^|[\\s{,])${predicateKey}:`).test(body),
    });
  }
  return found;
}

/**
 * Offenders this repository knows about and cannot fix from here.
 *
 * An entry is NOT an exemption for a pattern — it is a named, still-broken
 * statement with a reason it is out of reach. The check fails if one of these
 * stops being an offender, so a fix upstream retires the entry instead of
 * leaving a stale note behind.
 */
const ACKNOWLEDGED = [
  // The two `payroll/payout/locking.service.ts` entries that used to sit here — the
  // user and worker branches of the TDS YTD upsert — were RETIRED on 2026-09-12
  // because the payroll owner answered the open question they recorded. The list is
  // empty on purpose; an empty list is a state this gate reports, not a state that
  // needs a placeholder.
  //
  // What they said was open: the live index was five columns
  // (org_id, <subject>, fiscal_year, period_key, run_id) while the schema and the
  // upsert target named four, so per-run versus per-period YTD was a product call
  // nobody outside payroll could make. All three now agree on five — verified in
  // src/db/schema/payroll/entities-periods.ts:253-258, in the two `target:` arrays at
  // locking.service.ts:292 and :312, and against pg_indexes on a database built from
  // this branch — and each upsert now repeats the index predicate as
  // `targetWhere: sql\`…userId/workerId is not null\``, which is what makes Postgres
  // pick the partial index instead of raising 42P10.
  //
  // Deleted rather than left: the docblock above means it, and an acknowledgement that
  // has stopped being true is how a list like this turns into a rubber stamp.
];

function main() {
  const schemaFiles = walk(SCHEMA_ROOT);
  const indexes = [];
  for (const file of schemaFiles)
    indexes.push(...partialUniqueIndexes(readFileSync(file, "utf8")));

  if (indexes.length === 0) {
    process.stdout.write(
      `VACUITY GUARD — scanned ${schemaFiles.length} schema files and found no partial unique ` +
        `index. There are known to be several; the scan is broken.\n`,
    );
    process.exit(2);
  }

  /** Table plus column set, order-insensitive so a reordered target still matches. */
  const keyOf = (table, columns) => `${table}::${[...columns].sort().join("|")}`;
  const partialSets = indexes.map((index) => ({
    ...index,
    key: keyOf(index.table, index.columns),
  }));

  const offenders = [];
  let scanned = 0;
  for (const file of CODE_ROOTS.flatMap((root) => walk(root))) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("onConflictDo")) continue;
    scanned += 1;
    for (const upsert of upsertTargets(source)) {
      if (upsert.hasWhere || !upsert.table) continue;
      const key = keyOf(upsert.table, upsert.columns);
      const hit = partialSets.find((index) => index.key === key);
      if (!hit) continue;
      offenders.push({
        file: relative(BACKEND_ROOT, file).replace(/\\/g, "/"),
        line: upsert.line,
        index: hit.name,
        table: upsert.table,
        predicateKey: upsert.predicateKey,
        columns: upsert.columns.join(", "),
      });
    }
  }

  process.stdout.write(
    `Scanned ${scanned} file(s) using onConflictDo against ${indexes.length} partial unique index(es).\n\n`,
  );

  const isAcknowledged = (o) =>
    ACKNOWLEDGED.some((a) => a.file === o.file && a.index === o.index);
  const known = offenders.filter(isAcknowledged);
  const unknown = offenders.filter((o) => !isAcknowledged(o));

  if (known.length > 0) {
    process.stdout.write(`Known and out of reach — STILL BROKEN, not accepted:\n`);
    for (const o of known) {
      const reason = ACKNOWLEDGED.find((a) => a.file === o.file && a.index === o.index).reason;
      process.stdout.write(`  ${o.file}:${o.line}  ${o.index}\n      ${reason}\n`);
    }
    process.stdout.write("\n");
  }

  const stale = ACKNOWLEDGED.filter(
    (a) => !offenders.some((o) => o.file === a.file && o.index === a.index),
  );
  if (stale.length > 0) {
    process.stdout.write(`FAIL — ${stale.length} acknowledgement(s) no longer describe an offender:\n`);
    for (const a of stale) process.stdout.write(`  ${a.file}  ${a.index}\n`);
    process.stdout.write(`\nIf these were fixed, delete the entries. An acknowledgement that has\nstopped being true is how a list like this turns into a rubber stamp.\n`);
    process.exit(1);
  }

  if (unknown.length > 0) {
    process.stdout.write(`FAIL — ${unknown.length} upsert(s) name a partial index without its predicate:\n`);
    for (const o of unknown)
      process.stdout.write(
        `  ${o.file}:${o.line}  insert(${o.table}) target (${o.columns}) matches partial ` +
          `index ${o.index} — add \`${o.predicateKey}\`\n`,
      );
    process.stdout.write(
      `\nPostgreSQL refuses the statement outright — every insert through that path throws. ` +
        `Repeat the index's predicate on the onConflict call, under the key named above.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `PASS — every reachable upsert onto a partial unique index repeats its predicate` +
      `${known.length > 0 ? `; ${known.length} known-broken statement(s) remain out of reach above` : ""}.\n`,
  );
}

function selfTest() {
  const schema = `
  export const invWebhookEvents = pgTable("inv_webhook_events", {}, (table) => [
    uniqueIndex("uniq_thing")
      .on(table.orgId, table.webhookId, table.dedupeKey)
      .where(sql\`dedupe_key is not null\`),
    uniqueIndex("uniq_plain").on(table.orgId, table.name),
    // The shape that produced four false findings: a PLAIN unique index whose
    // neighbour two lines down carries the predicate.
    uniqueIndex("uniq_neighbour").on(table.orgId, table.connectionId),
    index("idx_due").on(table.orgId, table.lastRunAt).where(sql\`enabled = true\`),
  ]);
  export const orgModules = pgTable("org_modules", {}, (table) => [
    index("ix_org_modules").on(table.orgId, table.webhookId, table.dedupeKey),
  ]);
  `;
  const indexes = partialUniqueIndexes(schema);

  const bad = `
    await db.insert(invWebhookEvents).values(row).onConflictDoNothing({
      target: [t.orgId, t.webhookId, t.dedupeKey],
    })
  `;
  const good = `
    await db.insert(invWebhookEvents).values(row).onConflictDoNothing({
      target: [t.orgId, t.webhookId, t.dedupeKey],
      where: sql\`dedupe_key is not null\`,
    })
  `;
  // `targetWhere` is the DO UPDATE spelling and DOES satisfy PostgreSQL.
  const updateGood = `
    await db.insert(invWebhookEvents).values(row).onConflictDoUpdate({
      target: [t.orgId, t.webhookId, t.dedupeKey],
      targetWhere: sql\`dedupe_key is not null\`,
      set: { seenAt: now },
    })
  `;
  // `setWhere` qualifies the UPDATE, not the target — PostgreSQL still refuses.
  const updateBad = `
    await db.insert(invWebhookEvents).values(row).onConflictDoUpdate({
      target: [t.orgId, t.webhookId, t.dedupeKey],
      set: { seenAt: now },
      setWhere: sql\`dedupe_key is not null\`,
    })
  `;
  // Same columns, different table, ordinary index — must NOT be flagged.
  const otherTable = `
    await db.insert(orgModules).values(row).onConflictDoNothing({
      target: [t.orgId, t.webhookId, t.dedupeKey],
    })
  `;

  const checks = {
    findsOnlyThePartialIndex: indexes.length === 1 && indexes[0].name === "uniq_thing",
    ignoresANeighboursPredicate: !indexes.some((i) => i.name === "uniq_neighbour"),
    readsItsColumns: indexes[0]?.columns.join(",") === "orgId,webhookId,dedupeKey",
    readsTheOwningTable: indexes[0]?.table === "invWebhookEvents",
    flagsTheBareTarget: upsertTargets(bad)[0]?.hasWhere === false,
    bindsTheTarget: upsertTargets(bad)[0]?.table === "invWebhookEvents",
    acceptsThePredicate: upsertTargets(good)[0]?.hasWhere === true,
    separatesSameColumnsOnAnotherTable: upsertTargets(otherTable)[0]?.table === "orgModules",
    acceptsTargetWhereOnUpdate: upsertTargets(updateGood)[0]?.hasWhere === true,
    rejectsSetWhereOnUpdate: upsertTargets(updateBad)[0]?.hasWhere === false,
  };

  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  process.stdout.write(`${JSON.stringify({ selfTest: true, checks }, null, 2)}\n`);
  if (failed.length > 0) process.exit(3);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
