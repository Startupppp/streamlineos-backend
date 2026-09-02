#!/usr/bin/env node
/**
 * Fail-closed dead-code gate for the API.
 *
 * The frontend has had `check:dead-code` for a while; this repository had
 * nothing. `knip` was configured and could be run by hand, but nothing read its
 * output, so a dead export could be added and nothing objected. This is the
 * missing half.
 *
 * The contract, in one line: **every finding knip reports must be classified,
 * and an unclassified finding fails the build.** A verdict is a line of prose
 * naming why the symbol stands or who is going to remove it — not a suppression.
 *
 * Three properties make it worth having rather than a `knip || true`:
 *
 *  1. **Fail-closed.** A finding with no `FINDING_VERDICTS` entry is
 *     UNCLASSIFIED and exits 1. Adding a dead export is a build break, not a
 *     line in a report nobody reads.
 *  2. **Zero-growth.** A verdict whose finding knip no longer reports is STALE
 *     and also exits 1, so the ledger shrinks in lockstep with the debt instead
 *     of accumulating into a graveyard of stale excuses.
 *  3. **Broken-scan detection.** A scan that suddenly reports nothing is far
 *     more likely to be broken than to be a clean codebase — that has happened
 *     in this repository before, when a `pgTable(` pattern missed the capital T
 *     and reported every table unreferenced. Below `SCAN_FLOOR` the gate fails
 *     as a broken scan rather than passing as a clean one.
 *
 * Deletion is proven by knip's module graph, never by text search: knip follows
 * side-effect imports (`import "./x";`), dynamic `import()` and re-export
 * chains, all of which an import search misses. Confirm anything you delete on
 * the strength of this gate with a real `pnpm build` — `tsc --noEmit` does not
 * notice a missing side-effect import.
 *
 * **knip alone never justifies deleting a schema file.**
 * `src/db/schema/hrms-phase1-sql-managed.ts` is a deliberate holding barrel for
 * tables managed by raw SQL, asserted by `migration-integrity.spec.ts`; being
 * unimported IS the design. `classifyFile` refuses to call anything under
 * `src/db/schema/` dead for that reason, and it is a knip entry point besides.
 *
 * Flags:
 *   --self-test   Run the classifiers against synthetic fixtures and exit.
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Below this the scan is treated as broken rather than clean. Today's head
 * reports 35; a run that finds fewer than five findings across every category
 * has almost certainly lost its module graph.
 */
const SCAN_FLOOR = { knipTotal: 5, graphFiles: 500, graphEdges: 2000 };

/** Excluded from the PRD's dead-code scope. Reported separately, never deleted here. */
const EXCLUDED_MODULE_RE = /^src\/modules\/(crm|inventory)\//;

/** Nest and tooling conventions that are entry points, not modules with importers. */
const CONVENTION_FILE_RE =
  /(?:^src\/main\.ts$|\.module\.ts$|\.controller\.ts$|\.spec\.ts$|\.e2e-spec\.ts$|^drizzle\.config\.ts$|^eslint\.config\.mjs$|^jest\.config)/;

/** Standalone executables invoked by a package script or by hand, not imported. */
const EXECUTABLE_RE = /^(?:src\/)?scripts\//;

/**
 * Schema is never called dead on knip's word alone — see the header. A file
 * here is classified by contract and must be argued about with `pg_catalog`
 * and a path grep, not with a module graph.
 */
const SCHEMA_RE = /^src\/db\/(?:schema|seeds)\//;

/** Generated, vendored or scratch paths — knip's verdict on them says nothing about this codebase. */
const OUT_OF_SCOPE_SEGMENTS = new Set([
  "node_modules", "dist", "coverage", ".git", "migrations", ".scratch", ".scan", "graphify-out",
]);

/**
 * The classification ledger.
 *
 * Key is `<file>:<name>` for an export or type, `dep:<name>` for a dependency
 * finding. Verdicts:
 *
 *   KEEP    — the symbol stands; the reason says why being unimported is correct.
 *   WIRE    — the symbol should have a consumer; the reason names the consumer to write.
 *   REMOVE  — confirmed dead, but the file belongs to another workstream right
 *             now. The reason names the territory. These are debt, and the
 *             stale-verdict check deletes the entry the moment they go.
 */
const FINDING_VERDICTS = new Map([
  // ---- src/common/observability/index.ts — module barrel -------------------
  ["src/common/observability/index.ts:correlationIdToPersist", { verdict: "REMOVE", reason: "barrel re-export with no consumer; a barrel export does not make a symbol used. Owned by the module-barrel workstream" }],
  ["src/common/observability/index.ts:AsyncHop", { verdict: "REMOVE", reason: "barrel re-export type with no consumer. Owned by the module-barrel workstream" }],

  // ---- src/common/tenant — module barrel + its source ----------------------
  ["src/common/tenant/index.ts:getTenantAbortSignal", { verdict: "REMOVE", reason: "barrel re-export whose only reference is the barrel itself. Owned by the module-barrel workstream" }],
  ["src/common/tenant/index.ts:hasSweepFailureSink", { verdict: "REMOVE", reason: "barrel re-export with no consumer. Owned by the module-barrel workstream" }],
  ["src/common/tenant/index.ts:ForEachOrgResult", { verdict: "REMOVE", reason: "barrel re-export type with no consumer. Owned by the module-barrel workstream" }],
  ["src/common/tenant/index.ts:SweepFailureSink", { verdict: "REMOVE", reason: "barrel re-export type with no consumer. Owned by the module-barrel workstream" }],
  ["src/common/tenant/tenant-context.ts:getTenantAbortSignal", { verdict: "REMOVE", reason: "the source of the barrel re-export above; both go together or the barrel breaks. Owned by the module-barrel workstream" }],

  // ---- src/db/query-telemetry.ts ------------------------------------------
  ["src/db/query-telemetry.ts:FINGERPRINT_CAP", { verdict: "REMOVE", reason: "constant with no reader outside its own module. Owned by the query-instrumentation workstream, which has this file open" }],
  ["src/db/query-telemetry.ts:SLOW_QUERY_MS", { verdict: "REMOVE", reason: "constant with no reader outside its own module. Owned by the query-instrumentation workstream, which has this file open" }],

  // ---- src/modules/ai/core/streaming/index.ts — module barrel --------------
  ["src/modules/ai/core/streaming/index.ts:getAiRequestAbortSignal", { verdict: "REMOVE", reason: "barrel re-export with no consumer. Owned by the module-barrel workstream" }],
  ["src/modules/ai/core/streaming/index.ts:runWithAiRequestAbort", { verdict: "REMOVE", reason: "barrel re-export with no consumer. Owned by the module-barrel workstream" }],
  ["src/modules/ai/core/streaming/index.ts:AI_REQUEST_DEADLINE_MS", { verdict: "REMOVE", reason: "barrel re-export with no consumer. Owned by the module-barrel workstream" }],
  ["src/modules/ai/core/streaming/index.ts:AiStreamBreaker", { verdict: "REMOVE", reason: "barrel re-export with no consumer. Owned by the module-barrel workstream" }],
  ["src/modules/ai/core/streaming/index.ts:AI_STREAM_BREAKER_FAILURE_THRESHOLD", { verdict: "REMOVE", reason: "barrel re-export with no consumer. Owned by the module-barrel workstream" }],
  ["src/modules/ai/core/streaming/index.ts:AI_STREAM_BREAKER_OPEN_DURATION_MS", { verdict: "REMOVE", reason: "barrel re-export with no consumer. Owned by the module-barrel workstream" }],
  ["src/modules/ai/core/streaming/index.ts:AI_TEXT_STREAM_DEADLINE_MS", { verdict: "REMOVE", reason: "barrel re-export with no consumer. Owned by the module-barrel workstream" }],
  ["src/modules/ai/core/streaming/index.ts:CloseableRequest", { verdict: "REMOVE", reason: "barrel re-export type with no consumer. Owned by the module-barrel workstream" }],
  ["src/modules/ai/core/streaming/index.ts:EndableResponse", { verdict: "REMOVE", reason: "barrel re-export type with no consumer. Owned by the module-barrel workstream" }],
  ["src/modules/ai/core/streaming/index.ts:StreamAbortHandle", { verdict: "REMOVE", reason: "barrel re-export type with no consumer. Owned by the module-barrel workstream" }],
  ["src/modules/ai/core/streaming/index.ts:StreamAbortReason", { verdict: "REMOVE", reason: "barrel re-export type with no consumer. Owned by the module-barrel workstream" }],
  ["src/modules/ai/core/streaming/index.ts:AiStreamBreakerOptions", { verdict: "REMOVE", reason: "barrel re-export type with no consumer. Owned by the module-barrel workstream" }],
  ["src/modules/ai/core/streaming/index.ts:AiStreamBreakerRedis", { verdict: "REMOVE", reason: "barrel re-export type with no consumer. Owned by the module-barrel workstream" }],
  ["src/modules/ai/core/streaming/index.ts:AiStreamPipeOptions", { verdict: "REMOVE", reason: "barrel re-export type with no consumer. Owned by the module-barrel workstream" }],
  ["src/modules/ai/core/streaming/index.ts:PipeableAiTextStream", { verdict: "REMOVE", reason: "barrel re-export type with no consumer. Owned by the module-barrel workstream" }],
  ["src/modules/ai/core/streaming/index.ts:AiTextStreamRouteOptions", { verdict: "REMOVE", reason: "barrel re-export type with no consumer. Owned by the module-barrel workstream" }],

  // ---- src/modules/gdpr ----------------------------------------------------
  ["src/modules/gdpr/gdpr-export-adapters.ts:GDPR_EXPORT_SOURCE_ADAPTERS", { verdict: "REMOVE", reason: "the source of a three-hop re-export chain (adapters -> worker-implementation -> worker.service) with no consumer at the end. Owned by the GDPR erasure workstream, which has this module open" }],
  ["src/modules/gdpr/gdpr-export-worker-implementation.ts:GDPR_EXPORT_SOURCE_ADAPTERS", { verdict: "REMOVE", reason: "second hop of the same dead chain. Owned by the GDPR erasure workstream" }],
  ["src/modules/gdpr/gdpr-export-worker-implementation.ts:SUBJECT_SCOPED_GDPR_EXPORT_SOURCES", { verdict: "REMOVE", reason: "re-export with no consumer at the end of the chain. Owned by the GDPR erasure workstream" }],
  ["src/modules/gdpr/gdpr-export-worker.service.ts:GDPR_EXPORT_SOURCE_ADAPTERS", { verdict: "REMOVE", reason: "third hop of the same dead chain. Owned by the GDPR erasure workstream" }],
  ["src/modules/gdpr/gdpr-export-worker.service.ts:SUBJECT_SCOPED_GDPR_EXPORT_SOURCES", { verdict: "REMOVE", reason: "third hop of the same dead chain. Owned by the GDPR erasure workstream" }],
  ["src/modules/gdpr/dto/gdpr-export-outbox.schemas.ts:GdprExportRequestedPayload", { verdict: "WIRE", reason: "the payload contract for the live `gdpr.export.requested` outbox event. Nothing validates the payload on the consuming side today, which is the defect — the relay handler should parse with `gdprExportRequestedPayloadSchema` and take its argument type from here. Deleting it would remove a boundary contract rather than dead code" }],

  // ---- src/modules/notifications ------------------------------------------
  ["src/modules/notifications/dto/provider-result.schemas.ts:ProviderValidationResultParsed", { verdict: "REMOVE", reason: "inferred type with no consumer. Owned by the notifications workstream, which has this module open" }],
  ["src/modules/notifications/notifications.service.ts:NotificationCategoryValue", { verdict: "REMOVE", reason: "re-exported type with no consumer. Owned by the notifications workstream" }],

  // ---- dependencies --------------------------------------------------------
  ["dep:express", { verdict: "WIRE", reason: "`src/health/shutdown-drain.spec.ts` imports express, and pnpm's strict layout does not link an undeclared package at the repo root — `require.resolve(\"express\")` fails from here. It needs a devDependencies entry with the lockfile updated in the same change" }],
  ["dep:@jitl/quickjs-wasmfile-release-sync", { verdict: "KEEP", reason: "not a direct dependency by design. `script.executor.ts` resolves it with `require.resolve(spec, { paths: [dirname(require.resolve(\"quickjs-emscripten\"))] })`, i.e. from the declared dependency's own directory, to get a CJS build of the WASM module that Jest can load. Verified resolvable; knip reports it because it does not model the `paths` option" }],
]);

// ---------------------------------------------------------------------------
// Module-graph helpers — the importer map exists so that a file knip calls
// unused can still be RETAINED when a live file reaches it by a side-effect
// import, a dynamic import or a re-export. Those three are exactly the edges an
// import search misses.
// ---------------------------------------------------------------------------

function toFwd(p) {
  return p.replace(/\\/g, "/");
}

function tryFile(p) {
  try {
    return statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

function findFile(spec, fromDir, root) {
  let base;
  if (spec.startsWith(".")) base = resolvePath(fromDir, spec);
  else if (spec.startsWith("src/")) base = join(root, spec);
  else return null;

  if (tryFile(base)) return base;
  for (const ext of [".ts", ".mts", ".mjs"]) {
    const hit = tryFile(base + ext);
    if (hit) return hit;
  }
  for (const idx of ["index.ts", "index.mts"]) {
    const hit = tryFile(join(base, idx));
    if (hit) return hit;
  }
  return null;
}

function* walkSource(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (OUT_OF_SCOPE_SEGMENTS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkSource(full);
    else if (/\.(ts|mts|mjs)$/.test(entry.name)) yield full;
  }
}

function buildImporterMap(root) {
  const map = new Map();

  const record = (target, importer, kind) => {
    if (!target) return;
    if (!map.has(target))
      map.set(target, { sideEffect: new Set(), named: new Set(), reexport: new Set(), dynamic: new Set() });
    map.get(target)[kind].add(importer);
  };

  for (const file of walkSource(root)) {
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const fromDir = dirname(file);

    for (const line of src.split("\n")) {
      const m = line.match(/^\s*import\s+["']([^"']+)["']\s*;?\s*$/);
      if (m) record(findFile(m[1], fromDir, root), file, "sideEffect");
    }

    let m;
    const named = /^import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)[^"'\n]*from\s+["']([^"']+)["']/gm;
    while ((m = named.exec(src)) !== null) record(findFile(m[1], fromDir, root), file, "named");

    const reexport = /^export\s+(?:type\s+)?(?:\{[^}]*\}|\*[^"'\n]*)\s+from\s+["']([^"']+)["']/gm;
    while ((m = reexport.exec(src)) !== null) record(findFile(m[1], fromDir, root), file, "reexport");

    const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = dynamic.exec(src)) !== null) record(findFile(m[1], fromDir, root), file, "dynamic");
  }

  return map;
}

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

function classifyFile(relPath, knipDeadSet, importerMap, root) {
  if (relPath.split("/").some((seg) => OUT_OF_SCOPE_SEGMENTS.has(seg)))
    return { cls: "OUT-OF-SCOPE", reason: "generated, vendored or scratch path — not authored product source" };

  if (EXCLUDED_MODULE_RE.test(relPath))
    return { cls: "EXCLUDED", reason: "CRM/Inventory excluded from PRD scope; reported, never deleted here" };

  if (SCHEMA_RE.test(relPath))
    return {
      cls: "RETAINED-BY-CONTRACT",
      reason: "schema or seed file — knip alone never justifies deleting one (hrms-phase1-sql-managed.ts is unimported by design and spec-asserted); argue from pg_catalog and a path grep instead",
    };

  if (CONVENTION_FILE_RE.test(relPath))
    return { cls: "RETAINED-BY-CONVENTION", reason: "Nest or tooling entry-point convention, not a module with importers" };

  if (EXECUTABLE_RE.test(relPath))
    return { cls: "RETAINED-BY-CONVENTION", reason: "standalone executable script, not a module" };

  const entry = importerMap.get(join(root, ...relPath.split("/")));
  if (entry) {
    for (const [kind, importers] of Object.entries(entry)) {
      for (const importer of importers) {
        const importerRel = toFwd(relative(root, importer));
        if (knipDeadSet.has(importerRel)) continue;
        const reason =
          kind === "sideEffect" ? `side-effect import from live file (${importerRel})`
          : kind === "reexport" ? `re-exported from live barrel (${importerRel})`
          : kind === "dynamic" ? `dynamic import from live file (${importerRel})`
          : `named import from live file (${importerRel})`;
        return { cls: "RETAINED-BY-CONTRACT", reason };
      }
    }
  }

  return { cls: "DEAD", reason: "no live importers found in the module graph" };
}

/**
 * `export type T = z.infer<typeof schema>` beside a schema that something else
 * actually parses with.
 *
 * knip counts the type as unused because `safeParse` hands back an inferred
 * type and no consumer has to name it. But the alias is the public name of a
 * contract that IS enforced at a boundary, so deleting it removes the only way
 * a handler can state what it received. Retaining it is a rule rather than a
 * ledger entry so that every DTO written this way is treated the same and the
 * ledger does not fill up with one line per schema file.
 *
 * The condition is load-bearing in both directions: it retains only when the
 * schema constant is referenced from ANOTHER file. A schema nothing parses with
 * is a contract nobody enforces, and that stays a finding — which is exactly
 * how `gdpr-export-outbox.schemas.ts` is caught.
 */
function inferredTypeOfLiveSchema(file, name, root, sourceIndex) {
  if (!file || !/\.schemas?\.ts$/.test(file)) return null;
  let src;
  try {
    src = readFileSync(join(root, ...file.split("/")), "utf8");
  } catch {
    return null;
  }
  const declared = new RegExp(
    `export\\s+type\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*z\\.infer<\\s*typeof\\s+(\\w+)\\s*>`,
  ).exec(src);
  if (!declared) return null;
  const schema = declared[1];
  const users = (sourceIndex.get(schema) ?? []).filter((p) => toFwd(relative(root, p)) !== file);
  if (!users.length) return null;
  return `inferred type of \`${schema}\`, which is parsed at a live boundary in ${toFwd(relative(root, users[0]))}`;
}

function classifyFinding(key, file, verdicts = FINDING_VERDICTS, root = ROOT, sourceIndex = new Map(), name = null) {
  if (file && EXCLUDED_MODULE_RE.test(file))
    return { cls: "EXCLUDED", reason: "CRM/Inventory excluded from PRD scope; reported, never counted in the baseline" };
  if (verdicts.has(key)) {
    const { verdict, reason } = verdicts.get(key);
    return { cls: verdict, reason };
  }
  if (name) {
    const reason = inferredTypeOfLiveSchema(file, name, root, sourceIndex);
    if (reason) return { cls: "RETAINED-BY-CONTRACT", reason };
  }
  return { cls: "UNCLASSIFIED", reason: "no verdict in FINDING_VERDICTS — add a KEEP, WIRE or REMOVE entry, or delete the symbol" };
}

/**
 * identifier -> files mentioning it, for the handful of schema constants the
 * type findings actually name. Used only to RETAIN, never to justify a
 * deletion, so a text match is the safe direction here.
 */
function buildSymbolIndex(root, wanted) {
  const index = new Map();
  if (!wanted.size) return index;
  const pattern = new RegExp(`\\b(${[...wanted].join("|")})\\b`, "g");
  for (const file of walkSource(root)) {
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of src.matchAll(pattern)) {
      const seen = index.get(match[1]);
      if (seen) {
        if (seen[seen.length - 1] !== file) seen.push(file);
      } else index.set(match[1], [file]);
    }
  }
  return index;
}

/** The schema constants named by `export type X = z.infer<typeof S>` in the reported files. */
function schemaNamesFor(findings, root) {
  const wanted = new Set();
  for (const finding of findings) {
    if (finding.kind !== "type" || !finding.file || !/\.schemas?\.ts$/.test(finding.file)) continue;
    let src;
    try {
      src = readFileSync(join(root, ...finding.file.split("/")), "utf8");
    } catch {
      continue;
    }
    const declared = new RegExp(
      `export\\s+type\\s+${finding.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*z\\.infer<\\s*typeof\\s+(\\w+)\\s*>`,
    ).exec(src);
    if (declared) wanted.add(declared[1]);
  }
  return wanted;
}

function staleVerdicts(verdicts, seen) {
  return [...verdicts.keys()].filter((key) => !seen.has(key));
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function assert(cond, msg) {
  if (!cond) {
    console.error("SELF-TEST FAIL:", msg);
    process.exit(1);
  }
}

function runSelfTest() {
  console.log("Running self-test...\n");

  const root = "/synthetic";
  const dead = new Set(["src/dead.ts", "src/side-effect-dep.ts", "src/reexport-source.ts"]);
  const liveEntry = join(root, "src", "live-entry.ts");
  const liveBarrel = join(root, "src", "live-barrel.ts");
  const map = new Map([
    [join(root, "src", "side-effect-dep.ts"), { sideEffect: new Set([liveEntry]), named: new Set(), reexport: new Set(), dynamic: new Set() }],
    [join(root, "src", "reexport-source.ts"), { sideEffect: new Set(), named: new Set(), reexport: new Set([liveBarrel]), dynamic: new Set() }],
  ]);

  assert(classifyFile("src/dead.ts", dead, map, root).cls === "DEAD",
    "(a) a file with no live importers must be DEAD");
  assert(classifyFile("src/side-effect-dep.ts", dead, map, root).cls === "RETAINED-BY-CONTRACT",
    "(b) a file reached by a bare side-effect import must be RETAINED — this is the edge an import search misses");
  assert(classifyFile("src/reexport-source.ts", dead, map, root).cls === "RETAINED-BY-CONTRACT",
    "(c) a file reached through a live barrel's re-export must be RETAINED");
  assert(classifyFile("src/db/schema/hrms-phase1-sql-managed.ts", new Set(["src/db/schema/hrms-phase1-sql-managed.ts"]), new Map(), root).cls === "RETAINED-BY-CONTRACT",
    "(d) a schema file must never be called dead on knip's word alone");
  assert(classifyFile("src/modules/build/build.module.ts", new Set(["src/modules/build/build.module.ts"]), new Map(), root).cls === "RETAINED-BY-CONVENTION",
    "(e) a Nest module file is an entry point, not an unused module");
  assert(classifyFile("src/scripts/one-off.mjs", new Set(["src/scripts/one-off.mjs"]), new Map(), root).cls === "RETAINED-BY-CONVENTION",
    "(f) a standalone script is invoked, not imported");
  assert(classifyFile("src/modules/crm/dead-thing.ts", new Set(["src/modules/crm/dead-thing.ts"]), new Map(), root).cls === "EXCLUDED",
    "(g) an excluded module is reported separately, never silently deleted");
  assert(classifyFile("dist/main.js", new Set(["dist/main.js"]), new Map(), root).cls === "OUT-OF-SCOPE",
    "(h) a generated path is out of scope");

  assert(classifyFinding("src/modules/foo/new-thing.ts:useNewThing", "src/modules/foo/new-thing.ts").cls === "UNCLASSIFIED",
    "(i) a finding with no verdict must be UNCLASSIFIED so the gate bites");
  assert(classifyFinding("dep:@jitl/quickjs-wasmfile-release-sync", "src/modules/workflows/engine/executors/script.executor.ts").cls === "KEEP",
    "(j) a KEEP verdict must be honoured");
  assert(classifyFinding("src/modules/crm/anything.ts:Whatever", "src/modules/crm/anything.ts").cls === "EXCLUDED",
    "(k) a finding inside an excluded module is EXCLUDED, not UNCLASSIFIED");

  const ghost = new Map([["src/gone.ts:Ghost", { verdict: "REMOVE", reason: "test" }]]);
  const stale = staleVerdicts(ghost, new Set());
  assert(stale.length === 1 && stale[0] === "src/gone.ts:Ghost",
    "(l) a verdict knip no longer reports must be STALE so the ledger cannot grow into a graveyard");
  assert(staleVerdicts(ghost, new Set(["src/gone.ts:Ghost"])).length === 0,
    "(m) a verdict knip still reports is not stale");

  const fixture = join(tmpdir(), `api-dead-code-self-test-${Date.now()}`);
  try {
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, "live.schema.ts"),
      "export const liveSchema = z.object({});\nexport type Live = z.infer<typeof liveSchema>;\n");
    writeFileSync(join(fixture, "orphan.schema.ts"),
      "export const orphanSchema = z.object({});\nexport type Orphan = z.infer<typeof orphanSchema>;\n");
    writeFileSync(join(fixture, "consumer.ts"), "liveSchema.safeParse(x);\n");

    const schemaFindings = [
      { kind: "type", file: "live.schema.ts", name: "Live" },
      { kind: "type", file: "orphan.schema.ts", name: "Orphan" },
    ];
    const wanted = schemaNamesFor(schemaFindings, fixture);
    assert(wanted.has("liveSchema") && wanted.has("orphanSchema"),
      `(r) schemaNamesFor must find both schema constants, got [${[...wanted].join(",")}]`);
    const idx = buildSymbolIndex(fixture, wanted);
    const live = classifyFinding("live.schema.ts:Live", "live.schema.ts", new Map(), fixture, idx, "Live");
    const orphan = classifyFinding("orphan.schema.ts:Orphan", "orphan.schema.ts", new Map(), fixture, idx, "Orphan");
    assert(live.cls === "RETAINED-BY-CONTRACT",
      `(s) the inferred type of a schema something else parses with must be RETAINED, got ${live.cls}`);
    assert(orphan.cls === "UNCLASSIFIED",
      `(t) the inferred type of a schema NOTHING parses with must stay a finding, got ${orphan.cls}`);

    writeFileSync(join(fixture, "entry.ts"), 'import x from "./a";\nimport "./b";\nexport * from "./c";\nconst y = await import("./d");\n');
    writeFileSync(join(fixture, "a.ts"), "export default 1;\n");
    writeFileSync(join(fixture, "b.ts"), "export {};\n");
    writeFileSync(join(fixture, "c.ts"), "export const C = 1;\n");
    writeFileSync(join(fixture, "d.ts"), "export const D = 1;\n");

    const built = buildImporterMap(fixture);
    const entryAbs = join(fixture, "entry.ts");
    assert(built.get(join(fixture, "a.ts"))?.named.has(entryAbs), "(n) named import edge not recorded");
    assert(built.get(join(fixture, "b.ts"))?.sideEffect.has(entryAbs), "(o) side-effect import edge not recorded");
    assert(built.get(join(fixture, "c.ts"))?.reexport.has(entryAbs), "(p) re-export edge not recorded");
    assert(built.get(join(fixture, "d.ts"))?.dynamic.has(entryAbs), "(q) dynamic import edge not recorded");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }

  console.log("PASS: self-test (20 assertions)\n");
  for (const line of [
    "  (a) file with no live importers                 -> DEAD",
    "  (b) file reached by a side-effect import         -> RETAINED-BY-CONTRACT",
    "  (c) file reached through a live barrel           -> RETAINED-BY-CONTRACT",
    "  (d) schema file                                  -> RETAINED-BY-CONTRACT (never deleted on knip alone)",
    "  (e) *.module.ts                                  -> RETAINED-BY-CONVENTION",
    "  (f) src/scripts/*                                -> RETAINED-BY-CONVENTION",
    "  (g) CRM/Inventory file                           -> EXCLUDED",
    "  (h) dist/ path                                   -> OUT-OF-SCOPE",
    "  (i) finding with no verdict                      -> UNCLASSIFIED (gate bites)",
    "  (j) finding with a KEEP verdict                  -> KEEP",
    "  (k) finding inside an excluded module            -> EXCLUDED",
    "  (l) verdict knip no longer reports               -> STALE (gate bites)",
    "  (m) verdict knip still reports                   -> not stale",
    "  (n) importer map: named import edge",
    "  (o) importer map: side-effect import edge",
    "  (p) importer map: re-export edge",
    "  (q) importer map: dynamic import edge",
    "  (r) schemaNamesFor finds the schema behind an inferred type",
    "  (s) inferred type of a schema parsed elsewhere    -> RETAINED-BY-CONTRACT",
    "  (t) inferred type of a schema nobody parses with  -> UNCLASSIFIED (gate bites)",
  ]) console.log(line);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function runKnip() {
  let raw;
  try {
    raw = execSync("pnpm exec knip --no-progress --reporter json", {
      cwd: ROOT, encoding: "utf8", maxBuffer: 40 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    raw = error.stdout;
    if (!raw) {
      console.error("knip run failed:", error.stderr ?? error.message);
      process.exit(1);
    }
  }
  // knip loads .env and prints a dotenv banner to stdout ahead of the document.
  // The banner rotates through several tips and some of them contain a literal
  // `{`, so slicing at the first brace lands inside the banner rather than on
  // the payload. Take the first line that begins a parseable document instead.
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("{")) continue;
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {
      /* keep looking — this brace opened the banner, not the report */
    }
  }
  console.error("knip produced no parseable JSON document:\n", raw.slice(0, 400));
  process.exit(1);
}

function main() {
  const knip = runKnip();
  const issues = knip.issues ?? [];

  const deadFiles = [];
  const findings = [];

  for (const issue of issues) {
    for (const file of issue.files ?? []) deadFiles.push(file.name ?? file);
    for (const item of issue.exports ?? []) findings.push({ kind: "export", file: issue.file, name: item.name });
    for (const item of issue.types ?? []) findings.push({ kind: "type", file: issue.file, name: item.name });
    for (const item of issue.enumMembers ?? []) findings.push({ kind: "enum-member", file: issue.file, name: item.name });
    for (const item of issue.namespaceMembers ?? []) findings.push({ kind: "namespace-member", file: issue.file, name: item.name });
    for (const item of issue.duplicates ?? []) findings.push({ kind: "duplicate", file: issue.file, name: item.name ?? String(item) });
    for (const group of ["unlisted", "dependencies", "devDependencies", "optionalPeerDependencies", "unresolved", "binaries"])
      for (const item of issue[group] ?? [])
        findings.push({ kind: `dependency:${group}`, file: issue.file, name: item.name ?? String(item), depKey: true });
  }

  const knipTotal = deadFiles.length + findings.length;
  if (knipTotal < SCAN_FLOOR.knipTotal) {
    console.error(
      `FAIL: knip reported only ${deadFiles.length} unused file(s) and ${findings.length} other finding(s) — ` +
      `below the scan floor of ${SCAN_FLOOR.knipTotal}. A scan that suddenly finds nothing is far more likely ` +
      `to be broken than the codebase is to be clean. Verify the knip config resolves the project before believing it.`,
    );
    process.exit(1);
  }

  const importerMap = buildImporterMap(ROOT);
  const graphFiles = importerMap.size;
  let graphEdges = 0;
  for (const entry of importerMap.values())
    graphEdges += entry.sideEffect.size + entry.named.size + entry.reexport.size + entry.dynamic.size;

  if (graphFiles < SCAN_FLOOR.graphFiles || graphEdges < SCAN_FLOOR.graphEdges) {
    console.error(
      `FAIL: the importer map found ${graphFiles} file(s) and ${graphEdges} edge(s), below the floor of ` +
      `${SCAN_FLOOR.graphFiles}/${SCAN_FLOOR.graphEdges}. The graph is broken, not the codebase clean.`,
    );
    process.exit(1);
  }

  const knipDeadSet = new Set(deadFiles);
  const buckets = new Map();
  const push = (cls, line) => {
    if (!buckets.has(cls)) buckets.set(cls, []);
    buckets.get(cls).push(line);
  };

  for (const relPath of deadFiles) {
    const { cls, reason } = classifyFile(toFwd(relPath), knipDeadSet, importerMap, ROOT);
    push(cls, `  [file] ${relPath}  — ${reason}`);
  }

  const sourceIndex = buildSymbolIndex(ROOT, schemaNamesFor(findings, ROOT));

  const seenKeys = new Set();
  const unclassified = [];
  for (const finding of findings) {
    const key = finding.depKey ? `dep:${finding.name}` : `${toFwd(finding.file)}:${finding.name}`;
    seenKeys.add(key);
    const { cls, reason } = classifyFinding(key, finding.file, FINDING_VERDICTS, ROOT, sourceIndex, finding.name);
    push(cls, `  [${finding.kind}] ${key}  — ${reason}`);
    if (cls === "UNCLASSIFIED") unclassified.push(key);
  }

  const order = ["RETAINED-BY-CONTRACT", "RETAINED-BY-CONVENTION", "KEEP", "WIRE", "REMOVE", "EXCLUDED", "OUT-OF-SCOPE", "DEAD", "UNCLASSIFIED"];
  for (const cls of order) {
    const lines = buckets.get(cls);
    if (!lines?.length) continue;
    console.log(`\n${cls} (${lines.length}):`);
    for (const line of lines) console.log(line);
  }

  const stale = staleVerdicts(FINDING_VERDICTS, seenKeys);
  const dead = buckets.get("DEAD") ?? [];

  console.log(
    `\n=== knip: ${deadFiles.length} unused file(s), ${findings.length} other finding(s) ` +
    `| importer graph: ${graphFiles} files, ${graphEdges} edges ===`,
  );
  console.log(
    `=== ledger: ${FINDING_VERDICTS.size} verdict(s) — ` +
    `${(buckets.get("KEEP") ?? []).length} KEEP, ${(buckets.get("WIRE") ?? []).length} WIRE, ` +
    `${(buckets.get("REMOVE") ?? []).length} REMOVE (debt) ===`,
  );

  let failed = false;

  if (dead.length) {
    console.error(`\nFAIL: ${dead.length} file(s) have no live importer. Delete them, or explain why they stand:`);
    for (const line of dead) console.error(line);
    failed = true;
  }

  if (unclassified.length) {
    console.error(`\nFAIL: ${unclassified.length} unclassified finding(s) — add a KEEP, WIRE or REMOVE entry to FINDING_VERDICTS, or delete the symbol:`);
    for (const key of unclassified) console.error(`  ${key}`);
    failed = true;
  }

  if (stale.length) {
    console.error(`\nFAIL: ${stale.length} stale verdict(s) — knip no longer reports these, so remove the entry (the ledger only shrinks):`);
    for (const key of stale) console.error(`  ${key}`);
    failed = true;
  }

  if (failed) process.exit(1);
  console.log("\nPASS: every dead-code finding is classified and no verdict is stale.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else main();
