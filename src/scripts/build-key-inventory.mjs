#!/usr/bin/env node
/**
 * Build the PRD-C057 inventory: every in-scope database column, primary /
 * foreign / unique / check constraint, index and JSONB key, plus every
 * executable code registry — routes, permissions, modules, events, commands,
 * query and cache keys, configuration, environment variables, feature flags and
 * translations — classified KEEP, REFACTOR or REMOVE with its owner and the
 * concrete failure the verdict prevents.
 *
 * Machine-readable on purpose. The prior wave's inventory was prose, went stale
 * inside a day (it recorded 15 baselined referential-action divergences where
 * the gate now prints 62) and contradicted itself between sections. This one is
 * regenerated from head in one command and validated by
 * check-key-inventory.mjs, which fails when a registry is missing, a row is
 * unclassified, or the database half stops matching pg_catalog.
 *
 * Usage:
 *   node src/scripts/build-key-inventory.mjs --db=<url> --out=<dir> [--frontend=<path>]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import postgres from "postgres";

import { COLUMNS_QUERY, CONSTRAINTS_QUERY, foreignKeyIsCovered, INDEXES_QUERY } from "./key-inventory/database.mjs";
import { literalIndex, reach, tokenIndex, walk } from "./key-inventory/corpus.mjs";
import {
  areaOfKey,
  areaOfTable,
  classifyColumn,
  classifyForeignKey,
  classifyIndex,
  classifyUnique,
} from "./key-inventory/classify.mjs";
import * as registries from "./key-inventory/registries.mjs";

const BACKEND = resolve(import.meta.dirname, "../..");
const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const DB_URL = argument("db");
const OUT_DIR = argument("out");
const FRONTEND = resolve(argument("frontend") ?? join(BACKEND, "../streamlineos-frontend/frontend"));

const FLOORS = { columns: 10_000, indexes: 3_000, operations: 3_000, permissions: 500 };

function fail(message) {
  console.error(message);
  process.exit(2);
}

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

async function main() {
  if (DB_URL === undefined || OUT_DIR === undefined) fail("usage: build-key-inventory.mjs --db=<url> --out=<dir> [--frontend=<path>]");
  mkdirSync(OUT_DIR, { recursive: true });

  // Migrations are deliberately OUT of the reach corpus. Every column name
  // appears in the CREATE TABLE that made it, so counting migrations as a
  // sighting makes every column reachable and the census reports nothing.
  // The inventory's own tooling is NOT a reader. Its rule text names the columns
  // it classifies (feature_flags.rollout_percentage among them), so counting it
  // as a sighting makes every column it discusses look reachable — the census
  // would launder its own prose into evidence.
  const backendFiles = walk(join(BACKEND, "src"), {
    skipPaths: ["db/schema", "scripts/key-inventory", "scripts/build-key-inventory.mjs", "scripts/check-key-inventory.mjs"],
  });
  const frontendFiles = walk(FRONTEND, { skipPaths: ["lib/rbac/permissions", "contracts"] });
  const backend = tokenIndex(backendFiles.filter((file) => !file.includes("/src/db/schema/")), { root: BACKEND, label: "backend" });
  const frontend = tokenIndex(frontendFiles, { root: FRONTEND, label: "frontend" });
  const contract = tokenIndex([join(BACKEND, "openapi.json")], { root: BACKEND, label: "contract" });
  const corpora = [backend.index, frontend.index, contract.index];
  const literals = [
    literalIndex(backendFiles.filter((file) => !file.includes("/src/modules/rbac/permissions/")), { root: BACKEND, label: "backend" }),
    literalIndex(frontendFiles, { root: FRONTEND, label: "frontend" }),
    literalIndex([join(BACKEND, "openapi.json")], { root: BACKEND, label: "contract" }),
  ];
  const literalReach = (key) => {
    for (const index of literals) {
      const hit = index.get(key);
      if (hit !== undefined) return hit;
    }
    return null;
  };
  console.log(
    `Corpus — backend ${String(backend.files)} files / ${String(backend.lines)} lines · frontend ${String(frontend.files)} / ${String(frontend.lines)} · openapi.json ${String(contract.lines)} lines`,
  );

  const sql = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => {} });
  let columns;
  let constraints;
  let indexes;
  try {
    columns = await sql.unsafe(COLUMNS_QUERY);
    constraints = await sql.unsafe(CONSTRAINTS_QUERY);
    indexes = await sql.unsafe(INDEXES_QUERY);
  } finally {
    await sql.end();
  }
  if (columns.length < FLOORS.columns || indexes.length < FLOORS.indexes)
    fail(`INCONCLUSIVE — ${String(columns.length)} columns and ${String(indexes.length)} indexes. This database is not bootstrapped to journal head.`);

  const keyColumns = new Map();
  for (const constraint of constraints) {
    for (const column of constraint.cols === "" ? [] : constraint.cols.split(",")) {
      const id = `${constraint.schema}.${constraint.tbl}.${column}`;
      const names = keyColumns.get(id);
      if (names === undefined) keyColumns.set(id, [constraint.name]);
      else names.push(constraint.name);
    }
  }
  const tenantColumns = new Set(["org_id", "organization_id"]);

  const rows = [];
  for (const column of columns) {
    const id = `${column.schema}.${column.tbl}.${column.col}`;
    const constraintNames = keyColumns.get(id) ?? [];
    rows.push(
      classifyColumn(column, {
        isKeyColumn: constraintNames.length > 0,
        constraintNames,
        reachedAt: reach(corpora, column.col),
      }),
    );
  }

  const declaredIndexNames = new Set(
    walk(join(BACKEND, "src/db/schema"), { extensions: new Set([".ts"]) })
      .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/(?:index|uniqueIndex|unique)\(\s*["'`]([^"'`]+)["'`]/g)])
      .map((match) => match[1])
      .filter((name) => name !== undefined),
  );
  const overlapReasons = new Map();
  const overlapPath = join(OUT_DIR, "c059-redundancy-detection.json");
  try {
    for (const overlap of JSON.parse(readFileSync(overlapPath, "utf8")).rows ?? [])
      overlapReasons.set(`${overlap.schema}.${overlap.tbl}.${overlap.candidate}`, overlap.preserveReason);
  } catch {
    console.warn(`  (no redundancy detection at ${overlapPath}; index rows carry no overlap reason)`);
  }
  for (const index of indexes)
    rows.push(
      classifyIndex(index, {
        declared: declaredIndexNames.has(index.name),
        overlapReason: overlapReasons.get(`${index.schema}.${index.tbl}.${index.name}`) ?? null,
      }),
    );

  for (const constraint of constraints) {
    if (constraint.kind === "f") rows.push(classifyForeignKey(constraint, foreignKeyIsCovered(constraint, indexes)));
    else if (constraint.kind === "u") rows.push(classifyUnique(constraint, tenantColumns));
    else if (constraint.kind === "p")
      rows.push({
        registry: "database.primary-key",
        item: `${constraint.schema}.${constraint.tbl}.${constraint.name}`,
        owner: areaOfTable(constraint.schema, constraint.tbl),
        verdict: "KEEP",
        failurePrevented: "Without a primary key the table has no stable row identity: no upsert conflict target, no replica identity, and no safe cursor.",
        evidence: `pg_catalog: ${constraint.definition}`,
      });
    else
      rows.push({
        registry: "database.check",
        item: `${constraint.schema}.${constraint.tbl}.${constraint.name}`,
        owner: areaOfTable(constraint.schema, constraint.tbl),
        verdict: /_check$/.test(constraint.name) ? "REFACTOR" : "KEEP",
        failurePrevented: /_check$/.test(constraint.name)
          ? "The constraint carries Postgres's default name, so no application error handler can name it and a 23514 surfaces as an opaque 500 instead of a field error."
          : "A domain invariant enforced in the database, where it survives every writer including raw SQL and migrations.",
        evidence: `pg_catalog: ${constraint.definition}`,
      });
  }

  const { jsonbRows, jsonbKeyRows } = jsonbInventory(columns, indexes, corpora);
  rows.push(...jsonbRows, ...jsonbKeyRows);
  rows.push(...codeRegistryRows(corpora, literalReach));

  const byRegistry = new Map();
  for (const row of rows) {
    const bucket = byRegistry.get(row.registry);
    if (bucket === undefined) byRegistry.set(row.registry, [row]);
    else bucket.push(row);
  }
  for (const [registry, bucket] of byRegistry) writeFileSync(join(OUT_DIR, `${registry.replace(/\./g, "-")}.jsonl`), jsonl(bucket));

  const summary = {
    generated: new Date().toISOString().slice(0, 10),
    database: DB_URL.replace(/:\/\/[^@]*@/, "://"),
    corpus: { backendFiles: backend.files, frontendFiles: frontend.files },
    totals: { entries: rows.length },
    registries: [...byRegistry.entries()]
      .map(([registry, bucket]) => ({
        registry,
        entries: bucket.length,
        KEEP: bucket.filter((row) => row.verdict === "KEEP").length,
        REFACTOR: bucket.filter((row) => row.verdict === "REFACTOR").length,
        REMOVE: bucket.filter((row) => row.verdict === "REMOVE").length,
      }))
      .sort((a, b) => a.registry.localeCompare(b.registry)),
  };
  writeFileSync(join(OUT_DIR, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Wrote ${String(rows.length)} classified entries across ${String(byRegistry.size)} registries to ${OUT_DIR}`);
  for (const registry of summary.registries)
    console.log(`  ${registry.registry.padEnd(28)} ${String(registry.entries).padStart(6)}  KEEP ${String(registry.KEEP)} · REFACTOR ${String(registry.REFACTOR)} · REMOVE ${String(registry.REMOVE)}`);
}

function jsonbInventory(columns, indexes, corpora) {
  const jsonbColumns = columns.filter((column) => column.data_type === "jsonb" || column.data_type === "json");
  const expressionIndexes = indexes.filter((index) => /->>?/.test(index.definition));
  const filtered = new Map();
  for (const file of walk(join(BACKEND, "src"), { skipPaths: ["db/schema", "scripts/key-inventory"], extensions: new Set([".ts"]) })) {
    if (/\.spec\.ts$/.test(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      for (const match of line.matchAll(/([A-Za-z_][A-Za-z0-9_.]*|\})\s*->>?\s*'([^']+)'/g)) {
        const [, rawColumn, key] = match;
        const column = rawColumn === "}" ? "(sql-template)" : rawColumn;
        if (column === undefined || key === undefined) continue;
        const id = `${column}->>'${key}'`;
        if (!filtered.has(id))
          filtered.set(id, { column, key, evidence: `backend:${file.slice(BACKEND.length + 1)}:${String(i + 1)}` });
      }
    }
  }
  const jsonbRows = jsonbColumns.map((column) => {
    const reachedAt = reach(corpora, column.col);
    const owner = areaOfTable(column.schema, column.tbl);
    if (reachedAt === null)
      return {
        registry: "database.jsonb-column",
        item: `${column.schema}.${column.tbl}.${column.col}`,
        owner,
        verdict: "REMOVE",
        failurePrevented: "An opaque payload nothing reads or writes. It cannot be validated, migrated or erased on request, and it is the easiest place for personal data to survive a deletion.",
        evidence: "token census: 0 sightings outside src/db/schema",
      };
    return {
      registry: "database.jsonb-column",
      item: `${column.schema}.${column.tbl}.${column.col}`,
      owner,
      verdict: "KEEP",
      failurePrevented: "Reached by live code as an opaque payload; no property inside it is filtered, joined or authorized on.",
      evidence: reachedAt,
    };
  });
  const jsonbKeyRows = [...filtered.values()].map((entry) => {
    const indexed = expressionIndexes.some((index) => index.definition.includes(`'${entry.key}'`));
    return {
      registry: "database.jsonb-key",
      item: `${entry.column}->>'${entry.key}'`,
      owner: "see evidence site",
      verdict: indexed ? "KEEP" : "REFACTOR",
      failurePrevented: indexed
        ? "Filtered in SQL and backed by an expression index, so the predicate is a lookup rather than a scan of every row's payload."
        : "PRD-C058: a JSONB property that is filtered or joined in SQL with no expression index forces a full scan and a per-row JSON parse, and it cannot be constrained, so a typo writes a silently unreachable row. Normalise it to a column or index the expression.",
      evidence: entry.evidence,
    };
  });
  return { jsonbRows, jsonbKeyRows };
}

function codeRegistryRows(corpora, literalReach) {
  const rows = [];
  const operations = registries.operations(join(BACKEND, "openapi.json"));
  if (operations.length < FLOORS.operations) fail(`INCONCLUSIVE — openapi.json yielded ${String(operations.length)} operations.`);
  for (const operation of operations)
    rows.push({
      registry: "code.route",
      item: operation.item,
      owner: areaOfKey(operation.permission === "" ? (operation.item.split(" ")[1] ?? "").split("/")[1] ?? "platform-core" : operation.permission),
      verdict: operation.hasResponseSchema ? "KEEP" : "REFACTOR",
      failurePrevented: operation.hasResponseSchema
        ? "The operation declares a 2xx JSON schema, so check:contract-breaking-change can see a removed response field."
        : "PRD-C063: the operation declares no 2xx JSON schema, so removing a field from its response is invisible to check:contract-breaking-change and reaches the frontend as undefined at runtime.",
      evidence: `openapi.json: ${operation.item}`,
    });

  const permissionsDir = join(BACKEND, "src/modules/rbac/permissions");
  const permissionKeys = registries.permissions(permissionsDir);
  if (permissionKeys.length < FLOORS.permissions) fail(`INCONCLUSIVE — the permission catalog yielded ${String(permissionKeys.length)} keys.`);
  const routeBound = new Set(operations.map((operation) => operation.permission).filter((key) => key !== ""));
  for (const permission of permissionKeys) {
    const bound = routeBound.has(permission.item);
    const reachedAt = literalReach(permission.item);
    const inContract = false;
    rows.push({
      registry: "code.permission",
      item: permission.item,
      owner: areaOfKey(permission.item),
      verdict: bound || permission.generated ? "KEEP" : reachedAt !== null || inContract ? "REFACTOR" : "REMOVE",
      failurePrevented: bound
        ? "Bound to at least one route, so the key gates something real."
        : permission.generated
          ? "Synthesised per access-managed module and resolved through a template, never as a literal — a literal reach search cannot see it and must not call it dead."
          : reachedAt !== null || inContract
          ? "PRD-C061: catalogued and referenced but bound to no route in openapi.json. A key that gates nothing still appears in role editors and reads as authority the system does not enforce."
          : "PRD-C061: bound to no route and reached nowhere outside the catalog. hr:bank-details:view advertises authority over unmasked bank details and gates nothing — a catalogue entry that promises a control it does not implement is worse than its absence. Delete or bind, and run classifyRetiredPermissions against real tenant grants first.",
      evidence: reachedAt ?? `src/modules/rbac/permissions/${permission.evidence}`,
    });
  }

  const moduleList = registries.modules(join(BACKEND, "module-manifest.json"));
  const planGatedModules = new Set(moduleList.filter((module) => module.planGated).map((module) => module.item));
  for (const module of moduleList) {
    // The real defect is a permission key whose SECOND segment names a different
    // module: access-policy.ts resolves entitlement from the first segment alone,
    // so hr:payroll:approve bills against hr and an org that bought Payroll gets
    // a 402 naming HR. A plan-gated module with no administered namespaces is
    // only a finding when such a collision exists against it.
    const collisions = permissionKeys
      .map((permission) => permission.item.split(":"))
      .filter(
        (segments) =>
          segments[0] === module.item &&
          segments[1] !== undefined &&
          segments[1] !== segments[0] &&
          segments[1] !== "settings" &&
          planGatedModules.has(segments[1]),
      )
      .map((segments) => segments.join(":"));
    const collides = collisions.length > 0 && module.administersNamespaces.length === 0;
    rows.push({
      registry: "code.module",
      item: module.item,
      owner: module.productKey === "" ? module.item : module.productKey,
      verdict: collides ? "REFACTOR" : "KEEP",
      failurePrevented: collides
        ? `PRD-C062: ${String(collisions.length)} permission key(s) under this module name another module in their second segment (${collisions.slice(0, 4).join(", ")}) and access-policy.ts resolves entitlement from the first segment alone, so they bill against ${module.item}. An org that buys ${collisions[0]?.split(":")[1] ?? "the other product"} without ${module.item} gets a 402 naming the wrong product. Fix by migrating the keys or declaring the namespace in administersNamespaces.`
        : "A manifest entry that resolves entitlement for its own namespace with no cross-module key colliding into it.",
      evidence: `module-manifest.json: ${module.item}`,
    });
  }

  for (const event of registries.events(join(BACKEND, "src/modules/notifications"), join(BACKEND, "src/modules/inventory/webhooks/dto/webhooks.schemas.ts"))) {
    const reachedAt = literalReach(event.item);
    rows.push({
      registry: "code.event",
      item: event.item,
      owner: areaOfKey(event.item),
      verdict: "KEEP",
      failurePrevented:
        "The relay rejects any event key not in the catalog, so an entry removed here turns a live emit into a thrown request. Removal needs the emit site retired first.",
      evidence: reachedAt ?? `${event.kind} catalog: ${event.evidence}`,
    });
  }

  const catalogued = new Set(rows.filter((row) => row.registry === "code.event").map((row) => row.item));
  for (const event of registries.contractRegistryEvents(join(BACKEND, "contracts/api-contract-registry.json"))) {
    // A name can appear in BOTH `events` and `webhooks` — survey.response.submitted
    // does — so the guard has to grow as rows are pushed, not just start from the
    // notification catalog.
    if (catalogued.has(event.item)) continue;
    catalogued.add(event.item);
    const reachedAt = literalReach(event.item);
    rows.push({
      registry: "code.event",
      item: event.item,
      owner: areaOfKey(event.item),
      verdict: "KEEP",
      failurePrevented:
        event.kind === "outbound-webhook"
          ? "A versioned outbound event name with a named consumer. check:contract-registry fails on an emitted name the registry does not carry, and removing one breaks every subscriber silently — the delivery simply stops."
          : "A versioned OutboxWriter event. The relay rejects any key the catalog does not hold, so removing it turns a live emit into a thrown request.",
      evidence: reachedAt ?? event.evidence,
    });
  }

  for (const command of registries.commands(join(FRONTEND, "lib/command-catalog.ts")))
    rows.push({
      registry: "code.command",
      item: command.item,
      owner: command.item.split("_")[0]?.toLowerCase() ?? "platform-core",
      verdict: "KEEP",
      failurePrevented: "check:command-catalog fails on any unclassified hook; the catalog is the classification, so an entry removed without its hook fails the gate.",
      evidence: command.evidence,
    });

  for (const factory of registries.queryKeyFactories(join(FRONTEND, "lib/query-keys")))
    rows.push({
      registry: "code.query-key",
      item: factory.item,
      owner: factory.evidence.split(":")[0]?.replace(/\.ts$/, "") ?? "frontend",
      verdict: "KEEP",
      failurePrevented:
        "One typed domain-owned factory per key family. check:query-scope bans inline queryKey literals over 5,411 files; deleting a factory pushes its callers back to ad-hoc arrays that no invalidation prefix can reach.",
      evidence: `frontend:lib/query-keys/${factory.evidence}`,
    });

  const namespaces = registries.cacheNamespaces(join(BACKEND, "src/common/cache/cache-keys.ts"), join(BACKEND, "src"));
  for (const namespace of namespaces) {
    const reachedAt = reach([corpora[0], corpora[1]], namespace.item);
    rows.push({
      registry: "code.cache-namespace",
      item: namespace.item,
      owner: areaOfKey(namespace.item),
      verdict: namespace.item === "chat:unread" ? "REFACTOR" : "KEEP",
      failurePrevented:
        namespace.item === "chat:unread"
          ? "PRD-C061: bumped on every write and read by nothing (check:namespace-coverage prints it as a DEAD BUMP). Either the cached read it implies was never written, or the bump is pure write amplification."
          : "A namespace whose bump is the only thing that invalidates its cached reads; removing it serves stale rows after a write.",
      evidence: reachedAt ?? namespace.evidence,
    });
  }

  for (const variable of registries.environmentVariables(join(BACKEND, "src/config/env.validation.ts"), join(BACKEND, "src/db/pool.config.ts"))) {
    const reachedAt = reach([corpora[0], corpora[1]], variable.item);
    rows.push({
      registry: "code.environment-variable",
      item: variable.item,
      owner: "platform-config",
      verdict: reachedAt === null ? "REMOVE" : "KEEP",
      failurePrevented:
        reachedAt === null
          ? "Validated at boot and read by nothing. An operator sets it, the boot succeeds, and the setting has no effect — the most expensive kind of configuration."
          : "Validated at boot and read by live code; removing it turns a misconfiguration into a runtime failure far from the cause.",
      evidence: reachedAt ?? `src/config/${variable.evidence}`,
    });
  }

  for (const setting of registries.configuration(join(BACKEND, "src/modules"))) {
    const reachedAt = reach(corpora, setting.key);
    rows.push({
      registry: "code.configuration",
      item: setting.item,
      owner: setting.owner,
      verdict: reachedAt === null ? "REMOVE" : "KEEP",
      failurePrevented:
        reachedAt === null
          ? "The API accepts this settings key, validates it, stores it — and no code reads it. The tenant changes the setting, the request returns 200, and nothing about the system changes."
          : "A tenant-facing configuration key that is validated on the way in and read where it takes effect.",
      evidence: reachedAt ?? setting.evidence,
    });
  }

  for (const flag of registries.featureFlags(join(BACKEND, "src/modules/settings/settings.helpers.ts"))) {
    const reachedAt = reach(corpora, flag.key);
    rows.push({
      registry: "code.feature-flag",
      item: flag.item,
      owner: "settings",
      verdict: reachedAt === null ? "REMOVE" : "KEEP",
      failurePrevented:
        reachedAt === null
          ? "A per-organisation flag that is defaulted and parsed and then read by nothing: turning it off changes nothing, which is worse than not having the switch."
          : "A per-organisation flag read at the site that gates the feature.",
      evidence: reachedAt ?? flag.evidence,
    });
  }
  rows.push({
    registry: "code.feature-flag",
    item: "feature_flags (table-driven key space)",
    owner: "settings",
    verdict: "REFACTOR",
    failurePrevented:
      "The table declares four flag types — global, percentage, org, user — but PRD-C058's census finds zero reads of feature_flags.rollout_percentage and feature_flags.org_overrides anywhere outside src/db/schema. A flag saved as 10% rolls out to 100%, and a per-org override is written and never consulted. Either evaluate them or drop the two columns and the two types with them.",
    evidence: "src/db/schema/common/feature-flags.ts:19,21 + token census: 0 sightings",
  });

  const localeDirs = registries.translations(FRONTEND);
  rows.push({
    registry: "code.translation",
    item: localeDirs.length === 0 ? "(registry is empty)" : localeDirs.join(", "),
    owner: "frontend",
    verdict: "KEEP",
    failurePrevented:
      localeDirs.length === 0
        ? "There is no translation catalog: no messages/, locales/, i18n/ or public/locales/ directory exists under the frontend and no i18n runtime is imported. Recorded as an EMPTY registry with its evidence rather than omitted, because an absent registry and a broken extractor look identical in a report."
        : "Translation keys resolved at render time; a missing key renders as its own identifier in the UI.",
    evidence: `ls ${FRONTEND}: ${localeDirs.length === 0 ? "no locale directory" : localeDirs.join(", ")}`,
  });

  return rows;
}

main().catch((error) => {
  console.error(`build-key-inventory: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
