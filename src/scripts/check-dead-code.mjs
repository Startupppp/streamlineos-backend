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
 * Below this the scan is treated as broken rather than clean.
 *
 * `graphFiles: 500` was 7.5x below what the graph actually reaches, so a
 * collapse to a seventh of the repository would still have read as clean — the
 * exact false green PRD-C035 names ("a broken or under-scanning analyzer cannot
 * report a false green result"). The floors are now derived from head with
 * roughly 20% headroom for a legitimate deletion wave, and `graphCoverage` makes
 * the check RELATIVE as well as absolute: the importer map has to reach at least
 * half of the files `walkSource` actually handed it, so a walker that keeps
 * finding files while the parser stops recording edges fails too. A ratio alone
 * would not catch a broken walker (both numbers fall together), which is why
 * `sourceFiles` keeps its own absolute floor.
 *
 * Measured at head: 6,355 source files walked, 3,755 graph files, 29,731 edges,
 * 59.1% coverage.
 * These floors may be TIGHTENED as the numbers rise. Loosening one to make a run
 * pass is the defect this constant exists to catch.
 */
const SCAN_FLOOR = {
  knipTotal: 5,
  sourceFiles: 5000,
  graphFiles: 3000,
  graphEdges: 23000,
  graphCoverage: 0.5,
};

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
  ".claude",
]);

/**
 * A path segment the module graph must not walk.
 *
 * `.claude` is named above and the dot rule below generalises it, because the
 * failure it fixes was not hypothetical: agent worktrees live at
 * `.claude/worktrees/<name>/` and are full checkouts of this repository. Walking
 * them put 8,608 foreign `.ts` files into the importer map — 57.7% of the graph
 * — and every one of them counted as a live importer. The gate printed the
 * consequence out loud: the inferred meeting-prep input type in
 * `src/modules/ai/core/dto/request.schemas.ts` was RETAINED-BY-CONTRACT on the
 * grounds that its schema is "parsed at a live boundary in
 * .claude/worktrees/bold-napier-7a4a41/src/modules/ai/core/controllers/crm-ai.controller.ts`
 * — a path that does not exist in CI, on another machine, or after that worktree
 * is removed. A RETAIN verdict justified by a file CI cannot see is a false
 * negative: the symbol survives the gate locally and is dead everywhere else.
 *
 * The rule is "no dot-directory", not "not `.claude`", because the next agent
 * harness will pick a different dot-name and the contamination would return
 * silently. Nothing under a dot-directory is authored product source; every
 * previously-listed dot entry (`.git`, `.scratch`, `.scan`) is subsumed by it.
 *
 * Do NOT name a real schema constant in prose anywhere in this file:
 * `buildSymbolIndex` is a text scan over every walked file, this file included,
 * so a mention in a comment is itself enough to rescue a symbol. Writing the
 * identifier here re-created the exact false RETAIN this block describes, with
 * the citation pointing at this script. See assertion (y).
 */
function isOutOfScopeDir(name) {
  return OUT_OF_SCOPE_SEGMENTS.has(name) || name.startsWith(".");
}

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
  // ---- src/modules/ai/core/services ----------------------------------------
  ["src/modules/ai/core/services/crm-brief-loaders.ts:loadLeadProfile", { verdict: "REMOVE", reason: "orphaned by `1cc7ded8` (\"stream the live meeting-prep surface and retire the dead CRM duplicate\"), which deleted its only production caller. The single remaining reference is a key in the `jest.mock(\"./crm-brief-loaders\")` factory in `crm-meeting-brief.isolation.spec.ts`, which is not an import. It reads `leads` through the party seam, so removal belongs to the CRM/leads lane that orphaned it — CRM is excluded from this release's dead-code scope" }],

  // ---- src/modules/ai/core/dto ---------------------------------------------
  // Surfaced by fixing the module graph, not by new code: this finding was
  // previously RETAINED-BY-CONTRACT on the strength of a controller inside
  // `.claude/worktrees/bold-napier-7a4a41/`, another agent's checkout. With
  // dot-directories out of the graph the real reference count is visible.

  // ---- src/modules/calendar/dto --------------------------------------------
  // Only classifiable at all since the duplicate-group key was fixed; it used to
  // be reported as `[object Object],[object Object]`.
  ["src/modules/calendar/dto/calendar-response.schemas.ts:calendarMutatedEventSchema|calendarUpdateEventResponseSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first (`export const calendarUpdateEventResponseSchema = calendarMutatedEventSchema;`), and knip reports it because two exported names bind one value. Both names are live and neither is redundant: `calendarUpdateEventResponseSchema` is what `calendar.controller.ts:156` declares as the `@ResponseSchema` of the update route and what `calendar-mutate-projection.spec.ts:245` asserts against, while the shared name states that create and update project the SAME row shape. Collapsing them to one name would make a future divergence of the two routes invisible at the call site; deleting the alias would move a per-route wire contract into a shared constant. Kept as a named contract, not as debt" }],

  // ---- src/modules/activities/dto -----------------------------------------
  ["src/modules/activities/dto/activities-response.schemas.ts:timelinePageSchema|myTasksPageSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first, and knip reports it because two exported names bind one value. Both names are live: `timelinePageSchema` is used at `activities.controller.ts:59` and `hr-employee-subroutes.controller.ts:25`, while `myTasksPageSchema` is used at `activities.controller.ts:69`. The alias documents that the two routes share the same row shape. Collapsing to one name would make a future per-route divergence invisible at the call site" }],

  // ---- src/modules/ai/core/dto/ai-feedback-summaries-response.schemas.ts ---
  ["src/modules/ai/core/dto/ai-feedback-summaries-response.schemas.ts:aiSummarySnapshotSchema|aiSummariesSaveSnapshotResponseSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first, reported because two exported names bind one value. `aiSummariesSaveSnapshotResponseSchema` is the route contract consumed by `ai-summaries.controller.ts:55` via `@ResponseSchema`; the canonical name is the shared row shape. Collapsing them would make a future divergence between the snapshot read and the save-snapshot write invisible at the call site" }],

  // ---- src/modules/e-sign/dto ----------------------------------------------
  ["src/modules/e-sign/dto/e-sign-envelopes-response.schemas.ts:signEnvelopeRowSchema|envelopeMutationResponseSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first, reported because two exported names bind one value. `envelopeMutationResponseSchema` is consumed at `sign-envelopes.controller.ts:57/:91/:104/:123/:132/:146/:179` via `@ResponseSchema`; the canonical name documents the base row shape used internally by `listEnvelopesResponseSchema` and `getEnvelopeFullResponseSchema`. Collapsing them would silently merge what are conceptually separate contracts" }],
  ["src/modules/e-sign/dto/e-sign-fields-response.schemas.ts:signFieldRowSchema|fieldMutationResponseSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first, reported because two exported names bind one value. `fieldMutationResponseSchema` is consumed at `sign-fields.controller.ts:37/:59` via `@ResponseSchema`; the canonical name documents the base row shape used internally by `listFieldsResponseSchema` and imported by `e-sign-public-response.schemas.ts`. Collapsing them would merge two conceptually separate contracts" }],
  ["src/modules/e-sign/dto/e-sign-templates-response.schemas.ts:signTemplateRowSchema|templateMutationResponseSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first, reported because two exported names bind one value. `templateMutationResponseSchema` is consumed at `sign-templates.controller.ts:45/:54/:73/:81/:94` via `@ResponseSchema`; the canonical name documents the row shape used internally and imported by `e-sign-public-response.schemas.ts`. Collapsing them would merge two conceptually separate contracts" }],
  ["src/modules/e-sign/dto/e-sign-templates-response.schemas.ts:signPublicFormRowSchema|publishPublicFormResponseSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first, reported because two exported names bind one value. `publishPublicFormResponseSchema` is consumed at `sign-templates.controller.ts:115` via `@ResponseSchema`; the canonical name documents the base public-form row shape. Collapsing them would make a future divergence between the stored form row and the publish-action response invisible" }],

  // ---- src/modules/leads/dto -----------------------------------------------
  ["src/modules/leads/dto/leads-response.schemas.ts:leadPartySchema|leadMutatedSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first, reported because two exported names bind one value. `leadMutatedSchema` is consumed at `leads.controller.ts:76/:129`, `leads-detail.controller.ts:136/:157/:172/:187/:200`, and `leads.ingest.controller.ts` via `@ResponseSchema`; the canonical name documents the base party shape used internally across multiple response schemas. Collapsing them would merge the party data model with the mutation response contract" }],

  // ---- src/modules/settings/dto -------------------------------------------
  ["src/modules/settings/dto/settings-response.schemas.ts:automationRuleSchema|automationResponseSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first, reported because two exported names bind one value. `automationResponseSchema` is consumed at `settings.controller.ts:122/:135/:146` via `@ResponseSchema`; the canonical name documents the base rule row shape used internally. Collapsing them would merge the data model with the mutation response contract" }],

  // ---- src/modules/support/kb-gap/dto -------------------------------------
  ["src/modules/support/kb-gap/dto/support-kb-gap-response.schemas.ts:supportKnowledgeGapRowSchema|dismissGapResponseSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first, reported because two exported names bind one value. `dismissGapResponseSchema` is consumed at `support-kb-gap.controller.ts:97` via `@ResponseSchema`; the canonical name is the base row shape used internally. Collapsing them would merge the row model with the dismiss-action contract. (Line shifted 2026-09-11 when C7 moved this controller's inline `patchSchema` request guard to `dto/support-kb-gap.schemas.ts` as `dismissGapPatchSchema`.)" }],

  // ---- src/modules/dashboard/dto ------------------------------------------
  ["src/modules/dashboard/dto/dashboard-misc-response.schemas.ts:teamAvailabilitySchema|teamAttendanceSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first at dashboard-misc-response.schemas.ts:83, reported because two exported names bind one value. Both names are live: `teamAttendanceSchema` is consumed at `dashboard.controller.ts:219` and `teamAvailabilitySchema` at `dashboard.controller.ts:228`, each via `@ResponseSchema`. The two routes carry distinct semantic contracts (attendance vs availability) and may legitimately diverge; collapsing them would make that divergence invisible at the call site. (Line numbers shifted 2026-09-11 when C7 moved the HR/Build schemas that used to share this file — `leavesTodaySchema`/`myLeaveBalanceSchema` to `hr/time/dto/time-leave-response.schemas.ts`, `upcomingHolidaysSchema` to `hr/time/dto/time-attendance-response.schemas.ts`, `myIssuesSchema` to `build/core/dto/build-tickets-response.schemas.ts`, `activeSprintSchema` to `build/execution/dto/execution-response.schemas.ts`, `recentProjectsSchema` to `build/core/dto/build-core-response.schemas.ts` — out to their owning modules; this alias pair is dashboard-owned and stayed put)" }],

  // ---- src/modules/hr/** — HR DTO lane ----------------------------------------
  ["src/modules/hr/governance/dto/governance-response.schemas.ts:listPositionsResponseSchema|listVacantPositionsResponseSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first at governance-response.schemas.ts:196, reported because two exported names bind one value. Both are live: `listPositionsResponseSchema` is consumed at positions.controller.ts:53 and `listVacantPositionsResponseSchema` at positions.controller.ts:64, each via `@ResponseSchema`. Collapsing them would merge two route contracts that may legitimately diverge" }],
  ["src/modules/hr/benefits/dto/benefits-response.schemas.ts:benefitPlanSchema|getPlanResponseSchema|createPlanResponseSchema|updatePlanResponseSchema", { verdict: "KEEP", reason: "not a duplicate implementation — three aliases bind to the canonical row schema, and knip reports the group because all four exported names share one value. All three aliases are live: `getPlanResponseSchema` at hr-benefits.controller.ts:105, `createPlanResponseSchema` at :132, and `updatePlanResponseSchema` at :145, each via `@ResponseSchema`. The canonical name is used internally for `listPlansResponseSchema` and several compound schema extensions. Collapsing them would merge three separate route contracts and the shared row model into one name" }],

  // ---- src/modules/cron ----------------------------------------------------
  ["src/modules/cron/retention-schedule.ts:UNSCHEDULED_BILLING_JOBS", { verdict: "KEEP", reason: "a co-located catalog of billing jobs that CANNOT be placed on the retention scheduler yet, each with a written reason naming the specific defect that blocks it (missing payment leg for auto-topup-flush, RLS violation for ai-jobs-flush, double-counted revenue for provider-webhook-redrive). Keeping it beside RETENTION_JOBS and UNSCHEDULED_PURGE_JOBS makes the gap visible at the declaration site and prevents a future developer from scheduling one of these jobs without fixing the named defect first. No spec imports it because no spec can assert the jobs are absent from the scheduler without risking the test passing for the wrong reason." }],

  // ---- src/modules/hr/directory --------------------------------------------
  ["src/modules/hr/directory/employee-admission-status.ts:EmployeeAdmissionStatus", { verdict: "KEEP", reason: "the companion type alias for `EMPLOYEE_ADMISSION_STATUSES`, which IS imported by `directory-response.schemas.ts:4` and used at line 256 (`z.enum(EMPLOYEE_ADMISSION_STATUSES)`). The type is the public name for the union of the four status strings so that service methods and handlers that receive or return an admission status can declare their parameter type without re-deriving it through `(typeof EMPLOYEE_ADMISSION_STATUSES)[number]` at the call site." }],

  // ---- src/modules/notifications/dto ---------------------------------------
  ["src/modules/notifications/dto/unified-inbox.schemas.ts:InboxActor", { verdict: "KEEP", reason: "the named public type for the actor shape (id, name, image) embedded as `actor: inboxActorSchema.nullable()` in every unified inbox item variant. The source schema `inboxActorSchema` is composed internally into `inboxItemBaseFields` and never parsed by a separate file, so `inferredTypeOfLiveSchema` does not retain this alias automatically. Kept as the canonical name for code that formats or renders actor data from inbox items without re-inferring through the discriminated union." }],

  // ---- dependencies --------------------------------------------------------
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
    if (entry.isDirectory() && isOutOfScopeDir(entry.name)) continue;
    if (!entry.isDirectory() && OUT_OF_SCOPE_SEGMENTS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkSource(full);
    else if (/\.(ts|mts|mjs)$/.test(entry.name)) yield full;
  }
}

function buildImporterMap(root) {
  const map = new Map();
  let filesWalked = 0;

  const record = (target, importer, kind) => {
    if (!target) return;
    if (!map.has(target))
      map.set(target, { sideEffect: new Set(), named: new Set(), reexport: new Set(), dynamic: new Set() });
    map.get(target)[kind].add(importer);
  };

  for (const file of walkSource(root)) {
    filesWalked += 1;
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

  return { map, filesWalked };
}

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

function classifyFile(relPath, knipDeadSet, importerMap, root) {
  if (relPath.split("/").some((seg) => isOutOfScopeDir(seg)))
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
 *
 * `NOT_A_BOUNDARY_RE` is the second half of that condition. `buildSymbolIndex`
 * is a text scan, so ANY file naming the constant counts as a reference — and a
 * gate script under `src/scripts/` naming it in a comment is not a boundary that
 * parses anything. This is not hypothetical either: writing the constant's name
 * into a comment in THIS file made the gate report the type as "parsed at a live
 * boundary in src/scripts/check-dead-code.mjs". A retain has to point at code
 * that runs.
 */
const NOT_A_BOUNDARY_RE = /^(?:src\/)?scripts\//;
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
  const users = (sourceIndex.get(schema) ?? [])
    .map((p) => toFwd(relative(root, p)))
    .filter((rel) => rel !== file && !NOT_A_BOUNDARY_RE.test(rel));
  if (!users.length) return null;
  return `inferred type of \`${schema}\`, which is parsed at a live boundary in ${users[0]}`;
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

/**
 * Counted, not narrated -- the PASS line printed a hard-coded literal. See v2 ticket 30.
 */
let assertionsRun = 0;
function assert(cond, msg) {
  assertionsRun++;
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

    const { map: built, filesWalked: builtWalked } = buildImporterMap(fixture);
    const entryAbs = join(fixture, "entry.ts");
    assert(built.get(join(fixture, "a.ts"))?.named.has(entryAbs), "(n) named import edge not recorded");
    assert(built.get(join(fixture, "b.ts"))?.sideEffect.has(entryAbs), "(o) side-effect import edge not recorded");
    assert(built.get(join(fixture, "c.ts"))?.reexport.has(entryAbs), "(p) re-export edge not recorded");
    assert(built.get(join(fixture, "d.ts"))?.dynamic.has(entryAbs), "(q) dynamic import edge not recorded");
    let expectedWalked = 0;
    for (const _walked of walkSource(fixture)) expectedWalked += 1;
    assert(builtWalked === expectedWalked && expectedWalked >= 5,
      `(q2) the walker must report how many source files it handed the parser — got ${builtWalked}, walkSource yields ${expectedWalked}. SCAN_FLOOR.graphCoverage is measured against this number, so a counter that never moves turns the coverage floor into a no-op`);

    // ---- agent-worktree contamination ------------------------------------
    // Both halves of the graph read the same walker, so both are asserted. The
    // one-line `.claude` exclusion regresses silently without these: the gate
    // still exits 0, it just starts believing another agent's checkout.
    mkdirSync(join(fixture, "src"), { recursive: true });
    mkdirSync(join(fixture, ".claude", "worktrees", "agent-x", "src"), { recursive: true });
    writeFileSync(join(fixture, "src", "orphan.ts"), "export const Orphan = 1;\n");
    writeFileSync(join(fixture, ".claude", "worktrees", "agent-x", "src", "importer.ts"),
      'import { Orphan } from "../../../../src/orphan";\nconsole.log(Orphan, foreignOnlySchema);\n');

    const { map: contaminated, filesWalked: contaminatedWalked } = buildImporterMap(fixture);
    assert(!contaminated.has(join(fixture, "src", "orphan.ts")),
      "(u) an importer under .claude/worktrees must not appear in the module graph at all");
    assert(classifyFile("src/orphan.ts", new Set(["src/orphan.ts"]), contaminated, fixture).cls === "DEAD",
      "(v) a file whose ONLY importer is another agent's worktree must stay DEAD — that importer does not exist in CI");
    assert(classifyFile(".claude/worktrees/agent-x/src/importer.ts", new Set(), new Map(), fixture).cls === "OUT-OF-SCOPE",
      "(w) a path inside an agent worktree is out of scope, never authored product source");
    assert(contaminatedWalked === builtWalked + 1,
      `(w2) walkSource must count the in-scope file it added and NOT the one under .claude/worktrees — got ${contaminatedWalked}, expected ${builtWalked + 1}`);

    writeFileSync(join(fixture, "src", "foreign.schemas.ts"),
      "export const foreignOnlySchema = z.object({});\nexport type ForeignOnly = z.infer<typeof foreignOnlySchema>;\n");
    const foreignIdx = buildSymbolIndex(fixture, new Set(["foreignOnlySchema"]));
    const foreignVerdict = classifyFinding(
      "src/foreign.schemas.ts:ForeignOnly", "src/foreign.schemas.ts", new Map(), fixture, foreignIdx, "ForeignOnly");
    assert(foreignVerdict.cls === "UNCLASSIFIED",
      `(x) a schema parsed ONLY inside an agent worktree must not be RETAINED-BY-CONTRACT — this is exactly how the meeting-prep input type was rescued by .claude/worktrees/bold-napier-7a4a41; got ${foreignVerdict.cls}`);

    mkdirSync(join(fixture, "src", "scripts"), { recursive: true });
    writeFileSync(join(fixture, "src", "scripts", "some-gate.mjs"),
      "// prose mentioning scriptOnlySchema in a comment, which parses nothing\n");
    writeFileSync(join(fixture, "src", "script-only.schemas.ts"),
      "export const scriptOnlySchema = z.object({});\nexport type ScriptOnly = z.infer<typeof scriptOnlySchema>;\n");
    const scriptIdx = buildSymbolIndex(fixture, new Set(["scriptOnlySchema"]));
    const scriptVerdict = classifyFinding(
      "src/script-only.schemas.ts:ScriptOnly", "src/script-only.schemas.ts", new Map(), fixture, scriptIdx, "ScriptOnly");
    assert(scriptVerdict.cls === "UNCLASSIFIED",
      `(y) a schema named only inside a gate script is not "parsed at a live boundary" — a comment is not a caller; got ${scriptVerdict.cls}`);

    // Real knip shape, copied from `pnpm exec knip --reporter json` at head:
    // `duplicates` is an array of GROUPS, not an array of symbols.
    const dupNormalised = normalizeKnip([{
      file: "src/modules/calendar/dto/calendar-response.schemas.ts",
      duplicates: [[{ name: "alphaSchema", line: 159 }, { name: "betaSchema", line: 211 }]],
    }]);
    assert(dupNormalised.findings.length === 1,
      `(z) a duplicate group is one finding, got ${dupNormalised.findings.length}`);
    assert(dupNormalised.findings[0].name === "alphaSchema|betaSchema",
      `(aa) a duplicate group must be named by its members so the finding can be classified — an unnameable finding keeps the gate permanently red; got ${dupNormalised.findings[0].name}`);
    assert(!/\[object Object\]/.test(dupNormalised.findings[0].name),
      "(ab) no finding name may stringify an object");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }

  console.log(`PASS: self-test (${assertionsRun} assertions)\n`);
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
    "  (q2) walkSource reports its file count (SCAN_FLOOR.graphCoverage rests on it)",
    "  (r) schemaNamesFor finds the schema behind an inferred type",
    "  (s) inferred type of a schema parsed elsewhere    -> RETAINED-BY-CONTRACT",
    "  (t) inferred type of a schema nobody parses with  -> UNCLASSIFIED (gate bites)",
    "  (u) importer under .claude/worktrees             -> absent from the graph",
    "  (v) file whose only importer is a worktree       -> DEAD (not rescued)",
    "  (w) path inside an agent worktree                -> OUT-OF-SCOPE",
    "  (w2) a worktree file is not counted by the walker",
    "  (x) schema parsed only inside a worktree         -> UNCLASSIFIED (gate bites)",
    "  (y) schema named only in a gate script           -> UNCLASSIFIED (gate bites)",
    "  (z) duplicate group                              -> exactly one finding",
    "  (aa) duplicate finding named by its members       -> classifiable key",
    "  (ab) no finding name stringifies an object",
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

/**
 * knip's JSON document -> the flat `{kind, file, name}` findings this gate
 * classifies.
 *
 * `duplicates` is the shape that has to be handled deliberately. Every other
 * category is an array of `{name, line, col}`; `duplicates` is an array of
 * GROUPS, each group an array of those objects, because a duplicate is a
 * relationship between two or more exports rather than a single symbol. Reading
 * it like the others produced `item.name === undefined`, fell through to
 * `String(item)` on an array of objects, and named the finding
 * `[object Object],[object Object]`.
 *
 * That is not cosmetic. A finding's key is `<file>:<name>` and the key is what a
 * `FINDING_VERDICTS` entry is written against, so a finding named
 * `[object Object],[object Object]` can never be classified by anyone reading
 * the output: it does not say which two exports are duplicated, and it collides
 * with every other duplicate group in the same file. The gate is then
 * permanently and unfixably red on that finding — the one failure mode a
 * fail-closed gate cannot afford, because "always red" and "red for a reason"
 * become indistinguishable and the whole gate gets ignored.
 *
 * Joining the group's member names gives a key that names the actual defect
 * (`a|b`), is stable across runs, and can be written into the ledger.
 */
export function normalizeKnip(issues) {
  const deadFiles = [];
  const findings = [];

  const nameOf = (item) => {
    if (Array.isArray(item)) return item.map((member) => nameOf(member)).join("|");
    if (item && typeof item === "object" && typeof item.name === "string") return item.name;
    return String(item);
  };

  for (const issue of issues) {
    for (const file of issue.files ?? []) deadFiles.push(nameOf(file));
    for (const item of issue.exports ?? []) findings.push({ kind: "export", file: issue.file, name: nameOf(item) });
    for (const item of issue.types ?? []) findings.push({ kind: "type", file: issue.file, name: nameOf(item) });
    for (const item of issue.enumMembers ?? []) findings.push({ kind: "enum-member", file: issue.file, name: nameOf(item) });
    for (const item of issue.namespaceMembers ?? []) findings.push({ kind: "namespace-member", file: issue.file, name: nameOf(item) });
    for (const group of issue.duplicates ?? []) findings.push({ kind: "duplicate", file: issue.file, name: nameOf(group) });
    for (const group of ["unlisted", "dependencies", "devDependencies", "optionalPeerDependencies", "unresolved", "binaries"])
      for (const item of issue[group] ?? [])
        findings.push({ kind: `dependency:${group}`, file: issue.file, name: nameOf(item), depKey: true });
  }

  return { deadFiles, findings };
}

function main() {
  const knip = runKnip();
  const { deadFiles, findings } = normalizeKnip(knip.issues ?? []);

  const knipTotal = deadFiles.length + findings.length;
  if (knipTotal < SCAN_FLOOR.knipTotal) {
    console.error(
      `FAIL: knip reported only ${deadFiles.length} unused file(s) and ${findings.length} other finding(s) — ` +
      `below the scan floor of ${SCAN_FLOOR.knipTotal}. A scan that suddenly finds nothing is far more likely ` +
      `to be broken than the codebase is to be clean. Verify the knip config resolves the project before believing it.`,
    );
    process.exit(1);
  }

  const { map: importerMap, filesWalked } = buildImporterMap(ROOT);
  const graphFiles = importerMap.size;
  let graphEdges = 0;
  for (const entry of importerMap.values())
    graphEdges += entry.sideEffect.size + entry.named.size + entry.reexport.size + entry.dynamic.size;

  const coverage = filesWalked === 0 ? 0 : graphFiles / filesWalked;
  if (
    filesWalked < SCAN_FLOOR.sourceFiles ||
    graphFiles < SCAN_FLOOR.graphFiles ||
    graphEdges < SCAN_FLOOR.graphEdges ||
    coverage < SCAN_FLOOR.graphCoverage
  ) {
    console.error(
      `FAIL: the importer map walked ${filesWalked} source file(s) and found ${graphFiles} file(s) ` +
      `(${(coverage * 100).toFixed(1)}% coverage) and ${graphEdges} edge(s), below the floor of ` +
      `${SCAN_FLOOR.sourceFiles} walked / ${SCAN_FLOOR.graphFiles} files / ${SCAN_FLOOR.graphEdges} edges / ` +
      `${(SCAN_FLOOR.graphCoverage * 100).toFixed(0)}% coverage. The graph is broken, not the codebase clean.`,
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
    `| importer graph: ${graphFiles} files, ${graphEdges} edges over ${filesWalked} source files walked (${(coverage * 100).toFixed(1)}% coverage) ===`,
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
