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
 * ## Entry points are roots, and the root set is DERIVED, never written here
 *
 * The walker reads "no importer" as "dead". That is right for a library module
 * and wrong for a runner entry point: a jest test file is never imported by
 * anything — being unimported is what makes it a test. Until this was modelled,
 * 165 `*.seeded-e2e-spec.ts` files and the 31 helpers, fixtures and setup files
 * only they reach were reported dead, 196 of the 197 failing file findings.
 *
 * The cause was a hard-coded suffix list. `CONVENTION_FILE_RE` used to carry
 * `\.spec\.ts$` and `\.e2e-spec\.ts$`, and a fourth naming convention walked
 * straight past both: `foo.seeded-e2e-spec.ts` ends in `-spec.ts`, not
 * `.spec.ts`, so neither alternative fires. That is the whole failure mode of a
 * hand-written glob — it is a snapshot of the conventions that existed the day
 * it was written, it rots silently, and the gate keeps exiting 0 on the parts it
 * still covers so nobody looks. Both suffixes are gone from that regex now.
 *
 * In their place `discoverEntryPoints` reads the roots out of configuration:
 *
 *   - **jest configs.** Every `jest*.{json,js,cjs,mjs,ts}` in the repository
 *     root, plus every `--config <path>` named by a `package.json` script, plus
 *     the `package.json` `jest` key. Today that is `jest-e2e.json`,
 *     `jest-e2e-seeded.json`, `jest-db.json` and `package.json#jest`; a fifth
 *     project is picked up the day it lands, with no edit here. From each, the
 *     model honours `roots`, `testMatch`, `testRegex` and
 *     `testPathIgnorePatterns` together — a file jest would skip is NOT a root —
 *     and takes the hook files (`setupFiles`, `setupFilesAfterEnv`,
 *     `globalSetup`, `globalTeardown`, `testResultsProcessor`, `testRunner`,
 *     `testSequencer`, `resolver`, `snapshotResolver`, `runner`, `reporters`,
 *     `watchPlugins`) and any file-valued `moduleNameMapper` target. Deriving is
 *     what catches `src/test/jest-db-setup.ts` and
 *     `test/helpers/arm-mail-egress.setup.ts` for the right reason: they are
 *     roots because a config names them in `setupFiles`, not because somebody
 *     guessed a `*.setup.ts` glob.
 *
 *   - **`package.json` scripts.** If a script runs a file, that script IS the
 *     file's entry point, so every script token that resolves to a real file in
 *     this repository is a root. This was chosen over a `test/perf` carve-out
 *     deliberately, and it is the strictly more honest of the two: the carve-out
 *     would have rescued all 26 modules under `test/perf/`, whereas the general
 *     rule rescues exactly the six a script actually runs and leaves the other
 *     fourteen reported. A measurement script nothing invokes is not alive
 *     because of where it lives. The same rule covers
 *     `test/helpers/run-seeded-e2e.ts` and `test/smoke/*` without naming either.
 *     A token containing an asterisk is a shell glob, not a file, and is
 *     discarded — otherwise `lint`'s source glob would root the repository.
 *
 * A file reachable from a root is live, transitively, over the same forward
 * edges the importer map already records. Nothing is special-cased on
 * `test/helpers/`: those 31 files go live because a root imports them, and a
 * helper that loses its last entry-point importer goes back to being reported.
 *
 * Import resolution honours each config's `moduleNameMapper`, because these
 * specs are written `import { describeWithDb } from "test/helpers/db-describe"`.
 * Without the mapper that bare specifier resolves to nothing, no edge is
 * recorded, and the helpers would have stayed dead even with the roots modelled.
 *
 * Fail-closed, as everywhere else here: a jest config this script cannot parse
 * is a hard failure, not a shrug. An unparseable config would silently drop
 * every root it declares and the gate would start deleting live tests.
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

/**
 * Nest and tooling conventions that are entry points, not modules with importers.
 *
 * `\.spec\.ts$` and `\.e2e-spec\.ts$` USED to be alternatives here and are
 * deliberately absent: a test file is a root because a jest config selects it,
 * which `discoverEntryPoints` reads from the configs themselves. See the header.
 * Re-adding either suffix puts the rot back — it is the pattern that missed
 * `*.seeded-e2e-spec.ts` for 165 files — and it also masks the genuine defect
 * of a spec no config's `roots` reaches, which is a test nothing runs.
 */
const CONVENTION_FILE_RE =
  /(?:^src\/main\.ts$|\.module\.ts$|\.controller\.ts$|^drizzle\.config\.ts$|^eslint\.config\.mjs$|^jest\.config)/;

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

  // ---- src/modules/leads/dto -----------------------------------------------
  ["src/modules/leads/dto/leads-response.schemas.ts:leadPartySchema|leadMutatedSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first, reported because two exported names bind one value. `leadMutatedSchema` is consumed at `leads.controller.ts:76/:129`, `leads-detail.controller.ts:136/:157/:172/:187/:200`, and `leads.ingest.controller.ts` via `@ResponseSchema`; the canonical name documents the base party shape used internally across multiple response schemas. Collapsing them would merge the party data model with the mutation response contract" }],

  // ---- src/modules/settings/dto -------------------------------------------
  ["src/modules/settings/dto/settings-response.schemas.ts:automationRuleSchema|automationResponseSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first, reported because two exported names bind one value. `automationResponseSchema` is consumed at `settings.controller.ts:122/:135/:146` via `@ResponseSchema`; the canonical name documents the base rule row shape used internally. Collapsing them would merge the data model with the mutation response contract" }],

  // ---- src/modules/support/kb-gap/dto -------------------------------------
  ["src/modules/support/kb-gap/dto/support-kb-gap-response.schemas.ts:supportKnowledgeGapRowSchema|dismissGapResponseSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first, reported because two exported names bind one value. `dismissGapResponseSchema` is consumed at `support-kb-gap.controller.ts:97` via `@ResponseSchema`; the canonical name is the base row shape used internally. Collapsing them would merge the row model with the dismiss-action contract. (Line shifted 2026-09-11 when C7 moved this controller's inline `patchSchema` request guard to `dto/support-kb-gap.schemas.ts` as `dismissGapPatchSchema`.)" }],

  // teamAvailabilitySchema|teamAttendanceSchema entry removed 2026-09-19: knip
  // no longer reports the pair (found live importers), so the verdict was stale.

  // ---- src/modules/hr/** — HR DTO lane ----------------------------------------
  ["src/modules/hr/governance/dto/governance-response.schemas.ts:listPositionsResponseSchema|listVacantPositionsResponseSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first at governance-response.schemas.ts:196, reported because two exported names bind one value. Both are live: `listPositionsResponseSchema` is consumed at positions.controller.ts:53 and `listVacantPositionsResponseSchema` at positions.controller.ts:64, each via `@ResponseSchema`. Collapsing them would merge two route contracts that may legitimately diverge" }],
  ["src/modules/hr/benefits/dto/benefits-response.schemas.ts:benefitPlanSchema|getPlanResponseSchema|createPlanResponseSchema|updatePlanResponseSchema", { verdict: "KEEP", reason: "not a duplicate implementation — three aliases bind to the canonical row schema, and knip reports the group because all four exported names share one value. All three aliases are live: `getPlanResponseSchema` at hr-benefits.controller.ts:105, `createPlanResponseSchema` at :132, and `updatePlanResponseSchema` at :145, each via `@ResponseSchema`. The canonical name is used internally for `listPlansResponseSchema` and several compound schema extensions. Collapsing them would merge three separate route contracts and the shared row model into one name" }],

  // ---- src/modules/cron ----------------------------------------------------
  ["src/modules/cron/retention-schedule.ts:UNSCHEDULED_BILLING_JOBS", { verdict: "KEEP", reason: "a co-located catalog of billing jobs that CANNOT be placed on the retention scheduler yet, each with a written reason naming the specific defect that blocks it (missing payment leg for auto-topup-flush, RLS violation for ai-jobs-flush, double-counted revenue for provider-webhook-redrive). Keeping it beside RETENTION_JOBS and UNSCHEDULED_PURGE_JOBS makes the gap visible at the declaration site and prevents a future developer from scheduling one of these jobs without fixing the named defect first. No spec imports it because no spec can assert the jobs are absent from the scheduler without risking the test passing for the wrong reason." }],

  // ---- src/modules/hr/directory --------------------------------------------
  ["src/modules/hr/directory/employee-admission-status.ts:EmployeeAdmissionStatus", { verdict: "KEEP", reason: "the companion type alias for `EMPLOYEE_ADMISSION_STATUSES`, which IS imported by `directory-response.schemas.ts:4` and used at line 256 (`z.enum(EMPLOYEE_ADMISSION_STATUSES)`). The type is the public name for the union of the four status strings so that service methods and handlers that receive or return an admission status can declare their parameter type without re-deriving it through `(typeof EMPLOYEE_ADMISSION_STATUSES)[number]` at the call site." }],

  // ---- src/modules/notifications/dto ---------------------------------------
  ["src/modules/notifications/dto/unified-inbox.schemas.ts:InboxActor", { verdict: "KEEP", reason: "the named public type for the actor shape (id, name, image) embedded as `actor: inboxActorSchema.nullable()` in every unified inbox item variant. The source schema `inboxActorSchema` is composed internally into `inboxItemBaseFields` and never parsed by a separate file, so `inferredTypeOfLiveSchema` does not retain this alias automatically. Kept as the canonical name for code that formats or renders actor data from inbox items without re-inferring through the discriminated union." }],

  // ---- src/modules/billing/core — platform checkout pricing ----------------
  // file:src/modules/billing/core/billing-platform-pricing.ts entry removed
  // 2026-09-19: knip no longer reports the file as dead (found live importers),
  // so the WIRE verdict was stale.
  ["src/modules/billing/core/plan-pricing.ts:currencyForCountry", { verdict: "WIRE", reason: "reported unused only because its one importer is `billing-platform-pricing.ts`, which the graph calls dead — see the `file:` verdict above. Its siblings in the same file are live (`priceList`/`annualPrice` from `public/pricing.service.ts:8`, `priceFor` from the same dead pricing pair). It goes live in the same change that wires `billablePrice` into `BillingPaymentActivation.createOrder`; nothing else should grow a second country-to-currency rule beside it" }],

  // ---- src/common/tenant — region-aware creation seam ----------------------
  ["src/common/tenant/run-in-tenant-transaction.ts:runInNewOrgTransaction", { verdict: "WIRE", reason: "the missing caller is `bootstrapCellOrganization` (modules/organization/core/bootstrap-cell-organization.ts:52), the one production path that INSERTs an `organizations` row. It already receives `input.region` and then opens the transaction with `runInNewTenantTransaction(db, orgId, ...)`, which resolves the region by looking the organisation up — the exact case this function's doc (run-in-tenant-transaction.ts:114-140) says fails: for the transaction writing the organisation's own row there is nothing to read, so `regionForOrg` raises \"has no region\" on any deployment with a live registry. Its previous caller, `AuthService.register`, was dropped on main by `7c0094080` (\"drop unproven registration\"), which is why it is consumerless rather than new. NOT swapped here: it is the org-creation seam, the swap needs an entry added to `CROSS_REGION_OPERATIONS` (bootstrap-cell-organization.ts is not listed) and the failure it fixes only reproduces on a multi-region registry this checkout cannot exercise. Owner: organization/region" }],

  // ---- src/modules/timesheets/core/dto -------------------------------------
  ["src/modules/timesheets/core/dto/status.schemas.ts:timesheetPayPeriodSchema", { verdict: "WIRE", reason: "the only one of the ten sibling enum schemas in this file with no consumer, and the reason is that its feature is unwired rather than that the schema is redundant: `timesheet_settings.pay_period` is a live NOT NULL column defaulting to MONTHLY (db/schema/timesheets/settings.ts:80) that no code reads and no DTO admits. The missing caller is `updateCoreSettingsSchema` in `dto/settings.schemas.ts`, which is exactly the failure its own comment at :36-39 records for `autoDraftFromAttendance`: \"a policy flag missing from the DTO is a flag nobody can turn on\". Deliberately NOT added yet, because nothing reads the column either — admitting it first would ship a setting with no behaviour behind it. Owner: timesheets" }],

  // Type re-exports the merge left behind; every consumer imports from the
  // owning `*.types.ts`. Confirmed dead, but `src/modules/deals/**` belongs to
  // another workstream this session must not edit, so they are debt rather than
  // a deletion here.

  // ---- src/modules/lifecycle ----------------------------------------------
  ["src/modules/lifecycle/renewal-triggers.ts:RENEWAL_LEAD_DAYS|EXPANSION_QUIET_BEFORE_RENEWAL_DAYS", { verdict: "KEEP", reason: "not a redundant alias — a deliberate DERIVATION, and both names are live. `RENEWAL_LEAD_DAYS` is read at renewal-triggers.ts:210/:228, by `lib/lifecycle-trigger-candidates.ts:86` and by `renewal-triggers.spec.ts:302`; `EXPANSION_QUIET_BEFORE_RENEWAL_DAYS` is read at renewal-triggers.ts:306. It is written `= RENEWAL_LEAD_DAYS` rather than as a number of its own precisely so the expansion quiet window and the renewal lead window cannot drift into overlapping or leaving a gap (the argument is at :92-94). knip reports the pair because two exported names bind one value; collapsing them to a literal would reintroduce exactly the drift the derivation prevents" }],

  // ---- src/modules/commission/dto -----------------------------------------
  ["src/modules/commission/dto/commission-response.schemas.ts:commissionEarningSchema|approveCommissionEarningResponseSchema", { verdict: "KEEP", reason: "not a duplicate implementation — the second is a one-line alias of the first at commission-response.schemas.ts:137, reported because two exported names bind one value. Both are live: `approveCommissionEarningResponseSchema` is the `@ResponseSchema` of the approve route at `commission.controller.ts:239`, while the canonical name is the row shape composed internally at :131/:135 and imported by `commission-accrual-response.schemas.ts:3`. Collapsing them would move a per-route wire contract into a shared constant, the same argument as the nine alias pairs above" }],

  // The index barrel re-exports these names from the internal types file so
  // external consumers of the module can import from the barrel rather than
  // knowing the internal file layout. Internal sibling files import from
  // `./confirmable-action.types` directly (standard sibling-file pattern), so
  // knip sees no consumer of the barrel names. All four are the public API
  // surface of the confirm-actions module.

  // ---- src/modules/chat — companion type alias for presence status enum ----
  ["src/modules/chat/chat-presence-status.ts:PresenceStatus", { verdict: "KEEP", reason: "companion type alias for `PRESENCE_STATUSES`, which IS consumed at `dto/chat.schemas.ts:93` via `z.enum(PRESENCE_STATUSES)`. The inferred type of that schema IS `PresenceStatus`, so service and handler methods that accept or return a presence status value can name the type rather than re-deriving through `(typeof PRESENCE_STATUSES)[number]`. The knip inferred-type classifier only recognises `export type T = z.infer<typeof schema>` patterns — this `(typeof PRESENCE_STATUSES)[number]` derivation is semantically equivalent but not recognised, which is why the type appears unclassified rather than RETAINED-BY-CONTRACT." }],

  // ---- src/modules/build/agent-pulse/dto — companion type for signal enum --
  ["src/modules/build/agent-pulse/dto/agent-pulse.schema.ts:AgentPulseSignalType", { verdict: "KEEP", reason: "companion type alias for `agentPulseSignalTypeSchema`, which is embedded into `agentPulseSignalSchema` at line 22 (`type: agentPulseSignalTypeSchema`) and thus into the live API response schema. The knip inferred-type classifier requires the schema to be parsed directly at a named boundary — because it is composed inside another schema rather than parsed independently, the classifier misses it. A service or handler that produces or inspects a signal's `type` field can name `AgentPulseSignalType` rather than re-deriving through `(typeof agentPulseSignalTypeSchema.Values)[number]`." }],

  // ---- dependencies --------------------------------------------------------
  ["dep:@jitl/quickjs-wasmfile-release-sync", { verdict: "KEEP", reason: "not a direct dependency by design. `script.executor.ts` resolves it with `require.resolve(spec, { paths: [dirname(require.resolve(\"quickjs-emscripten\"))] })`, i.e. from the declared dependency's own directory, to get a CJS build of the WASM module that Jest can load. Verified resolvable; knip reports it because it does not model the `paths` option" }],

  // ---- new entries added 2026-09-27 to clear 111 unclassified findings -----

  // ---- dep findings --------------------------------------------------------
  ["dep:@aws-sdk/client-rds", { verdict: "REMOVE", reason: "manages RDS instances (create/delete/restore) and has zero imports anywhere in the codebase. The only AWS SDK package used at runtime for database access is `@aws-sdk/rds-signer`, which is dynamically required inside `src/db/rds-iam-auth.ts` to generate IAM authentication tokens for connection strings. `client-rds` appears as a devDependency but was never imported; the package owner should remove it from package.json when reconciling the dependency manifest" }],
  ["dep:openssl", { verdict: "KEEP", reason: "system binary invoked via `execFileSync('openssl', [...])` in `test/notifications/web-push-from-worker.seeded-e2e-spec.ts:115` to generate a self-signed TLS certificate for the push-notification sink that the seeded e2e suite stands up. Knip reports it as an unresolved binary because it is a system command rather than an npm package, so the module graph has no import path to trace" }],

  // ---- src/modules/rbac/permissions/index.ts — dead barrel re-exports ------
  // All 47 findings below are re-exports in the barrel that no consumer reaches
  // through the barrel path. Every caller imports from the declaring submodule
  // directly (e.g. `from "../../permissions/billing"`), so knip sees zero
  // consumers of these barrel names.
  ["src/modules/rbac/permissions/index.ts:SIGN_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports SIGN_PERMISSIONS directly from its declaring file `src/modules/rbac/permissions/sign.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:NOTIFICATIONS_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports NOTIFICATIONS_PERMISSIONS directly from `src/modules/rbac/permissions/notifications.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:HR_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports HR_PERMISSIONS directly from `src/modules/rbac/permissions/hr.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:CRM_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports CRM_PERMISSIONS directly from `src/modules/rbac/permissions/crm.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:ACCOUNTING_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports ACCOUNTING_PERMISSIONS directly from `src/modules/rbac/permissions/accounting.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:INVENTORY_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports INVENTORY_PERMISSIONS directly from `src/modules/rbac/permissions/inventory.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:KB_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports KB_PERMISSIONS directly from `src/modules/rbac/permissions/kb.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PAYROLL_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PAYROLL_PERMISSIONS directly from `src/modules/rbac/permissions/payroll.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:BLOG_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports BLOG_PERMISSIONS directly from `src/modules/rbac/permissions/blog.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:SALES_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports SALES_PERMISSIONS directly from `src/modules/rbac/permissions/sales.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:SHARED_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports SHARED_PERMISSIONS directly from `src/modules/rbac/permissions/shared.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:SUPPORT_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports SUPPORT_PERMISSIONS directly from `src/modules/rbac/permissions/support.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:CHAT_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports CHAT_PERMISSIONS directly from `src/modules/rbac/permissions/chat.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:CALENDAR_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports CALENDAR_PERMISSIONS directly from `src/modules/rbac/permissions/calendar.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:API_TOKEN_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports API_TOKEN_PERMISSIONS directly from `src/modules/rbac/permissions/api-tokens.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:BILLING_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports BILLING_PERMISSIONS directly from `src/modules/rbac/permissions/billing.ts` (confirmed: `billing-permission-fence.e2e-spec.ts` imports from the submodule, not the barrel), not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:WORKFLOW_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports WORKFLOW_PERMISSIONS directly from `src/modules/rbac/permissions/workflows.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:TIMESHEETS_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports TIMESHEETS_PERMISSIONS directly from `src/modules/rbac/permissions/timesheets.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:ONBOARDING_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports ONBOARDING_PERMISSIONS directly from `src/modules/rbac/permissions/onboarding.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PAYMENTS_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PAYMENTS_PERMISSIONS directly from `src/modules/rbac/permissions/payments.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:SURVEYS_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports SURVEYS_PERMISSIONS directly from `src/modules/rbac/permissions/surveys.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:CLIENT_PORTAL_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports CLIENT_PORTAL_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:QA_BUGS_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports QA_BUGS_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PROJECT_APPROVALS_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PROJECT_APPROVALS_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PROJECTS_AI_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PROJECTS_AI_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PROJECT_GOVERNANCE_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PROJECT_GOVERNANCE_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PROJECT_MEETINGS_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PROJECT_MEETINGS_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PROJECT_INCIDENTS_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PROJECT_INCIDENTS_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PROJECT_FORMS_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PROJECT_FORMS_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PROJECT_PORTFOLIO_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PROJECT_PORTFOLIO_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PROJECT_MANAGED_PRODUCTS_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PROJECT_MANAGED_PRODUCTS_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PROJECT_TEAMS_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PROJECT_TEAMS_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PROJECT_MEMBERS_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PROJECT_MEMBERS_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PROJECT_CUSTOMERS_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PROJECT_CUSTOMERS_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PROJECT_WORKFLOW_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PROJECT_WORKFLOW_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PROJECT_UPDATES_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PROJECT_UPDATES_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PROJECT_FILES_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PROJECT_FILES_PERMISSIONS directly from `src/modules/rbac/permissions/build.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:FEEDBUCKET_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports FEEDBUCKET_PERMISSIONS directly from `src/modules/rbac/permissions/feedbucket.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:AI_SUMMARIES_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports AI_SUMMARIES_PERMISSIONS directly from `src/modules/rbac/permissions/ai.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:AI_USAGE_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports AI_USAGE_PERMISSIONS directly from `src/modules/rbac/permissions/ai.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:EXECUTIVE_BRIEF_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports EXECUTIVE_BRIEF_PERMISSIONS directly from `src/modules/rbac/permissions/ai.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:DIRECTORY_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports DIRECTORY_PERMISSIONS directly from `src/modules/rbac/permissions/directory.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:PARTY_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports PARTY_PERMISSIONS directly from `src/modules/rbac/permissions/party.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:MAIL_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports MAIL_PERMISSIONS directly from `src/modules/rbac/permissions/mail.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:COMPLIANCE_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports COMPLIANCE_PERMISSIONS directly from `src/modules/rbac/permissions/compliance.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:STORAGE_PERMISSIONS", { verdict: "REMOVE", reason: "dead barrel re-export; every consumer imports STORAGE_PERMISSIONS directly from `src/modules/rbac/permissions/storage.ts`, not from the barrel" }],
  ["src/modules/rbac/permissions/index.ts:ALL_ROLES", { verdict: "REMOVE", reason: "dead barrel re-export from the barrel index; `ALL_ROLES` is defined in `src/modules/rbac/permissions/role-defaults.ts` and the barrel re-exports it, but no consumer imports it via the barrel path. The one definition in `accounting-provisioning.spec.ts` is a local const by the same name, not an import. The role-defaults.ts declaration itself is also reported separately below" }],

  // ---- src/modules/rbac/permissions/role-defaults.ts -----------------------
  ["src/modules/rbac/permissions/role-defaults.ts:ALL_ROLES", { verdict: "REMOVE", reason: "exported from `role-defaults.ts` but no consumer imports it. The only codebase occurrence of `ALL_ROLES` outside its declaration is a local `const ALL_ROLES` defined inline in `accounting-provisioning.spec.ts` — a coincidentally named local variable, not an import of this symbol. The barrel in `rbac/permissions/index.ts` re-exports it (also reported above as a dead barrel re-export), but that does not make the underlying export live" }],

  // ---- src/common/slo/index.ts — dead barrel re-exports --------------------
  // The two spec consumers of this barrel (`kb-ask-metric-alert-parity.spec.ts`,
  // `kb-indexing-metric-alert-parity.spec.ts`) import only `KB_ASK_SLO` and
  // `KB_INDEXING_SLO` from the barrel path. No file imports the 22 symbols below.
  ["src/common/slo/index.ts:KB_ALERT_RUNBOOK", { verdict: "REMOVE", reason: "dead barrel re-export; the two spec consumers of this barrel (`kb-ask-metric-alert-parity.spec.ts`, `kb-indexing-metric-alert-parity.spec.ts`) import only `KB_ASK_SLO` and `KB_INDEXING_SLO` — no file imports KB_ALERT_RUNBOOK via any path" }],
  ["src/common/slo/index.ts:KB_SLOS", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_SLOS via any path. The spec consumers of this barrel import only their domain-specific SLO objects" }],
  ["src/common/slo/index.ts:KB_INDEXING_SPAN", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_INDEXING_SPAN via any path" }],
  ["src/common/slo/index.ts:KB_ASK_SLOS", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_ASK_SLOS (the array) via any path. Note: `KB_ASK_SLO` (the singular object) IS live — this is the plural array, which is unused" }],
  ["src/common/slo/index.ts:KB_ASK_SPAN", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_ASK_SPAN via any path" }],
  ["src/common/slo/index.ts:KB_SEARCH_SLO", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_SEARCH_SLO via any path. The KB search SLO constants were added to the barrel without a corresponding spec consumer being wired in" }],
  ["src/common/slo/index.ts:KB_SEARCH_SLOS", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_SEARCH_SLOS via any path" }],
  ["src/common/slo/index.ts:KB_SEARCH_SPAN", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_SEARCH_SPAN via any path" }],
  ["src/common/slo/index.ts:KB_SEARCH_MIN_FAULTS", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_SEARCH_MIN_FAULTS via any path" }],
  ["src/common/slo/index.ts:KB_SEARCH_MIN_DENIALS", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_SEARCH_MIN_DENIALS via any path" }],
  ["src/common/slo/index.ts:KB_SEARCH_MIN_NOT_FOUND", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_SEARCH_MIN_NOT_FOUND via any path" }],
  ["src/common/slo/index.ts:KB_SEARCH_FAULT_OUTCOMES", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_SEARCH_FAULT_OUTCOMES via any path" }],
  ["src/common/slo/index.ts:KB_SEARCH_MAX_FAULT_RATIO", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_SEARCH_MAX_FAULT_RATIO via any path" }],
  ["src/common/slo/index.ts:KB_SEARCH_MAX_DENIED_RATIO", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_SEARCH_MAX_DENIED_RATIO via any path" }],
  ["src/common/slo/index.ts:KB_SEARCH_MAX_NOT_FOUND_RATIO", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_SEARCH_MAX_NOT_FOUND_RATIO via any path" }],
  ["src/common/slo/index.ts:KB_FRESHNESS_SLOS", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_FRESHNESS_SLOS via any path" }],
  ["src/common/slo/index.ts:KB_INDEX_FRESHNESS_SLO", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_INDEX_FRESHNESS_SLO via any path" }],
  ["src/common/slo/index.ts:KB_ACCESS_REVOCATION_SLO", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_ACCESS_REVOCATION_SLO via any path" }],
  ["src/common/slo/index.ts:KB_INDEX_FRESHNESS_STALE_THRESHOLD_MINUTES", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_INDEX_FRESHNESS_STALE_THRESHOLD_MINUTES via any path" }],
  ["src/common/slo/index.ts:KB_INDEX_FRESHNESS_MIN_PAGES", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_INDEX_FRESHNESS_MIN_PAGES via any path" }],
  ["src/common/slo/index.ts:KB_ACCESS_REVOCATION_LAG_THRESHOLD_SECONDS", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_ACCESS_REVOCATION_LAG_THRESHOLD_SECONDS via any path" }],
  ["src/common/slo/index.ts:KB_ACCESS_REVOCATION_MIN_PAGES", { verdict: "REMOVE", reason: "dead barrel re-export; no file imports KB_ACCESS_REVOCATION_MIN_PAGES via any path" }],

  // ---- src/test/tenant-recorder.ts — dead barrel re-exports ----------------
  // All spec consumers of this barrel import `tenantDb`, `TenantFixture`, and
  // `sqlValues` — none imports these five symbols.
  ["src/test/tenant-recorder.ts:equalities", { verdict: "REMOVE", reason: "dead barrel re-export; `equalities` is defined in `tenant-recorder-sql.ts` and used internally by `tenant-recorder.ts` itself (line 77). All spec consumers of the barrel import `tenantDb`, `TenantFixture`, or `sqlValues`, never `equalities` directly" }],
  ["src/test/tenant-recorder.ts:orgBindings", { verdict: "REMOVE", reason: "dead barrel re-export; `orgBindings` is defined in `tenant-recorder-sql.ts` and used internally by `tenant-recorder.ts` itself (line 120). No spec imports it from the barrel" }],
  ["src/test/tenant-recorder.ts:Op", { verdict: "REMOVE", reason: "dead barrel re-export of the `Op` type from `tenant-recorder.types.ts`; no spec imports `Op` from this barrel path" }],
  ["src/test/tenant-recorder.ts:Row", { verdict: "REMOVE", reason: "dead barrel re-export of the `Row` type from `tenant-recorder.types.ts`; no spec imports `Row` from this barrel path" }],
  ["src/test/tenant-recorder.ts:Statement", { verdict: "REMOVE", reason: "dead barrel re-export of the `Statement` type from `tenant-recorder.types.ts`; no spec imports `Statement` from this barrel path" }],

  // ---- individual dead exports ----------------------------------------------
  ["src/modules/hr/time/leaves-scope.ts:leaveApproverRead", { verdict: "REMOVE", reason: "exported but no consumer imports it. `leaves-scope.ts` contains several leave-related scope helpers that ARE used (e.g. the leave balance reads), but `leaveApproverRead` — a scope predicate for leave approver visibility — was added without a calling site. Owner: HR/time" }],
  ["src/modules/build/core/project-access.ts:assertTicketInProject", { verdict: "REMOVE", reason: "exported but no consumer imports it. The project-access module has live helpers (`assertProjectAccess`, `requireProjectMember`) that are called by build controllers, but `assertTicketInProject` — a guard that verifies a ticket belongs to a given project — was added without a caller being wired in. Owner: build/core" }],
  ["src/modules/timesheets/core/invoice-line-detail.ts:INVOICE_LINE_DETAIL_VALUES", { verdict: "REMOVE", reason: "exported but no consumer imports it. The const array enumerates invoice line detail status strings but no DTO, schema, or service reaches for it; the statuses are used inline elsewhere. Owner: timesheets" }],
  ["src/modules/hr/helpdesk/lib/support-queues.ts:SUPPORT_AGENT_PERMISSION", { verdict: "REMOVE", reason: "exported but no consumer imports it. The file's sibling export `SUPPORT_QUEUES` IS used by the helpdesk service, but `SUPPORT_AGENT_PERMISSION` — a permission key constant for the support-agent role — has no importer. Owner: HR/helpdesk" }],
  ["src/modules/hr/helpdesk/lib/support-queues.ts:isSupportQueue", { verdict: "REMOVE", reason: "exported but no consumer imports it. The predicate checks whether a given queue name is a recognised support queue, but no call site exists; queue membership is validated inline at the consuming service. Owner: HR/helpdesk" }],
  ["src/modules/hr/lifecycle/dto/exit-checklist.schemas.ts:isExitChecklistKind", { verdict: "REMOVE", reason: "exported but no consumer imports it. The type-guard narrows a string to `ExitChecklistKind` but the only parsing site uses a Zod enum schema directly; no runtime path calls this guard. Owner: HR/lifecycle" }],
  ["src/modules/kb/core/telemetry/kb-ask-metrics.ts:kbAskOutcomeForError", { verdict: "REMOVE", reason: "exported but no consumer imports it. The function maps an Error to a KB ask outcome string for telemetry, but the single telemetry call site in `kb-ask.service.ts` constructs the outcome inline rather than delegating to this helper. Owner: KB/core" }],
  ["src/modules/kb/wiki/kb-multi-store-purge.ts:areAllStoresComplete", { verdict: "REMOVE", reason: "exported but no consumer imports it. The predicate checks whether all vector-store deletion jobs have reached a terminal state, but the purge orchestrator that would call it never imports it — the completion check is either inline or not yet wired. Owner: KB/wiki" }],
  ["src/modules/hr/recruitment/integrations/integration-catalog.ts:integrationsInFamily", { verdict: "REMOVE", reason: "exported but no consumer imports it. The helper filters the integration catalog by family name, but all call sites that need a family subset construct the filter inline. Owner: HR/recruitment" }],
  ["src/modules/directory/approval-authority.types.ts:isApprovalRequestKind", { verdict: "REMOVE", reason: "exported but no consumer imports it. The type-guard narrows a string to `ApprovalRequestKind`, but the only validation site in the approval-authority module uses a Zod schema rather than this guard. Owner: directory" }],
  ["src/modules/accounting/ar/ar-documents.service.ts:computeLineNetMinor", { verdict: "KEEP", reason: "imported by `src/modules/accounting/ar/ar.e2e-spec.ts:44` (`import { ArDocumentsService, computeLineNetMinor } from './ar-documents.service'`). The consumer is invisible to knip because the file has the suffix `.e2e-spec.ts` which does not match knip's entry glob `src/**/*.spec.ts` — `.e2e-spec.ts` ends with `-spec.ts`, not `.spec.ts`, so the module graph never walks it" }],
  ["src/modules/cron/cron-recruitment-reports.service.ts:toCsv", { verdict: "REMOVE", reason: "exported but no consumer imports it. The helper serialises a row array to CSV text for a recruitment report, but the cron service that generates the report has no caller — the whole recruitment-reports cron job is unwired. Owner: cron" }],
  ["src/modules/expenses/expense-inbox-reads.ts:countPendingExpensesRoutedTo", { verdict: "REMOVE", reason: "exported but no consumer imports it. The function counts expenses pending approval for a given approver; the approval inbox reads that exist today use a different query shape. Owner: expenses" }],
  ["src/modules/build/import-export/ticket-import-batches.ts:chunkRows", { verdict: "REMOVE", reason: "exported but no consumer imports it. The helper splits a flat row array into fixed-size batches for bulk ticket imports, but no import handler calls it — the batch chunking is done inline at the one importer that uses the file's other exports. Owner: build/import-export" }],

  // ---- src/db/schema/directory/hrms-migration-profile.ts ------------------
  // SCHEMA_RE protects this FILE from being called dead but does not apply at
  // the individual-export level inside classifyFinding().
  ["src/db/schema/directory/hrms-migration-profile.ts:hrmsMigrationProfileEvents", { verdict: "KEEP", reason: "Drizzle pgTable definition in `src/db/schema/`. `classifyFile()` retains schema files under `src/db/schema/` via SCHEMA_RE, but `classifyFinding()` does not apply SCHEMA_RE to individual symbol findings, so table objects in schema files are reported as unused exports even though they are the live DDL anchor for the table. Referenced by name in `bundle-catalog-registry.ts` and asserted in `schema-drift.db.spec.ts`" }],
  ["src/db/schema/directory/hrms-migration-profile.ts:hrmsScopeVersions", { verdict: "KEEP", reason: "Drizzle pgTable definition in `src/db/schema/`. Same classifier gap as `hrmsMigrationProfileEvents` above: SCHEMA_RE guards the file but not the individual export finding. This table is the version-tracking anchor for the HRMS scope migration and is referenced by name in `bundle-catalog-registry.ts`" }],

  // ---- src/modules/careers/dto/careers-response.schemas.ts ----------------
  // The controller's comment explicitly records that these two schemas describe
  // endpoints removed in ATS-CORE-005.
  ["src/modules/careers/dto/careers-response.schemas.ts:careersJobListSchema", { verdict: "REMOVE", reason: "the corresponding controller endpoint was removed in ATS-CORE-005 (noted in `careers.controller.ts` lines 15-21). The schema remains as a leftover artifact with no route or service caller" }],
  ["src/modules/careers/dto/careers-response.schemas.ts:careersApplyResponseSchema", { verdict: "REMOVE", reason: "the corresponding controller endpoint was removed in ATS-CORE-005 (noted in `careers.controller.ts` lines 15-21). The schema remains as a leftover artifact with no route or service caller" }],

  // ---- src/modules/kb/core/kb-support-documents.ts — WIRE -----------------
  // These are the DAL query functions for the help-centre article management
  // feature (KB architecture: help-centre = support/core). `support-kb-articles.ts`
  // currently has its own inline duplicates; these canonical DAL functions are
  // the intended replacements once the refactor lands. Owner: KB/help-centre (S14).
  ["src/modules/kb/core/kb-support-documents.ts:listSupportArticles", { verdict: "WIRE", reason: "the DAL query for the help-centre article list endpoint. `src/modules/support/core/lib/support-kb-articles.ts` contains a parallel inline implementation; the missing caller is a refactored `SupportKbArticlesService` (owner: KB/help-centre, S14) that consolidates article CRUD into the `kb/core` data-access layer rather than duplicating it in `support/core/lib/`. Not deleted because it is the future canonical list query" }],
  ["src/modules/kb/core/kb-support-documents.ts:lookupSupportArticle", { verdict: "WIRE", reason: "the DAL query for fetching a single help-centre article by id. The missing caller is the same refactored service in `src/modules/support/core/` described above for `listSupportArticles`. Owner: KB/help-centre (S14)" }],
  ["src/modules/kb/core/kb-support-documents.ts:lookupSupportArticleCurrentState", { verdict: "WIRE", reason: "the DAL query for fetching a help-centre article's current publication/revision state, used as the pre-condition check before a patch or publish operation. The missing caller is the refactored `SupportKbArticlesService`. Owner: KB/help-centre (S14)" }],
  ["src/modules/kb/core/kb-support-documents.ts:insertSupportArticle", { verdict: "WIRE", reason: "the DAL mutation for creating a new help-centre article. The missing caller is the refactored `SupportKbArticlesService`. Owner: KB/help-centre (S14)" }],
  ["src/modules/kb/core/kb-support-documents.ts:patchSupportArticle", { verdict: "WIRE", reason: "the DAL mutation for updating an existing help-centre article, with an optional optimistic-locking revision guard. The missing caller is the refactored `SupportKbArticlesService`. Owner: KB/help-centre (S14)" }],
  ["src/modules/kb/core/kb-support-documents.ts:softDeleteSupportArticle", { verdict: "WIRE", reason: "the DAL mutation for soft-deleting a help-centre article (sets `deletedAt`). The missing caller is the refactored `SupportKbArticlesService`. Owner: KB/help-centre (S14)" }],
  ["src/modules/kb/core/kb-support-documents.ts:findUsedSupportArticleSlugs", { verdict: "WIRE", reason: "the DAL query for checking slug uniqueness before insert or rename; scans all existing slugs with the same root prefix to avoid collisions. The missing caller is the refactored `SupportKbArticlesService`. Owner: KB/help-centre (S14)" }],

  // ---- types that inferredTypeOfLiveSchema does not retain automatically ---
  ["src/modules/build/core/dto/automation.schemas.ts:AutomationActionType", { verdict: "KEEP", reason: "companion type alias for `AUTOMATION_ACTION_TYPES` (`export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number]`). The array IS live — used at line 52 in `listAutomationsQuerySchema` as `z.enum(AUTOMATION_ACTION_TYPES)`. The `(typeof ARRAY)[number]` derivation is semantically equivalent to a `z.infer<>` alias but is not recognised by the `inferredTypeOfLiveSchema` classifier, which only matches the `z.infer<typeof schema>` pattern. Same pattern as `PresenceStatus` and `AgentPulseSignalType` already KEPT above" }],
  ["src/modules/hr/directory/dto/directory-response.schemas.ts:InviteDeliveryStatusResponse", { verdict: "KEEP", reason: "named public type for the shape produced by `inviteDeliveryStatusSchema`, which is composed into `employeeDetailSchema` (line 480) and ultimately consumed at `employee-detail.controller.ts:117`. The source schema is only used as a sub-object inside a larger schema and is never parsed independently, so `inferredTypeOfLiveSchema` requires an external direct consumer — which it cannot find — and does not retain this alias. Same pattern as the `InboxActor` entry above" }],
  ["src/db/enums.generated.ts:DbEnumMember", { verdict: "KEEP", reason: "utility generic type in a generated file (`src/db/enums.generated.ts`). Provides `DbEnumMember<N>` as the public type accessor for the member union of any registered DB enum name, sparing callers from writing `(typeof DB_ENUMS)[N][number]`. Hand-editing this file is pointless — the next generation run would revert it — so the finding must be classified rather than deleted" }],
  ["src/modules/kb/content-health/dto/kb-content-health.schemas.ts:BulkRepairOutcome", { verdict: "KEEP", reason: "named public type for the shape produced by `bulkRepairOutcomeEnum`, a private (non-exported) const composed into `bulkRepairResponseSchema` which IS live. The source enum is never parsed directly, so `inferredTypeOfLiveSchema` finds no external consumer and does not retain this alias. Same pattern as the `InboxActor` entry above" }],

  // ---- dead type exports ----------------------------------------------------
  ["src/modules/kb/help-centre/kb-article-page-scope.ts:PageTrustState", { verdict: "REMOVE", reason: "exported type with no consumer. The type describes the trust level of a help-centre article page (e.g. draft/published/archived), but no service, DTO, or controller imports it; trust-level branching in the help-centre is done against string literals directly. Owner: KB/help-centre" }],
  ["src/modules/kb/wiki/dto/kb-pages.schemas.ts:ListPagesInput", { verdict: "REMOVE", reason: "exported type inferred from a schema, but no consumer imports it. The corresponding `listPagesQuerySchema` is used internally by the KB wiki controller, but the `ListPagesInput` type alias was exported without a caller being added. Owner: KB/wiki" }],
  ["src/modules/public/portal/candidate-portal-view.ts:PortalApplicationView", { verdict: "REMOVE", reason: "exported type with no consumer. The type describes a candidate's view of a portal application, but no controller, service, or DTO imports it; the application view is shaped inline at the one public portal endpoint. Owner: public/portal" }],
  ["src/modules/hr/recruitment/boards/job-board-publisher.service.ts:PublishTarget", { verdict: "REMOVE", reason: "exported type with no consumer. The type describes a job-board publish target, but no caller imports it; the publish operation is typed inline at the call site. Owner: HR/recruitment" }],

  // ---- duplicate export — deliberate derivation ----------------------------
  ["test/perf/ai/kb-retrieval-corpus.mjs:EMBEDDING_DIMENSIONS|TOPIC_POOL", { verdict: "KEEP", reason: "not a redundant duplicate — a deliberate derivation. `TOPIC_POOL` is written as `= EMBEDDING_DIMENSIONS` so the corpus pool size is always equal to the embedding dimension count and cannot silently drift. Knip reports the pair because two exported names bind one value. Same pattern as the `RENEWAL_LEAD_DAYS|EXPANSION_QUIET_BEFORE_RENEWAL_DAYS` entry above" }],
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

function resolveBase(base) {
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

/**
 * `mappers` are the compiled `moduleNameMapper` entries of the jest configs.
 *
 * Without them `import { describeWithDb } from "test/helpers/db-describe"` —
 * the form every e2e spec in this repository uses — resolves to nothing, no
 * edge is recorded, and every helper reached only that way looks unimported.
 * The hard-coded `src/` branch below is the same mechanism frozen in code; it
 * stays as a fallback for a checkout with no jest config at all.
 */
function findFile(spec, fromDir, root, mappers = []) {
  if (spec.startsWith(".")) return resolveBase(resolvePath(fromDir, spec));
  if (spec.startsWith("src/")) {
    const hit = resolveBase(join(root, spec));
    if (hit) return hit;
  }
  for (const { re, target } of mappers) {
    const m = re.exec(spec);
    if (!m) continue;
    const substituted = target.replace(/\$(\d)/g, (_, d) => m[Number(d)] ?? "");
    const hit = resolveBase(resolvePath(root, substituted));
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

function buildImporterMap(root, mappers = []) {
  const map = new Map();
  const forward = new Map();
  const files = [];
  let filesWalked = 0;

  const record = (target, importer, kind) => {
    if (!target) return;
    if (!map.has(target))
      map.set(target, { sideEffect: new Set(), named: new Set(), reexport: new Set(), dynamic: new Set() });
    map.get(target)[kind].add(importer);
    if (!forward.has(importer)) forward.set(importer, new Set());
    forward.get(importer).add(target);
  };

  for (const file of walkSource(root)) {
    filesWalked += 1;
    files.push(file);
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const fromDir = dirname(file);

    for (const line of src.split("\n")) {
      const m = line.match(/^\s*import\s+["']([^"']+)["']\s*;?\s*$/);
      if (m) record(findFile(m[1], fromDir, root, mappers), file, "sideEffect");
    }

    let m;
    const named = /^import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)[^"'\n]*from\s+["']([^"']+)["']/gm;
    while ((m = named.exec(src)) !== null) record(findFile(m[1], fromDir, root, mappers), file, "named");

    const reexport = /^export\s+(?:type\s+)?(?:\{[^}]*\}|\*[^"'\n]*)\s+from\s+["']([^"']+)["']/gm;
    while ((m = reexport.exec(src)) !== null) record(findFile(m[1], fromDir, root, mappers), file, "reexport");

    const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = dynamic.exec(src)) !== null) record(findFile(m[1], fromDir, root, mappers), file, "dynamic");
  }

  return { map, forward, files, filesWalked };
}

// ---------------------------------------------------------------------------
// Entry points — derived from jest configs and package.json scripts. See the
// header for why nothing in this section may become a hand-written glob.
// ---------------------------------------------------------------------------

/** A jest config sitting in the repository root: `jest.config.*`, `jest-e2e.json`, … */
const JEST_CONFIG_FILE_RE = /^jest(?:[.-][\w.-]+)?\.(?:json|js|cjs|mjs|ts)$/;

/** jest fields whose value names a file to load rather than a module to analyse. */
const JEST_HOOK_FIELDS = [
  "setupFiles", "setupFilesAfterEnv", "globalSetup", "globalTeardown",
  "testResultsProcessor", "testRunner", "testSequencer", "resolver",
  "snapshotResolver", "runner", "reporters", "watchPlugins", "testEnvironment",
];

/** jest's own default when a config declares neither `testMatch` nor `testRegex`. */
const JEST_DEFAULT_TEST_MATCH = ["**/__tests__/**/*.[jt]s?(x)", "**/?(*.)+(spec|test).[jt]s?(x)"];

const RUNNABLE_FILE_RE = /\.(?:ts|mts|cts|tsx|mjs|cjs|js|jsx)$/;

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Every string leaf of a jest field value — `reporters` nests them one level deep. */
function stringLeaves(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out);
  return out;
}

function stripRootDir(spec) {
  return spec.startsWith("<rootDir>") ? spec.slice("<rootDir>".length).replace(/^[/\\]+/, "") : spec;
}

/**
 * Minimal glob support, enough for `testMatch`: `**\/` spans directories, `*`
 * does not cross one, `?(x)` and `+(a|b)` are jest's extglob forms and appear in
 * its own default `testMatch`. Anything else is matched literally.
 */
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { out += "(?:[^/]*/)*"; i += 2; }
      else { out += ".*"; i += 1; }
    } else if (ch === "*") out += "[^/]*";
    else if ((ch === "?" || ch === "+" || ch === "@" || ch === "!") && glob[i + 1] === "(") {
      const close = glob.indexOf(")", i);
      if (close === -1) { out += "\\" + ch; continue; }
      const inner = glob.slice(i + 2, close).split("|").map((alt) => globToRegExp(alt).source.replace(/^\^|\$$/g, "")).join("|");
      out += ch === "?" ? `(?:${inner})?` : ch === "+" ? `(?:${inner})+` : `(?:${inner})`;
      i = close;
    } else if (ch === "[") {
      const close = glob.indexOf("]", i);
      if (close === -1) out += "\\[";
      else { out += glob.slice(i, close + 1); i = close; }
    } else if ("\\^$.|+(){}".includes(ch)) out += "\\" + ch;
    else out += ch;
  }
  return new RegExp(`^${out}$`);
}

/** `<rootDir>/x`, `./x` or `x` -> the absolute file it names, or null if it names no file here. */
function resolveConfigFile(root, spec) {
  if (typeof spec !== "string" || !spec.length) return null;
  const cleaned = stripRootDir(spec);
  if (/[*?]/.test(cleaned)) return null;
  const base = resolvePath(root, cleaned);
  return tryFile(base)
    ?? tryFile(`${base}.ts`) ?? tryFile(`${base}.mts`) ?? tryFile(`${base}.mjs`)
    ?? tryFile(`${base}.cjs`) ?? tryFile(`${base}.js`) ?? null;
}

function compileModuleNameMappers(config) {
  const mappers = [];
  for (const [pattern, target] of Object.entries(config?.moduleNameMapper ?? {})) {
    let re;
    try {
      re = new RegExp(pattern);
    } catch {
      continue;
    }
    for (const value of asArray(target)) mappers.push({ re, target: stripRootDir(String(value)) });
  }
  return mappers;
}

/**
 * The jest configs this repository runs, read from disk and from
 * `package.json` — never from a list in this file.
 *
 * `unreadable` is not a warning. A config the gate cannot parse declares roots
 * the gate cannot see, so every test it selects would be reported dead and
 * somebody would delete a live suite on this gate's word. `main` exits 1 on it.
 */
function discoverJestConfigs(root, pkg) {
  const configs = [];
  const unreadable = [];
  const seen = new Set();

  if (pkg?.jest) configs.push({ label: "package.json#jest", config: pkg.jest });

  const candidates = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries)
    if (entry.isFile() && JEST_CONFIG_FILE_RE.test(entry.name)) candidates.push(entry.name);

  // Only a command that runs jest: `--config` is a near-universal CLI flag and
  // harvesting it unconditionally made `drizzle-kit --config drizzle.config.ts`
  // an unparseable jest config, which failed the gate for the wrong reason.
  for (const command of Object.values(pkg?.scripts ?? {})) {
    if (!/\bjest\b/.test(String(command))) continue;
    for (const m of String(command).matchAll(/--config[=\s]+(['"]?)([^\s'"]+)\1/g)) candidates.push(m[2]);
  }

  for (const candidate of candidates) {
    const cleaned = stripRootDir(candidate).replace(/^\.\//, "");
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    const abs = resolvePath(root, cleaned);
    if (!tryFile(abs)) continue;
    if (!cleaned.endsWith(".json")) {
      unreadable.push(cleaned);
      continue;
    }
    try {
      configs.push({ label: cleaned, config: JSON.parse(readFileSync(abs, "utf8")) });
    } catch {
      unreadable.push(cleaned);
    }
  }

  return { configs, unreadable };
}

/** The files a single jest config would collect as tests, honouring roots and ignores. */
function jestTestFiles(config, root, files) {
  const rootFwd = toFwd(root).replace(/\/+$/, "");
  const expand = (spec) => `${rootFwd}/${stripRootDir(spec).replace(/^\.\//, "")}`;

  const searchRoots = asArray(config.roots ?? "<rootDir>").map((r) => expand(String(r)).replace(/\/+$/, ""));
  const ignore = asArray(config.testPathIgnorePatterns ?? ["/node_modules/"]).map((p) => new RegExp(p));

  const include = [];
  if (config.testRegex !== undefined) for (const p of asArray(config.testRegex)) include.push(new RegExp(p));
  const globs = config.testMatch !== undefined ? asArray(config.testMatch)
    : config.testRegex !== undefined ? []
    : JEST_DEFAULT_TEST_MATCH;
  for (const g of globs) include.push(globToRegExp(expand(String(g))));
  if (!include.length) return [];

  const hits = [];
  for (const file of files) {
    const fwd = toFwd(file);
    if (!searchRoots.some((r) => fwd === r || fwd.startsWith(`${r}/`))) continue;
    if (ignore.some((re) => re.test(fwd))) continue;
    if (!include.some((re) => re.test(fwd))) continue;
    hits.push(file);
  }
  return hits;
}

/**
 * relPath -> the configuration that makes it a root, plus the compiled
 * `moduleNameMapper` entries the importer map needs to resolve bare specifiers.
 */
function discoverEntryPoints(root, pkg, configs, files) {
  const roots = new Map();
  const add = (abs, label) => {
    if (!abs) return;
    const rel = toFwd(relative(root, abs));
    if (rel.startsWith("..") || rel.split("/").some((seg) => isOutOfScopeDir(seg))) return;
    if (!roots.has(rel)) roots.set(rel, label);
  };

  for (const { label, config } of configs) {
    for (const abs of jestTestFiles(config, root, files)) add(abs, `${label} selects it as a test file`);
    for (const field of JEST_HOOK_FIELDS)
      for (const spec of stringLeaves(config[field]))
        add(resolveConfigFile(root, spec), `${label} loads it as \`${field}\``);
    for (const { target } of compileModuleNameMappers(config))
      if (!/\$\d/.test(target)) add(resolveConfigFile(root, target), `${label} maps a module name to it`);
  }

  for (const [name, command] of Object.entries(pkg?.scripts ?? {}))
    for (const raw of String(command).split(/\s+/)) {
      const token = raw.replace(/^['"]|['"]$/g, "").replace(/^\.\//, "");
      if (!RUNNABLE_FILE_RE.test(token) || /[*?]/.test(token) || token.startsWith("-")) continue;
      add(resolveConfigFile(root, token), `\`pnpm ${name}\` runs it`);
    }

  return roots;
}

/** relPath -> which root reaches it, walked over the same forward edges the importer map recorded. */
function reachableFromEntryPoints(root, roots, forward) {
  const reached = new Map();
  const queue = [];
  for (const rel of roots.keys()) queue.push({ abs: join(root, ...rel.split("/")), entry: rel });
  const visited = new Set(queue.map((q) => q.abs));

  while (queue.length) {
    const { abs, entry } = queue.shift();
    for (const target of forward.get(abs) ?? []) {
      if (visited.has(target)) continue;
      visited.add(target);
      const rel = toFwd(relative(root, target));
      if (!roots.has(rel)) reached.set(rel, entry);
      queue.push({ abs: target, entry });
    }
  }
  return reached;
}

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

const NO_ENTRY_POINTS = { roots: new Map(), reached: new Map() };

function classifyFile(relPath, knipDeadSet, importerMap, root, verdicts = FINDING_VERDICTS, entryPoints = NO_ENTRY_POINTS) {
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

  /*
    A runner entry point has no importer BY DEFINITION, so it reaches here with
    the importer loop having found nothing — and before this it fell straight
    through to DEAD. The root set and its transitive closure are derived in
    `discoverEntryPoints` from the jest configs and `package.json` scripts, never
    from a suffix written here; see the header. The graph still answers first, so
    this can only rescue a file the importer loop already gave up on.
  */
  const entryLabel = entryPoints.roots.get(relPath);
  if (entryLabel) return { cls: "RETAINED-BY-CONVENTION", reason: `runner entry point — ${entryLabel}` };

  const via = entryPoints.reached.get(relPath);
  if (via) return { cls: "RETAINED-BY-CONTRACT", reason: `reachable from the entry point ${via}` };

  /*
    The ledger is consulted LAST, and only for a file the module graph has
    already found no live importer for. Before this the only exit from a dead
    file was `rm`, which is the wrong instrument twice over: a file whose
    consumer a merge deleted, and a file that IS the capability somebody has not
    connected yet, both read as garbage and both get thrown away. The FAIL line
    has always said "Delete them, or explain why they stand" while offering no
    way to say the second half.

    It is the same fail-closed mechanism the symbol findings use, not a
    suppression list: an unclassified dead file still exits 1, a `file:` verdict
    knip stops reporting is STALE and also exits 1, and the reason is prose
    somebody has to write. It cannot rescue a file the graph thinks is live,
    because the graph answers first.
  */
  const verdict = verdicts.get(`file:${relPath}`);
  if (verdict) return { cls: verdict.verdict, reason: verdict.reason };

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

/**
 * The entry-point model, exercised end to end against a synthetic checkout with
 * a real `package.json` and a real second jest config on disk.
 *
 * Every case here is paired. Proving a test file goes live proves nothing on its
 * own — a blanket `test/**` exclusion would pass all of it — so each positive
 * sits beside a sibling in the same directory, with the same extension, that no
 * configuration names and which must STILL be reported (BE-141). The pairs are
 * what separate "the gate learned where the roots are" from "the gate stopped
 * looking at tests".
 */
function runEntryPointSelfTest() {
  const fixture = join(tmpdir(), `api-dead-code-entry-self-test-${Date.now()}`);
  const w = (rel, body) => {
    const abs = join(fixture, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    return abs;
  };

  try {
    w("package.json", JSON.stringify({
      scripts: {
        "perf:run": "node test/perf/run-measurement.mjs",
        lint: 'eslint "src/**/*.ts"',
        "test:extra": "jest --config ./jest-extra.json",
        "db:gen": "drizzle-kit generate --config drizzle.config.ts",
      },
      jest: {
        rootDir: ".",
        roots: ["<rootDir>/src"],
        testRegex: "\\.spec\\.ts$",
        testPathIgnorePatterns: ["node_modules", "e2e-spec", "/legacy/"],
        setupFiles: ["dotenv/config", "<rootDir>/src/test/unit-setup.ts"],
        moduleNameMapper: { "^test/(.*)$": "<rootDir>/test/$1" },
      },
    }, null, 2));

    w("jest-extra.json", JSON.stringify({
      rootDir: ".",
      testMatch: ["<rootDir>/test/**/*.seeded-e2e-spec.ts"],
      setupFiles: ["<rootDir>/test/helpers/arm-egress.setup.ts"],
      testResultsProcessor: "./test/exit-guard.cjs",
      moduleNameMapper: { "^test/(.*)$": "<rootDir>/test/$1" },
    }, null, 2));

    w("drizzle.config.ts", "export default {};\n");
    w("src/thing.spec.ts", "describe('thing', () => {});\n");
    w("src/thing.e2e-spec.ts", "describe('thing e2e', () => {});\n");
    w("src/legacy/old.spec.ts", "describe('old', () => {});\n");
    w("test/outside-roots.spec.ts", "describe('outside', () => {});\n");
    w("src/test/unit-setup.ts", "export const setup = 1;\n");
    w("src/test/rogue-setup.ts", "export const rogue = 1;\n");
    w("test/exit-guard.cjs", "module.exports = (r) => r;\n");
    w("test/helpers/arm-egress.setup.ts", "export const armed = true;\n");
    w("test/widget.seeded-e2e-spec.ts",
      'import { world } from "test/helpers/shared-world";\ndescribe("widget", () => { world(); });\n');
    w("test/helpers/shared-world.ts", 'import { seed } from "./deep-fixture";\nexport const world = () => seed;\n');
    w("test/helpers/deep-fixture.ts", "export const seed = 1;\n");
    w("test/helpers/orphan-helper.ts", "export const orphan = 1;\n");
    w("test/perf/run-measurement.mjs", "export const measure = 1;\n");
    w("test/perf/unrun-measurement.mjs", "export const unrun = 1;\n");

    const pkg = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8"));
    const { configs, unreadable } = discoverJestConfigs(fixture, pkg);

    assert(unreadable.length === 0,
      `(ac) \`--config\` must only be harvested from a command that runs jest — it is a near-universal CLI flag, and harvesting \`drizzle-kit --config drizzle.config.ts\` failed the real gate as an unparseable jest config; got unreadable [${unreadable.join(",")}]`);
    assert(configs.length === 2 && configs.some((c) => c.label === "package.json#jest") && configs.some((c) => c.label === "jest-extra.json"),
      `(ad) both the package.json jest key and the second config on disk must be discovered — a fourth jest project must be followed without editing this file; got [${configs.map((c) => c.label).join(",")}]`);

    const mappers = configs.flatMap(({ config }) => compileModuleNameMappers(config));
    const helperDir = join(fixture, "test");
    assert(findFile("test/helpers/shared-world", helperDir, fixture, mappers) === join(fixture, "test", "helpers", "shared-world.ts"),
      "(ae) a bare specifier must resolve through the config's moduleNameMapper — every e2e spec imports its helpers this way and without it no edge is recorded");
    assert(findFile("test/helpers/shared-world", helperDir, fixture, []) === null,
      "(af) the SAME specifier must resolve to nothing with no mappers — this is the edge the helpers were dying on, so the mapper has to be doing the work rather than a path coincidence");
    assert(findFile("nowhere/shared-world", helperDir, fixture, mappers) === null,
      "(ag) a bare specifier no mapper pattern matches must still resolve to nothing — the mapper may not become a blanket path search");

    const { map: eMap, forward: eForward, files: eFiles } = buildImporterMap(fixture, mappers);
    const eRoots = discoverEntryPoints(fixture, pkg, configs, eFiles);
    const eReached = reachableFromEntryPoints(fixture, eRoots, eForward);
    const eEntry = { roots: eRoots, reached: eReached };

    const expectedRoots = [
      "drizzle.config.ts",
      "src/test/unit-setup.ts",
      "src/thing.spec.ts",
      "test/exit-guard.cjs",
      "test/helpers/arm-egress.setup.ts",
      "test/perf/run-measurement.mjs",
      "test/widget.seeded-e2e-spec.ts",
    ];
    assert([...eRoots.keys()].sort().join(",") === expectedRoots.join(","),
      `(ah) the derived root set must be EXACTLY the files a config or a script names — nothing wider. Expected [${expectedRoots.join(",")}], got [${[...eRoots.keys()].sort().join(",")}]`);

    const allDead = new Set([
      ...expectedRoots, "src/thing.e2e-spec.ts", "src/legacy/old.spec.ts", "test/outside-roots.spec.ts",
      "src/test/rogue-setup.ts", "test/helpers/shared-world.ts", "test/helpers/deep-fixture.ts",
      "test/helpers/orphan-helper.ts", "test/perf/unrun-measurement.mjs",
    ]);
    const cls = (rel) => classifyFile(rel, allDead, eMap, fixture, new Map(), eEntry).cls;

    assert(cls("test/widget.seeded-e2e-spec.ts") === "RETAINED-BY-CONVENTION",
      `(ai) a file a jest config selects as a test must be live — this exact suffix is the one the old hard-coded \`\\.e2e-spec\\.ts$\` alternative missed for 165 files, because it ends in -spec.ts and not .spec.ts; got ${cls("test/widget.seeded-e2e-spec.ts")}`);
    assert(cls("src/thing.e2e-spec.ts") === "DEAD",
      `(aj) a spec-shaped file NO config selects must still be reported — it is a test nothing runs, which is the defect, and it is the negative that stops (ai) from being satisfied by a blanket test-file exclusion; got ${cls("src/thing.e2e-spec.ts")}`);
    assert(cls("test/outside-roots.spec.ts") === "DEAD",
      `(ak) a file matching a config's testRegex but sitting outside that config's \`roots\` must stay reported — jest would not collect it, so neither may the gate; got ${cls("test/outside-roots.spec.ts")}`);
    assert(cls("src/legacy/old.spec.ts") === "DEAD",
      `(al) a file matching testRegex inside \`roots\` but excluded by testPathIgnorePatterns must stay reported — the ignore list is part of what jest runs and dropping it would make the model wider than the runner; got ${cls("src/legacy/old.spec.ts")}`);

    assert(cls("src/test/unit-setup.ts") === "RETAINED-BY-CONVENTION",
      `(am) a file a config names in setupFiles must be live — this is why src/test/jest-db-setup.ts is caught for the right reason rather than by a guessed *.setup.ts glob; got ${cls("src/test/unit-setup.ts")}`);
    assert(cls("src/test/rogue-setup.ts") === "DEAD",
      `(an) a setup-shaped file in the same directory that no config names must stay reported; got ${cls("src/test/rogue-setup.ts")}`);
    assert(eRoots.get("test/exit-guard.cjs")?.includes("testResultsProcessor"),
      `(ao) a testResultsProcessor is a root for the reason named by its field, not by its extension; got ${eRoots.get("test/exit-guard.cjs")}`);

    assert(cls("test/helpers/shared-world.ts") === "RETAINED-BY-CONTRACT",
      `(ap) a helper imported only by an entry point must go live TRANSITIVELY, because a root reaches it — not because it lives under test/helpers/; got ${cls("test/helpers/shared-world.ts")}`);
    assert(cls("test/helpers/deep-fixture.ts") === "RETAINED-BY-CONTRACT",
      `(aq) reachability must propagate past the first hop — entry -> helper -> fixture; got ${cls("test/helpers/deep-fixture.ts")}`);
    assert(cls("test/helpers/orphan-helper.ts") === "DEAD",
      `(ar) a helper in the SAME directory that nothing imports must stay reported — this is the negative that proves (ap) is reachability and not a path prefix; got ${cls("test/helpers/orphan-helper.ts")}`);

    assert(cls("test/perf/run-measurement.mjs") === "RETAINED-BY-CONVENTION",
      `(as) a standalone script a package.json script runs is live — the script IS its entry point; got ${cls("test/perf/run-measurement.mjs")}`);
    assert(cls("test/perf/unrun-measurement.mjs") === "DEAD",
      `(at) a measurement script in the same directory that no package.json script runs must stay reported — living under test/perf/ is not an invocation; got ${cls("test/perf/unrun-measurement.mjs")}`);
    assert(![...eRoots.keys()].some((rel) => rel.includes("*")),
      "(au) a shell glob in a script command is not a file and must never become a root — lint's source glob would otherwise root the whole repository");

    assert(classifyFile("test/widget.seeded-e2e-spec.ts", allDead, eMap, fixture, new Map()).cls === "DEAD",
      "(av) with no entry-point set supplied the same file is DEAD again — CONVENTION_FILE_RE no longer carries a spec suffix, so this proves the derived roots are the only thing keeping tests alive and a regression in discovery cannot hide behind the old regex");

    const liveImporter = join(fixture, "src", "live.ts");
    const shadowed = new Map([[join(fixture, "test", "helpers", "orphan-helper.ts"),
      { sideEffect: new Set(), named: new Set([liveImporter]), reexport: new Set(), dynamic: new Set() }]]);
    assert(classifyFile("test/helpers/orphan-helper.ts", allDead, shadowed, fixture, new Map(), eEntry).cls === "RETAINED-BY-CONTRACT",
      "(aw) the module graph still answers before the entry-point model, so the ordering of the rescues is unchanged");

    const brokenDir = join(fixture, "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "package.json"), "{}");
    writeFileSync(join(brokenDir, "jest.config.ts"), "export default { testRegex: '.*' };\n");
    writeFileSync(join(brokenDir, "jest-malformed.json"), "{ not json");
    const broken = discoverJestConfigs(brokenDir, { scripts: {} });
    assert(broken.unreadable.length === 2,
      `(ax) a jest config this gate cannot parse must be REPORTED, never skipped — skipping it drops every root it declares and the gate starts calling live suites dead; got [${broken.unreadable.join(",")}]`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
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

  const fileLedger = new Map([["file:src/awaits-a-caller.ts", { verdict: "WIRE", reason: "test" }]]);
  assert(classifyFile("src/awaits-a-caller.ts", new Set(["src/awaits-a-caller.ts"]), new Map(), root, fileLedger).cls === "WIRE",
    "(h2) a dead file with a file: verdict carries that verdict — otherwise the only exit is `rm`, and a capability whose caller a merge deleted gets thrown away");
  assert(classifyFile("src/nobody-argued-for-me.ts", new Set(["src/nobody-argued-for-me.ts"]), new Map(), root, fileLedger).cls === "DEAD",
    "(h3) a dead file with no verdict stays DEAD, so the file ledger is fail-closed like the symbol one");
  assert(classifyFile("src/awaits-a-caller.ts", new Set(["src/awaits-a-caller.ts"]),
    new Map([[join(root, "src", "awaits-a-caller.ts"), { sideEffect: new Set(), named: new Set([liveEntry]), reexport: new Set(), dynamic: new Set() }]]),
    root, fileLedger).cls === "RETAINED-BY-CONTRACT",
    "(h4) the module graph answers before the ledger — a file verdict may never overrule a live importer");

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

  runEntryPointSelfTest();

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
    "  (h2) dead file with a file: verdict              -> that verdict",
    "  (h3) dead file with no verdict                   -> DEAD (gate bites)",
    "  (h4) file verdict vs a live importer             -> RETAINED-BY-CONTRACT (graph wins)",
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
    "  (ac) every jest config on disk parses            -> no silent root loss",
    "  (ad) jest configs discovered from disk + package.json (not a list here)",
    "  (ae) bare specifier via moduleNameMapper         -> resolved",
    "  (af) same specifier with no mappers              -> unresolved (mapper does the work)",
    "  (ag) bare specifier no mapper matches            -> unresolved",
    "  (ah) derived root set is exactly the named files",
    "  (ai) file a jest config selects as a test        -> RETAINED-BY-CONVENTION",
    "  (aj) spec-shaped file no config selects          -> DEAD (gate bites)",
    "  (ak) test file outside the config's roots        -> DEAD (gate bites)",
    "  (al) test file hit by testPathIgnorePatterns     -> DEAD (gate bites)",
    "  (am) file named in setupFiles                    -> RETAINED-BY-CONVENTION",
    "  (an) setup-shaped file no config names           -> DEAD (gate bites)",
    "  (ao) testResultsProcessor rooted by its field, not its extension",
    "  (ap) helper imported only by an entry point      -> RETAINED-BY-CONTRACT",
    "  (aq) reachability propagates past the first hop",
    "  (ar) helper imported by nothing                  -> DEAD (gate bites)",
    "  (as) file a package.json script runs             -> RETAINED-BY-CONVENTION",
    "  (at) sibling script nothing runs                 -> DEAD (gate bites)",
    "  (au) shell glob in a script command              -> never a root",
    "  (av) same test file with no entry-point set      -> DEAD (no regex fallback left)",
    "  (aw) live importer still beats the entry-point model",
    "  (ax) unparseable jest config                     -> reported (fail-closed)",
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

  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  } catch (error) {
    console.error(`FAIL: package.json is unreadable (${error.message}) — every script entry point would be invisible.`);
    process.exit(1);
  }

  const { configs, unreadable } = discoverJestConfigs(ROOT, pkg);
  if (unreadable.length) {
    console.error(
      `FAIL: ${unreadable.length} jest config(s) this gate cannot parse: ${unreadable.join(", ")}. ` +
      `Every test they select would be reported dead and deleted on this gate's word. ` +
      `Teach \`discoverJestConfigs\` to read them, or express the projects as JSON.`,
    );
    process.exit(1);
  }

  const mappers = configs.flatMap(({ config }) => compileModuleNameMappers(config));
  const { map: importerMap, forward, files, filesWalked } = buildImporterMap(ROOT, mappers);
  const entryRoots = discoverEntryPoints(ROOT, pkg, configs, files);
  const entryPoints = { roots: entryRoots, reached: reachableFromEntryPoints(ROOT, entryRoots, forward) };
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

  const seenKeys = new Set();

  for (const relPath of deadFiles) {
    seenKeys.add(`file:${toFwd(relPath)}`);
    const { cls, reason } = classifyFile(toFwd(relPath), knipDeadSet, importerMap, ROOT, FINDING_VERDICTS, entryPoints);
    push(cls, `  [file] ${relPath}  — ${reason}`);
  }

  const sourceIndex = buildSymbolIndex(ROOT, schemaNamesFor(findings, ROOT));

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
    `=== entry points: ${entryRoots.size} root(s) from ${configs.length} jest config(s) ` +
    `(${configs.map(({ label }) => label).join(", ")}) and package.json scripts, reaching ` +
    `${entryPoints.reached.size} further file(s) ===`,
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
