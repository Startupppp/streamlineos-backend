#!/usr/bin/env node
/**
 * Zero-growth ledger for forced typing in application code.
 *
 * Root CLAUDE.md §6 says never force a type. The measured reality at head is
 * that application code is already close to that: **zero `as any`, zero
 * `@ts-ignore`, zero `@ts-expect-error`, zero `@ts-nocheck`** anywhere under
 * `src/` outside the spec suite. What remains is 26 `as unknown as` sites, and
 * they are not all the same thing — roughly half are a genuine seam against
 * something outside the type system (a raw SQL row, a Drizzle client built by a
 * standalone script, an Express internal), and roughly half are a JSONB column
 * that should be parsed with Zod instead.
 *
 * Both halves are recorded below with the distinction stated, because a bare
 * count cannot tell them apart and a reviewer six months from now cannot either.
 *
 * The gate has two rules:
 *
 *  1. **Hard zero** for `as any`, `@ts-ignore`, `@ts-expect-error` and
 *     `@ts-nocheck` across **all of `src/`, the spec suite included**. There is
 *     no ledger for these; the count is zero today and any reintroduction
 *     fails.
 *
 *     The spec half of that corpus is new, and it was never a formality. This
 *     rule spent a release reading only application code and reporting
 *     `as any: 0` over a tree that held **159 of them in 28 spec files** — a
 *     clean number produced by a scan that could not see, which is the exact
 *     failure mode this gate exists to catch. Rule 4's own header admitted the
 *     hole in writing while the headline kept printing zero. A spec is where a
 *     forced type does the most damage, because ts-jest runs
 *     `isolatedModules`: nothing typechecks a spec at run time, so `as any` on
 *     a constructor stub let a mock name a method the real service does not
 *     have and the test went green asserting nothing. Widening cost nothing —
 *     rule 1 has no ledger to grow — and every one of those 159 sites is gone.
 *
 *     Rules 2-4 stay OUT of the spec suite, deliberately: 3,000-odd spec-side
 *     `as unknown as` are a mocking-strategy decision and would need a ledger
 *     of their own.
 *  2. **Zero growth** for `as unknown as`. Every file holding one is listed with
 *     its count, its seam and the invariant that makes the cast survivable. A
 *     new file, or an existing file gaining a site, fails. A file that *loses* a
 *     site also fails — with the new lower number to write down — so the ledger
 *     ratchets down and can never quietly hold a number that is no longer true.
 *
 * Scope for rules 2-4 is application code: `src/**` excluding `*.spec.ts`,
 * `*.e2e-spec.ts`, `__tests__/`, `__mocks__/` and `*spec-fixtures.ts`. Rule 1
 * runs over that PLUS the spec suite those exclusions name — two walks, two
 * anti-vacuity floors, reported separately so neither can hide behind the
 * other's number.
 *
 * Flags:
 *   --self-test   Run the classifier against synthetic fixtures and exit.
 *   --list        Print the current per-file counts and exit 0. Use this to
 *                 produce the numbers a ledger update needs.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../", import.meta.url));

/** A scan that suddenly finds nothing is far likelier to be broken than the tree clean. */
const SCAN_FLOOR_FILES = 2000;

/**
 * The same floor for rule 1's second corpus, the spec suite. It is measured
 * separately because the two walks exclude each other by construction: a single
 * combined count would let one walk collapse to zero while the other carried
 * the total over the line, which is precisely the "reports clean over a
 * near-empty corpus" failure this release keeps finding. 2,164 spec-suite files
 * at head.
 */
const SCAN_FLOOR_SPEC_FILES = 1500;

/**
 * Patterns that appear in CODE. These are counted with comments stripped, so a
 * comment discussing a cast is never mistaken for one.
 */
const BANNED_IN_CODE = {
  "as any": /(?<![\w$])as\s+any(?![\w$])/g,
};

/**
 * Patterns that appear in COMMENTS, because that is the only place TypeScript
 * reads them. These MUST be matched in the raw source.
 *
 * This split is a correction. All four escapes were previously counted with
 * `countOutsideComments`, which strips comments before matching — and a
 * suppression directive is only ever written inside a comment. So rule 1 was
 * structurally incapable of ever firing for the three directives: it reported
 * zero on a file whose first line is `// @ts-ignore`. The count was zero
 * because the check could not see, not because the tree was clean. Only
 * `as any`, which appears in code, was genuinely enforced.
 *
 * Anchoring to the start of the comment is what keeps prose honest.
 * TypeScript only honours a directive that begins the comment, so
 * `// @ts-ignore` is a real suppression while `// we ship zero @ts-ignore` is a
 * sentence, and only the first matches.
 */
const BANNED_DIRECTIVES = {
  "@ts-ignore": /(?:\/\/|\/\*)\s*@ts-ignore\b/g,
  "@ts-expect-error": /(?:\/\/|\/\*)\s*@ts-expect-error\b/g,
  "@ts-nocheck": /(?:\/\/|\/\*)\s*@ts-nocheck\b/g,
};

const DOUBLE_CAST = /\bas\s+unknown\s+as\b/g;

/**
 * Skipped ANYWHERE under `src/`: these names never denote application source.
 */
const SKIP_DIRS = new Set(["__tests__", "__mocks__", "node_modules"]);

/**
 * Skipped ONLY at the root of the walk (`src/` itself), because these are build
 * output *there* and could be ordinary source anywhere else.
 *
 * This split is a hardening, not a bug fix: there is no `src/**\/dist` or
 * `src/**\/coverage` in the tree today, so the depth-blind form was not hiding
 * anything at head. It was a LATENT instance of the exact failure this release
 * keeps finding — the frontend half of this same gate matched `build` by name
 * at any depth and silently excluded `features/build/`, 456 files and the
 * product's largest module, from every rule while reporting a clean scan. The
 * backend already holds `src/modules/build`, `src/modules/public` and
 * `src/db/schema/build`; the day someone adds `src/modules/x/dist/` the
 * depth-blind form would drop it without a word. Pinned in both directions by
 * self-test (ak)/(al)/(am).
 */
const SKIP_ROOT_DIRS = new Set(["dist", "coverage"]);

export function isSkippedDir(name, depth) {
  if (SKIP_DIRS.has(name)) return true;
  return depth === 0 && SKIP_ROOT_DIRS.has(name);
}
const SKIP_FILE = /(\.spec\.ts|\.e2e-spec\.ts|\.db\.spec\.ts|\.test\.ts|spec-fixtures\.ts|\.d\.ts)$/;

/**
 * The spec suite, stated as the exact complement of the application walk so the
 * two corpora cannot silently overlap or leave a gap between them: a file is
 * spec-suite if the application walk would refuse it for being a spec, OR if it
 * sits under a `__tests__`/`__mocks__` directory at any depth.
 *
 * `.d.ts` belongs to NEITHER. A declaration file holds no expressions, so
 * `as any` cannot appear in one; it is excluded by construction rather than by
 * oversight, and self-test (aq) pins that.
 */
const SPEC_ONLY_FILE = /(\.spec\.ts|\.e2e-spec\.ts|\.db\.spec\.ts|\.test\.ts|spec-fixtures\.ts)$/;
const TEST_DIRS = new Set(["__tests__", "__mocks__"]);

export function isSpecSuiteFile(name, insideTestDir) {
  if (!name.endsWith(".ts") || name.endsWith(".d.ts")) return false;
  return insideTestDir || SPEC_ONLY_FILE.test(name);
}

/**
 * file -> { count, seam, invariant }
 *
 * `seam` is one of:
 *   external   — the value genuinely arrives from outside the type system and
 *                nothing inside it can describe the shape. Legitimate.
 *   narrow-me  — the value is ours and the shape is knowable. The cast stands
 *                in for a Zod parse that has not been written. Debt.
 */
const DOUBLE_CAST_LEDGER = new Map([
  // -- external: a standalone script builds a Drizzle client or a stub service --
  ["src/scripts/benchmark-access-service.ts", { count: 4, seam: "external", test: "src/scripts/__tests__/assertion-seam-contracts.spec.ts::keeps every ledgered standalone script out of the application import graph", invariant: "a benchmark harness stands up one real Db plus three hand-built stubs (cache, entitlements, MFA policy) to time AccessService in isolation. The stubs implement only the methods the measured path calls; the cast is what lets a four-method object stand where a full service is declared. It never runs in the application." }],
  ["src/scripts/check-declaration-column-drift.ts", { count: 4, seam: "external", test: "src/scripts/__tests__/assertion-seam-contracts.spec.ts::keeps the Drizzle schema barrel walkable as a flat record of inspectable tables", invariant: "the same two seams as check-set-null-column-lists.ts, in a second reflective gate: two casts hand the Drizzle schema barrel to a walker as `Record<string, unknown>`, and two type the rows of a `sql.unsafe` catalog query, which postgres.js returns untyped by construction. A pg_catalog row has no compile-time shape. ARRIVED UNTRACKED from another lane on 2026-09-03; if that lane drops the file this entry goes stale and the gate will say so, which is the intended behaviour." }],
  ["src/scripts/check-set-null-column-lists.ts", { count: 4, seam: "external", test: "src/scripts/__tests__/assertion-seam-contracts.spec.ts::keeps the Drizzle schema barrel walkable as a flat record of inspectable tables", invariant: "two casts hand the Drizzle schema barrel to a reflective walker as `Record<string, unknown>`; two more type the rows of a `sql.unsafe` catalog query, which postgres.js returns untyped by construction. Both are outside the type system by definition — a pg_catalog row has no compile-time shape." }],
  ["src/scripts/verify-cell-degraded-control-plane.ts", { count: 1, seam: "external", test: "src/scripts/__tests__/assertion-seam-contracts.spec.ts::builds a standalone client that exposes the surface the app's Db alias is used through", invariant: "`drizzle(client, { schema })` instantiates to a structurally identical but nominally different type than the app's `Db` alias. The script needs the app alias to call app services. No runtime narrowing is possible or useful." }],
  ["src/scripts/verify-cell-admission.ts", { count: 1, seam: "external", test: "src/scripts/__tests__/assertion-seam-contracts.spec.ts::builds a standalone client that exposes the surface the app's Db alias is used through", invariant: "same Drizzle instantiation seam as verify-cell-degraded-control-plane.ts." }],
  ["src/scripts/seed-permissions.ts", { count: 1, seam: "external", test: "src/scripts/__tests__/assertion-seam-contracts.spec.ts::builds a standalone client that exposes the surface the app's Db alias is used through", invariant: "same Drizzle instantiation seam; a seed script constructing its own client." }],
  ["src/test/sql-predicate.ts", { count: 2, seam: "external", test: "src/scripts/__tests__/assertion-seam-contracts.spec.ts::still reads drizzle-orm's private SQL chunk shape, and says so by matching", invariant: "reads Drizzle's internal SQL AST node shape, which the library does not export. Test-support code for asserting that a predicate was built, not application code, and it breaks loudly on a Drizzle upgrade rather than silently." }],
]);

/**
 * ---------------------------------------------------------------------------
 * Rule 3: the raw-SQL row generic, `db.execute<T>(sql`...`)`.
 * ---------------------------------------------------------------------------
 *
 * This is a type assertion that does not contain the word `as`, which is why
 * neither of the two rules above has ever seen one. Drizzle declares
 * `execute<T extends Record<string, unknown>>(): Promise<T[]>` and hands the
 * driver rows straight back: nothing validates that the columns the caller
 * named in `T` are the columns the query selected. Shared CLAUDE.md section 6
 * says exactly this — raw rows are `Record<string, unknown>` and are converted
 * at the use site — so a `<T>` here is the forced type the rule forbids,
 * written in a syntax the ban could not detect.
 *
 * It is the same defect shape that shipped twice in this release on the
 * frontend half of the same seam (`apiClient.get<Channel>`, `get<Huddle>`): the
 * projection did not select what the declared type promised, both repositories
 * typechecked clean, and the field arrived `undefined`.
 *
 * So this rule does two things, and the second is the one that bites:
 *
 *   (a) a per-file zero-growth ledger, same ratchet as rule 2; and
 *   (b) for every site where the type argument is a type literal AND the query
 *       is a `sql` template in the same call, a static cross-check that every
 *       property the type declares is actually selected by that SQL — and that
 *       a camelCase property is not relying on an UNQUOTED alias, which
 *       Postgres folds to lower case and which therefore arrives under a
 *       different key than the type says. 25 of the 28 sites are checkable
 *       this way; the 3 that are not compose their SQL or name a type alias,
 *       and are ledgered instead.
 */
const RAW_ROW_LEDGER = new Map([
  ["src/common/db/bulk-update.ts", { count: 1, seam: "external", invariant: "a `RETURNING` clause on a generated bulk UPDATE. The driver returns untyped rows; the single declared column `key` is cross-checked against the SQL by rule 3b, so a rename of the returned column fails this gate rather than silently yielding undefined keys." }],
  ["src/common/db/expand-contract-compat.ts", { count: 2, seam: "external", invariant: "`to_regclass(...) IS NOT NULL AS \"relationAvailable\"` — a pg_catalog probe. A catalog row has no compile-time shape. Both aliases are DOUBLE-QUOTED, which is what makes the camelCase key survive Postgres identifier folding; rule 3b asserts that quoting, so removing the quotes fails the gate." }],
  ["src/modules/ai/core/ops-copilot-tools.ts", { count: 2, seam: "external", invariant: "two aggregate probes behind AI copilot tools; all declared keys are snake_case columns selected verbatim, cross-checked by rule 3b." }],
  ["src/modules/ai/core/services/hr-helpdesk-ai.service.ts", { count: 2, seam: "external", invariant: "an employment/person join read for AI helpdesk context: SELECT p.first_name, p.last_name, e.designation FROM hr_employments e JOIN hr_people p. Every declared key is a snake_case column selected verbatim and nullable, so rule 3b proves the projection supports the type. Replaces a `empRows[0] as Record<string, unknown>` that let a renamed column read as undefined." }],
  ["src/modules/ai/core/services/hr-policy-ai.service.ts", { count: 2, seam: "external", invariant: "the active-policy shortlist backing policy Q&A, read twice (buffered and streaming): SELECT id, policy_type, name FROM hr_policies. All three keys are selected verbatim; cross-checked by rule 3b. Replaces a `rows as Array<Record<string, unknown>>` that hid the projection from the gate." }],
  ["src/modules/ai/core/workspace-copilot-tools.ts", { count: 1, seam: "external", invariant: "a per-project rollup aggregate; snake_case keys selected verbatim, cross-checked by rule 3b." }],
  ["src/modules/directory/reporting-line-coverage.ts", { count: 3, seam: "external", invariant: "HRM-15 manager-coverage report: totals, fallback and pending-review reads over hr_reporting_lines. FILTER aggregates the Drizzle query builder cannot express. Moved out of reporting-line.service.ts (which carried these sites unledgered at base b88611030); every declared key is snake_case and selected verbatim, cross-checked by rule 3b." }],
  ["src/modules/directory/reporting-line-coverage-lists.ts", { count: 4, seam: "external", invariant: "HRM-15 manager-coverage exception lists: without-manager, inactive-manager, circular (a WITH RECURSIVE walk) and over-span reads over hr_reporting_lines, split out of reporting-line-coverage.ts. Recursive CTEs and GROUP BY/HAVING the Drizzle query builder cannot express; every declared key is snake_case and selected verbatim, cross-checked by rule 3b." }],
  ["src/modules/directory/reporting-line-queries.ts", { count: 3, seam: "external", invariant: "HRM-15 canonical relationship reads: current and scheduled lines per employment, the rolling 24h primary-change count (a UNION over hr_reporting_lines and hr_reporting_lines_superseded), and the transactional cycle check (WITH RECURSIVE). These replaced the per-writer cycle CTEs formerly ledgered on hr-effective-change-applier.service.ts. Snake_case keys selected verbatim; cross-checked by rule 3b." }],
  ["src/modules/hr/interviews/hr-interviews.service.ts", { count: 2, seam: "external", invariant: "a paginated interview list with a window `total_count`, and an id probe. All keys snake_case and selected verbatim; cross-checked by rule 3b." }],
  ["src/modules/inventory/counts/inv-cycle-counts.service.ts", { count: 1, seam: "external", invariant: "a stock-level snapshot for a cycle count: SELECT sl.product_variant_id, sl.location_id, sl.lot_id, sl.on_hand FROM inv_stock_levels. Every declared key is a snake_case column selected verbatim, so rule 3b proves the projection supports the type. Inventory is outside the release SCOPE but is still application code for this gate." }],
  ["src/modules/inventory/purchase-orders/grn-receive.service.ts", { count: 1, seam: "external", invariant: "SELECT quantity, quantity_received FROM inv_po_lines ... FOR UPDATE — the row lock that makes goods receipt idempotent. Both declared keys are selected verbatim; cross-checked by rule 3b." }],
  ["src/modules/inventory/stock-engine/costing-context.ts", { count: 1, seam: "external", invariant: "SELECT DISTINCT ON (product_variant_id) product_variant_id, unit_cost FROM inv_standard_costs — a DISTINCT ON that Drizzle\u2019s query builder cannot express. Both declared keys are selected verbatim; cross-checked by rule 3b." }],
  ["src/modules/inventory/stock-engine/reservation.service.ts", { count: 1, seam: "external", invariant: "the `SELECT ... FOR UPDATE OF sl` row lock that reserves stock: inv_stock_levels joined to inv_locations, under a `committedGrainPredicate` the query builder cannot express. Every declared key is a snake_case column selected verbatim (including `ownership`, whose absence made a consigned row compute as if it were ours) and cross-checked by rule 3b. Lowered 4 -> 1 on 2026-09-12: the other three locks were absorbed into the shared stock-engine reads." }],
  ["src/modules/inventory/stock-engine/valuation.service.ts", { count: 1, seam: "external", invariant: "the FIFO layer read over inv_valuation_layers (id, remaining_quantity, quantity) that a reversal locks before it unwinds a layer — `FOR UPDATE` ordering the query builder cannot express. All three keys are selected verbatim; cross-checked by rule 3b. Lowered 2 -> 1 on 2026-09-12: the second read is gone." }],
  ["src/modules/build/core/projects-tickets-update.service.ts", { count: 1, seam: "external", invariant: "a `WITH RECURSIVE chain(id, next_id, project_id, depth)` walk that detects a cycle in the ticket next/previous chain before a reorder commits. A recursive CTE is not expressible in the Drizzle query builder. All four declared keys are the CTE column list itself and are selected verbatim; cross-checked by rule 3b." }],
  ["src/modules/organization/hierarchy/org-hierarchy-dependencies.service.ts", { count: 2, seam: "external", invariant: "one catalog probe (cross-checked), and one whose SQL is composed with `sql.join(this.buildQueries(...))` and whose type is the named alias `DependencyCountRow` — neither the keys nor the SQL is statically readable at the call, so it is ledgered. Its consumer reads `row.key` and `row.count` and coerces the count with Number()." }],
  ["src/scripts/backfill-financial-actors.ts", { count: 1, seam: "external", invariant: "a one-shot backfill script; snake_case keys selected verbatim, cross-checked by rule 3b." }],
  ["src/scripts/backfill-workflow-secrets.ts", { count: 1, seam: "external", invariant: "the type argument is the named alias `PlaintextRow`, so rule 3b cannot read its members. A one-shot backfill script that never runs in the application." }],
]);

/**
 * Reads `<something>.execute<T>(...)` call sites out of one file. Regex is not
 * usable here: a type argument spans lines, nests braces and contains commas,
 * and the SQL template it must be compared against is a second argument. This
 * is the one place in this gate where an AST is required rather than tidier.
 */
export function findRawRowGenerics(fileName, source) {
  if (!source.includes("execute<")) return [];
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.typeArguments?.length === 1 &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.getText(sf) === "execute"
    ) {
      const typeArg = node.typeArguments[0];
      const keys = ts.isTypeLiteralNode(typeArg)
        ? typeArg.members.filter(ts.isPropertySignature).map((m) => m.name.getText(sf).replace(/["']/g, ""))
        : null;
      const arg = node.arguments[0];
      let sqlText = null;
      if (arg && ts.isTaggedTemplateExpression(arg) && arg.tag.getText(sf) === "sql") {
        const t = arg.template;
        sqlText = ts.isNoSubstitutionTemplateLiteral(t)
          ? t.text
          : [t.head.text, ...t.templateSpans.map((s) => s.literal.text)].join(" ? ");
      }
      found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, keys, sqlText });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/**
 * Rule 3b. Returns the reasons this site's declared row type is not supported
 * by the SQL beside it. Empty array = the projection matches the declaration.
 *
 * Two failure modes, and the second is the quiet one:
 *   MISSING  — the type names a column the query does not select at all.
 *   CASEFOLD — the type names a camelCase column and the SQL aliases it
 *              UNQUOTED. Postgres folds an unquoted identifier to lower case,
 *              so the row arrives with `relationavailable` while the type
 *              promises `relationAvailable`, and every read of it is undefined.
 */
export function checkRawRowProjection(site) {
  if (!site.keys || !site.sqlText) return [];
  const reasons = [];
  for (const key of site.keys) {
    const quoted = new RegExp(`"${key}"`).test(site.sqlText);
    const bare = new RegExp(`(^|[\\s,.(])${key}(\\s|,|$|\\))`, "i").test(site.sqlText);
    if (!quoted && !bare) reasons.push(`MISSING: the type declares "${key}" but the SQL selects no such column`);
    else if (!quoted && /[A-Z]/.test(key))
      reasons.push(`CASEFOLD: "${key}" is camelCase and the SQL alias is unquoted — Postgres returns "${key.toLowerCase()}", so every read of "${key}" is undefined`);
  }
  return reasons;
}

/**
 * ---------------------------------------------------------------------------
 * Rule 4: the plain `as X` cast and the non-null `!` assertion.
 * ---------------------------------------------------------------------------
 *
 * Rules 1-3 cover four syntaxes: `as any`, the three suppression directives,
 * `as unknown as`, and `db.execute<T>`. Measured at head, those account for 30
 * of the assertions in this repository's application code. The census in
 * `reports/51-assertion-census-and-the-envelope-cast.md` found the rest, and
 * the rest is the bulk of it: **909 plain `as X` casts and 330 non-null `!`
 * assertions**. Every one of them is a type assertion in the plain meaning of
 * shared CLAUDE.md section 6 -- "Never force types. No `as X`" -- and until
 * this rule none of them was under any gate at all. The ledger was therefore
 * green over 7% of its own subject.
 *
 * This rule does NOT ask for an invariant or a negative test per site. That bar
 * belongs to rules 2 and 3, whose populations are small enough to justify one
 * each. 1,239 sites cannot each carry a written invariant, and pretending
 * otherwise is how a ledger becomes decoration. What this rule provides is the
 * one property the box actually needs and did not have: **the population cannot
 * grow.** A per-file ceiling, seeded at the head count, that fails when a file
 * gains an assertion, when a file not in the ledger acquires one, and equally
 * when an entry outlives its site.
 *
 * What is counted, stated exactly, because a scanner's silence is worthless
 * unless its reach is written down:
 *
 *   counted      `x as T`, and the angle-bracket form `<T>x` (0 today; counted
 *                so it cannot become the escape hatch when `as` is ratcheted),
 *                and `x!`.
 *   NOT counted  `x as const`. A const assertion NARROWS a literal to its own
 *                type; it cannot force one value to be a different one, so it
 *                is not the defect this rule is about. It is by far the most
 *                common `as` in the tree (793 sites here, 2,309 in the
 *                frontend), and folding it in would bury the signal under a
 *                safe idiom. Pinned by self-test (aa).
 *   NOT counted  `x satisfies T`, which checks rather than asserts.
 *   NOT counted  the `as unknown as` pair, which rule 2 owns with a written
 *                invariant each. Counting it here would make removing one cast
 *                require edits in two ledgers. Pinned by self-test (ac).
 *   NOT counted  a definite-assignment `let x!: T`, which is a declaration flag
 *                and not an expression-level assertion.
 *
 * And the hole, named rather than discovered later: this gate walks `src/`
 * only, minus the spec suite (see SKIP_FILE). `test/`, `evals/` and all 1,930
 * spec files are outside it. ts-jest runs `isolatedModules`, so a spec is not
 * typechecked by anything and can forge any shape it likes; the 2,756
 * spec-side `as unknown as` are counted in the ticket and enforced NOWHERE.
 * That is a real gap and it is deliberate, not overlooked.
 */
const CEILING_LEDGER_PATH = fileURLToPath(new URL("./assertion-ceiling-ledger.json", import.meta.url));

/**
 * A scan that suddenly matches nothing must fail rather than report a clean
 * tree. Same reasoning as SCAN_FLOOR_FILES, one level down: that floor catches
 * a broken walker, this one catches a broken counter walking a healthy tree.
 *
 * 1000 -> 400 on 2026-09-07. The tree reached 417 and the floor started failing
 * the gate with "the counter is broken, not the tree clean" — which was no
 * longer true. Lowered only after PROVING the counter still counts: a single
 * planted `as { id: number }` in a source file moved the total 417 -> 418, and
 * removing it moved it back. A floor is a claim about the mechanism, so it may
 * only be lowered against a bite proof, never because the number under it moved.
 *
 * 400 -> 380 on 2026-09-08, to the same standard. The N+1 batching pass removed
 * 13 assertions outright — a per-rule read-modify-write became one upsert in
 * leads/lead-triggers.ts (9 -> 2), and the per-row loops in
 * cron/cron-billing.service.ts (2), cron/cron-projects.service.ts (3, replaced
 * by a real `template is RunnableTemplate` predicate) and
 * hr/directory/employee-bulk-onboarding.service.ts (1) became batched
 * statements — taking the tree 407 -> 394 and putting it under this floor. The
 * bite proof was re-run before the move, not assumed: one planted
 * `BATCH_SIZE as number` in cron-projects.service.ts took the total 394 -> 395,
 * `as X` 273 -> 274 and the file count 221 -> 222, and the gate re-attributed
 * that file from "no plain assertion left" to "tree 1"; removing the probe
 * returned all four. The counter counts, so the floor follows the tree down
 * rather than accusing it.
 */
const CEILING_FLOOR_TOTAL = 380;

function loadCeilingLedger() {
  try {
    const raw = JSON.parse(readFileSync(CEILING_LEDGER_PATH, "utf8"));
    return new Map(Object.entries(raw.files ?? {}).map(([f, v]) => [f, { count: v.as + v.nonNull, as: v.as, nonNull: v.nonNull }]));
  } catch {
    return null;
  }
}

const CEILING_LEDGER = loadCeilingLedger() ?? new Map();

/**
 * Counts plain assertions with the AST, never a regex. A regex cannot tell
 * `as const` from `as Config`, cannot tell the two halves of `as unknown as`
 * apart from two independent casts, and reads `x! + y` and `a !== b` alike.
 */
export function countPlainAssertions(fileName, source) {
  const sf = ts.createSourceFile(
    fileName, source, ts.ScriptTarget.Latest, true,
    /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let asX = 0;
  let nonNull = 0;
  let asConst = 0;

  const isConstAssertion = (t) =>
    ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.escapedText === "const";

  const visit = (node) => {
    if (ts.isAsExpression(node)) {
      if (isConstAssertion(node.type)) asConst += 1;
      else if (node.type.kind === ts.SyntaxKind.UnknownKeyword && node.parent && ts.isAsExpression(node.parent)) {
        /* the inner half of `x as unknown as T`; rule 2 owns the pair */
      } else if (ts.isAsExpression(node.expression) && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) {
        /* the outer half of the same pair */
      } else asX += 1;
    } else if (ts.isTypeAssertionExpression(node)) asX += 1;
    else if (ts.isNonNullExpression(node)) nonNull += 1;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return { asX, nonNull, asConst };
}

/**
 * Rule 1's second walk. Mirrors `walk` but keeps the spec suite and drops
 * application code, so the union of the two is every `.ts` under `src/` that is
 * not a declaration file or build output.
 */
function* walkSpecs(dir, depth = 0, insideTestDir = false) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      if (depth === 0 && SKIP_ROOT_DIRS.has(entry.name)) continue;
      yield* walkSpecs(full, depth + 1, insideTestDir || TEST_DIRS.has(entry.name));
    } else if (isSpecSuiteFile(entry.name, insideTestDir)) yield full;
  }
}

function* walk(dir, depth = 0) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isSkippedDir(entry.name, depth)) continue;
      yield* walk(full, depth + 1);
    } else if (entry.name.endsWith(".ts") && !SKIP_FILE.test(entry.name)) yield full;
  }
}

/**
 * Counts occurrences outside line comments and block comments, so that a
 * comment *describing* a cast is never counted as one. This file's own header
 * would otherwise fail the gate it implements.
 */
export function countOutsideComments(source, pattern) {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
  return [...stripped.matchAll(pattern)].length;
}

/**
 * Rule 1 over the spec suite. Only the banned escapes: no ledger, no ceiling,
 * no raw-row cross-check — those belong to application code.
 */
function scanSpecs(root) {
  const banned = new Map();
  let files = 0;
  for (const file of walkSpecs(root)) {
    files += 1;
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = `src/${relative(root, file).replace(/\\/g, "/")}`;
    for (const [name, pattern] of Object.entries(BANNED_IN_CODE)) {
      const n = countOutsideComments(source, pattern);
      if (n) banned.set(`${rel} :: ${name}`, n);
    }
    for (const [name, pattern] of Object.entries(BANNED_DIRECTIVES)) {
      const n = [...source.matchAll(pattern)].length;
      if (n) banned.set(`${rel} :: ${name}`, n);
    }
  }
  return { banned, files };
}

function scan(root) {
  const banned = new Map();
  const doubleCasts = new Map();
  const rawRows = new Map();
  const plain = new Map();
  const projectionFailures = [];
  let checkedProjections = 0;
  let files = 0;
  let asConstTotal = 0;

  for (const file of walk(root)) {
    files += 1;
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(root, file).replace(/\\/g, "/");
    for (const [name, pattern] of Object.entries(BANNED_IN_CODE)) {
      const n = countOutsideComments(source, pattern);
      if (n) banned.set(`${rel} :: ${name}`, n);
    }
    for (const [name, pattern] of Object.entries(BANNED_DIRECTIVES)) {
      const n = [...source.matchAll(pattern)].length;
      if (n) banned.set(`${rel} :: ${name}`, n);
    }
    const casts = countOutsideComments(source, DOUBLE_CAST);
    if (casts) doubleCasts.set(`src/${rel}`, casts);

    const { asX, nonNull, asConst } = countPlainAssertions(file, source);
    asConstTotal += asConst;
    if (asX || nonNull) plain.set(`src/${rel}`, { count: asX + nonNull, as: asX, nonNull });

    const sites = findRawRowGenerics(file, source);
    if (sites.length) rawRows.set(`src/${rel}`, sites.length);
    for (const site of sites) {
      if (!site.keys || !site.sqlText) continue;
      checkedProjections += 1;
      for (const reason of checkRawRowProjection(site))
        projectionFailures.push(`src/${rel}:${site.line} ${reason}`);
    }
  }

  return { banned, doubleCasts, rawRows, plain, asConstTotal, projectionFailures, checkedProjections, files };
}

export function diffLedger(actual, ledger) {
  const added = [];
  const grown = [];
  const shrunk = [];
  const gone = [];

  for (const [file, count] of actual) {
    const entry = ledger.get(file);
    if (!entry) added.push({ file, count });
    else if (count > entry.count) grown.push({ file, was: entry.count, now: count });
    else if (count < entry.count) shrunk.push({ file, was: entry.count, now: count });
  }
  for (const file of ledger.keys()) if (!actual.has(file)) gone.push(file);

  return { added, grown, shrunk, gone };
}

/**
 * Distinct self-test checks that actually executed, keyed by the `(tag)` each
 * assertion message opens with. A Set rather than a counter because several
 * checks run once per ledger entry — counting raw calls would make the floor
 * move with the ledger's size, which is exactly the kind of number that drifts
 * until it means nothing.
 */
const SELF_TEST_CHECKS = new Set();

/**
 * The self-test's OWN anti-vacuity floor.
 *
 * This is a correction to a real hole. The line below used to print a
 * hard-coded `27 assertions`, and the figure was not merely unmaintained — it
 * was already WRONG, because the list printed beneath it names 30 checks. A
 * self-test whose headline number is a string literal reports the same number
 * after someone deletes half its assertions, which makes it decoration: the
 * gate would still exit 0 while proving strictly less. The count is now
 * measured, and it is floored, so removing a check fails the self-test instead
 * of quietly shrinking it.
 */
const MIN_SELF_TEST_CHECKS = 52;

function writeCeilingLedger(map) {
  const files = {};
  for (const f of [...map.keys()].sort()) files[f] = { as: map.get(f).as, nonNull: map.get(f).nonNull };
  writeFileSync(CEILING_LEDGER_PATH, `${JSON.stringify({
    note: "Rule 4 of check-type-assertions.mjs: a per-file ZERO-GROWTH ceiling on plain `as X` and non-null `!` assertions in application code. Seeded at the head count. It may only ever go DOWN: --update-ledger refuses to raise a number, and the gate fails both when a file gains an assertion and when an entry outlives its site. `as const` is excluded by decision (it narrows, it does not force). Specs are outside this gate entirely — see the rule 4 header.",
    files,
  }, null, 2)}\n`);
}

function assert(cond, msg) {
  const tag = /^\(([A-Za-z0-9]+)\)/.exec(msg);
  SELF_TEST_CHECKS.add(tag ? tag[1] : msg);
  if (!cond) {
    console.error("SELF-TEST FAIL:", msg);
    process.exit(1);
  }
}

function runSelfTest() {
  console.log("Running self-test...\n");

  assert(countOutsideComments("const a = b as unknown as C;\n", DOUBLE_CAST) === 1,
    "(a) a real double cast must be counted");
  assert(countOutsideComments("// explains an as unknown as cast\n", DOUBLE_CAST) === 0,
    "(b) a line comment describing a cast must NOT be counted — this gate's own header depends on it");
  assert(countOutsideComments("/**\n * an as unknown as cast\n */\n", DOUBLE_CAST) === 0,
    "(c) a block comment describing a cast must NOT be counted");
  assert(countOutsideComments("const url = 'https://x/y'; const a = b as unknown as C;\n", DOUBLE_CAST) === 1,
    "(d) a `//` inside a string must not blind the rest of the line");
  assert(countOutsideComments("const x = y as any;\n", BANNED_IN_CODE["as any"]) === 1,
    "(e) `as any` must be counted");
  assert(countOutsideComments("const x: Whereas anything = 1;\n", BANNED_IN_CODE["as any"]) === 0,
    "(f) `as any` must not match inside a longer identifier");

  // The regression these three guard is the one this gate shipped with: all four
  // escapes were counted with comments stripped, so the three DIRECTIVES could
  // never fire. (e1) pins the precondition, (e2) pins the fix, (e3) pins prose.
  const directiveHits = (src, name) => [...src.matchAll(BANNED_DIRECTIVES[name])].length;
  assert(countOutsideComments("// @ts-ignore\nconst x = 1;\n", /@ts-ignore/g) === 0,
    "(e1) precondition: a comment-stripping counter CANNOT see a directive — which is why directives are matched raw");
  assert(directiveHits("// @ts-ignore\nconst x = 1;\n", "@ts-ignore") === 1
    && directiveHits("//@ts-ignore\n", "@ts-ignore") === 1
    && directiveHits("/* @ts-expect-error */\n", "@ts-expect-error") === 1
    && directiveHits("// @ts-nocheck\n", "@ts-nocheck") === 1,
    "(e2) a real suppression directive MUST be caught, with or without a space, in a line or block comment");
  assert(directiveHits("// we ship zero @ts-ignore in application code\n", "@ts-ignore") === 0,
    "(e3) prose mentioning a directive is not a directive — TypeScript only honours one that begins the comment");

  const ledger = new Map([
    ["a.ts", { count: 2, seam: "external", invariant: "x" }],
    ["b.ts", { count: 1, seam: "external", invariant: "y" }],
    ["c.ts", { count: 1, seam: "external", invariant: "z" }],
  ]);
  const d = diffLedger(new Map([["a.ts", 3], ["b.ts", 1], ["d.ts", 1]]), ledger);
  assert(d.grown.length === 1 && d.grown[0].file === "a.ts",
    "(g) a file gaining a cast must be reported as growth");
  assert(d.added.length === 1 && d.added[0].file === "d.ts",
    "(h) a file not in the ledger must be reported as new");
  assert(d.gone.length === 1 && d.gone[0] === "c.ts",
    "(i) a ledgered file with no casts left must be reported so the entry is deleted");
  assert(diffLedger(new Map([["a.ts", 1]]), ledger).shrunk[0]?.now === 1,
    "(j) a file losing a cast must be reported with its new lower number");
  assert(diffLedger(new Map([["b.ts", 1]]), new Map([["b.ts", { count: 1 }]])).grown.length === 0,
    "(k) an unchanged file must not be reported");

  for (const [file, entry] of DOUBLE_CAST_LEDGER) {
    assert(entry.seam === "external" || entry.seam === "narrow-me",
      `(l) ${file}: seam must be "external" or "narrow-me", got "${entry.seam}"`);
    assert(typeof entry.invariant === "string" && entry.invariant.length > 40,
      `(m) ${file}: every entry needs a written invariant, not a placeholder`);
  }

  // ---- C031's test clause, made enforceable ------------------------------
  // "Each exception must be … covered by a negative/runtime contract test."
  // That clause held for a whole release with ZERO mechanism: no entry named a
  // test, nothing checked that one existed, and the written invariants were
  // therefore comments. A `narrow-me` entry is by its own label NOT a permitted
  // exception, so the requirement attaches to `external` — and demoting an
  // entry is the only escape, which RAISES the "owed" count rather than
  // lowering the bar.
  // (as) is proved against a SYNTHETIC pair as well as every live entry, in both
  // directions, because the live population is now zero. Every ledgered seam is
  // `external` — the gate prints "0 owed a Zod parse" — so a check written to run
  // only per narrow-me entry stopped running the moment that debt was paid off,
  // and took the self-test below its own floor with it. Lowering the floor to
  // match would have repriced an anti-vacuity number to accommodate a check that
  // cannot fire, which is the failure MIN_SELF_TEST_CHECKS exists to catch. A
  // property must not be provable only while the debt it describes still exists.
  const narrowMeNamesNoTest = (entry) => entry.test === undefined;
  assert(narrowMeNamesNoTest({ seam: "narrow-me", count: 1, invariant: "x" })
    && !narrowMeNamesNoTest({ seam: "narrow-me", count: 1, invariant: "x", test: "a.spec.ts::t" }),
    "(as) a \"narrow-me\" entry is declared debt, not a proven seam — it must NOT name a contract test");

  const seenTestTargets = new Map();
  for (const [file, entry] of DOUBLE_CAST_LEDGER) {
    if (entry.seam !== "external") {
      assert(narrowMeNamesNoTest(entry),
        `(as) ${file}: a "narrow-me" entry is declared debt, not a proven seam — it must NOT name a contract test`);
      continue;
    }
    assert(typeof entry.test === "string" && /^[^:]+\.spec\.ts::.+$/.test(entry.test),
      `(at) ${file}: every EXTERNAL entry must name its contract test as "<spec path>::<test title>" — C031 permits an assertion only where one exists`);
    const [specPath, title] = entry.test.split("::");
    let specSource = seenTestTargets.get(specPath);
    if (specSource === undefined) {
      try {
        specSource = readFileSync(join(SRC, "..", specPath), "utf8");
      } catch {
        specSource = null;
      }
      seenTestTargets.set(specPath, specSource);
    }
    assert(specSource !== null,
      `(au) ${file}: names ${specPath}, which is not on disk. A ledger that points at a deleted spec proves nothing`);
    assert(typeof specSource === "string" && specSource.includes(title),
      `(av) ${file}: ${specPath} does not contain the test titled "${title}" — renaming or deleting a contract test must fail here, not silently un-cover the cast`);
  }

  // ---- rule 3: the raw-SQL row generic ----------------------------------
  const one = (src) => findRawRowGenerics("probe.ts", src);

  assert(one("const r = await db.execute<{ a: number }>(sql`select 1 as a`);").length === 1,
    "(n) a `db.execute<T>` call must be found");
  assert(one("const r = await tx.execute<{ a: number }>(sql`select 1 as a`);").length === 1,
    "(n1) the receiver may be a transaction, not only `db`");
  assert(one("const r = await db.execute(sql`select 1 as a`);").length === 0,
    "(o) an `execute` with NO type argument is not a forced type and must not be counted");
  assert(one("// db.execute<{ a: number }>(sql`x`)\n").length === 0,
    "(p) a commented-out call is not a call — the AST does not see comments, which is why rule 3 uses one");
  assert(one("const r = await db.execute<{\n  a: number;\n  b: string;\n}>(sql`select 1 as a, 'x' as b`)")[0].keys.join(",") === "a,b",
    "(q) a multi-line type literal must yield both keys — the reason this rule cannot be a regex");
  assert(one("const r = await db.execute<LockedRow>(sql`select 1`)")[0].keys === null,
    "(r) a NAMED type argument is not statically readable and must report keys=null so it is ledgered, not silently passed");
  assert(one("const r = await db.execute<{ a: number }>(sql.join(parts))")[0].sqlText === null,
    "(s) COMPOSED sql is not statically readable and must report sqlText=null, not an empty string that would match nothing");

  const proj = (src) => checkRawRowProjection(one(src)[0]);
  assert(proj("const r = await db.execute<{ a: number }>(sql`select 1 as a`)").length === 0,
    "(t) a declared key the SQL selects is clean");
  assert(proj("const r = await db.execute<{ missing: number }>(sql`select 1 as a`)")
    .some((m) => m.startsWith("MISSING")),
    "(u) a declared key the SQL does NOT select must FAIL — this is the gate biting on the huddle/channel defect shape in raw SQL");
  assert(proj('const r = await db.execute<{ relationAvailable: boolean }>(sql`select x AS "relationAvailable"`)').length === 0,
    "(v) a camelCase key with a DOUBLE-QUOTED alias survives Postgres folding and is clean");
  assert(proj("const r = await db.execute<{ relationAvailable: boolean }>(sql`select x AS relationAvailable`)")
    .some((m) => m.startsWith("CASEFOLD")),
    "(w) the SAME key with an UNQUOTED alias must FAIL — Postgres returns `relationavailable`, so every read is undefined while the type says otherwise");
  assert(proj("const r = await db.execute<LockedRow>(sql`select 1`)").length === 0,
    "(x) an unreadable site reports no violation rather than a false one — it is covered by the ledger instead");

  for (const [file, entry] of RAW_ROW_LEDGER) {
    assert(entry.seam === "external" || entry.seam === "narrow-me",
      `(y) ${file}: raw-row seam must be "external" or "narrow-me", got "${entry.seam}"`);
    assert(typeof entry.invariant === "string" && entry.invariant.length > 40,
      `(z) ${file}: every raw-row entry needs a written invariant, not a placeholder`);
  }

  const plainOf = (src) => countPlainAssertions("probe.ts", src);

  assert(plainOf("const a = b as Config;\n").asX === 1,
    "(aa) a plain `as X` cast -> counted by rule 4");
  assert(plainOf("const a = { x: 1 } as const;\n").asX === 0
    && plainOf("const a = { x: 1 } as const;\n").asConst === 1,
    "(ab) `as const` -> NOT a type assertion, counted separately and never against the ceiling");
  assert(plainOf("const a = b as unknown as C;\n").asX === 0,
    "(ac) `as unknown as` -> owned by rule 2, never double-ledgered into the ceiling");
  assert(plainOf("const a = b!.c;\n").nonNull === 1,
    "(ad) a non-null `!` assertion -> counted");
  assert(plainOf("const a = a !== b;\n").nonNull === 0,
    "(ae) an inequality operator -> not a non-null assertion (why this rule is an AST, not a regex)");
  assert(plainOf("const a = <Config>b;\n").asX === 1,
    "(af) the angle-bracket cast form -> counted, so it cannot become the escape hatch");
  assert(plainOf("const a = b satisfies Config;\n").asX === 0,
    "(ag) `satisfies` -> a check, not an assertion, not counted");
  assert(plainOf("class K { declare x!: string; }\n").nonNull === 0,
    "(ah) a definite-assignment declaration -> a declaration flag, not an expression assertion");
  assert(isSkippedDir("dist", 0) && isSkippedDir("coverage", 0),
    "(ak) `src/dist` and `src/coverage` -> skipped (build output at the root of the walk)");
  assert(!isSkippedDir("dist", 1) && !isSkippedDir("coverage", 2) && !isSkippedDir("build", 1) && !isSkippedDir("public", 1),
    "(al) a NESTED dist/coverage/build/public -> SCANNED. This is the blind spot that cost the frontend 456 files");
  assert(isSkippedDir("node_modules", 3) && isSkippedDir("__tests__", 4) && isSkippedDir("__mocks__", 1),
    "(am) node_modules/__tests__/__mocks__ -> skipped at ANY depth");
  // ---- rule 1's second corpus: the spec suite -----------------------------
  // These pin the property the widening rests on: the two walks PARTITION the
  // tree. Anything the application walk refuses for being a spec, the spec walk
  // must take — otherwise rule 1 keeps printing zero over files nobody reads,
  // which is how 159 `as any` survived a release under a gate that reported 0.
  assert(isSpecSuiteFile("list-query.schema.spec.ts", false)
    && isSpecSuiteFile("x.e2e-spec.ts", false)
    && isSpecSuiteFile("x.db.spec.ts", false)
    && isSpecSuiteFile("x.test.ts", false)
    && isSpecSuiteFile("service-stub.spec-fixtures.ts", false),
    "(an) every filename the application walk skips for being a spec MUST be taken by the spec walk — no file may fall between the two corpora");
  assert(!isSpecSuiteFile("party-merge.service.ts", false),
    "(ao) an ordinary application file is NOT spec-suite — the corpora partition, they do not overlap, so nothing is counted twice");
  assert(isSpecSuiteFile("helpers.ts", true) && !isSpecSuiteFile("helpers.ts", false),
    "(ap) an ORDINARILY named file under __tests__/__mocks__ is spec-suite — the application walk skips that whole directory (am), so only this branch can see it");
  assert(!isSpecSuiteFile("drizzle.types.d.ts", true) && !isSpecSuiteFile("drizzle.types.d.ts", false),
    "(aq) a `.d.ts` belongs to NEITHER corpus by construction — a declaration file holds no expressions, so `as any` cannot appear in one");
  assert(SKIP_FILE.test("x.spec.ts") && SKIP_FILE.test("service-stub.spec-fixtures.ts")
    && !SKIP_FILE.test("party-merge.service.ts"),
    "(ar) the partition is stated against the application walk's OWN exclusion list, so widening one corpus cannot silently narrow the other");

  assert(CEILING_LEDGER.size > 0,
    "(ai) the ceiling ledger loads — rule 4 is unenforced if the JSON is missing, and the gate must not pass without it");
  for (const [file, entry] of CEILING_LEDGER) {
    assert(Number.isInteger(entry.as) && Number.isInteger(entry.nonNull) && entry.count === entry.as + entry.nonNull,
      `(aj) ${file}: every ceiling entry carries a readable as/nonNull split`);
  }

  if (SELF_TEST_CHECKS.size < MIN_SELF_TEST_CHECKS) {
    console.error(
      `\nSELF-TEST FAIL: only ${SELF_TEST_CHECKS.size} distinct check(s) ran, below the floor of `
      + `${MIN_SELF_TEST_CHECKS}. A self-test that stops asserting must fail loudly, not report a `
      + `smaller number. Ran: ${[...SELF_TEST_CHECKS].join(", ")}`,
    );
    process.exit(1);
  }

  console.log(`PASS: self-test (${SELF_TEST_CHECKS.size} distinct checks, floor `
    + `${MIN_SELF_TEST_CHECKS} + a written invariant on all `
    + `${DOUBLE_CAST_LEDGER.size + RAW_ROW_LEDGER.size} invariant-bearing ledger entries, and a `
    + `ceiling on all ${CEILING_LEDGER.size} files holding a plain assertion)\n`);
  for (const line of [
    "  (a) a real double cast                        -> counted",
    "  (b) a line comment describing one             -> not counted",
    "  (c) a block comment describing one            -> not counted",
    "  (d) a `//` inside a string                    -> does not blind the line",
    "  (e) `as any`                                  -> counted",
    "  (f) `as any` inside a longer identifier       -> not counted",
    "  (e1) comment-stripping CANNOT see a directive -> why directives are matched raw",
    "  (e2) a real @ts-ignore/-expect-error/-nocheck -> caught (gate bites)",
    "  (e3) prose mentioning a directive             -> not a directive",
    "  (g) a file gaining a cast                     -> growth (gate bites)",
    "  (h) a file absent from the ledger             -> new (gate bites)",
    "  (i) a ledgered file with no casts left        -> stale (gate bites)",
    "  (j) a file losing a cast                      -> reported with the new number",
    "  (k) an unchanged file                         -> silent",
    "  (l) every ledger entry names a seam kind",
    "  (m) every ledger entry carries a written invariant",
    "  (n) a `db.execute<T>` call                     -> found",
    "  (n1) `tx.execute<T>` too                       -> found",
    "  (o) `execute` with no type argument            -> not counted",
    "  (p) a commented-out call                       -> not counted",
    "  (q) a multi-line type literal                  -> all keys read (why this rule is an AST)",
    "  (r) a NAMED type argument                      -> keys=null, ledgered not passed",
    "  (s) COMPOSED sql                               -> sqlText=null, ledgered not passed",
    "  (t) a declared key the SQL selects             -> clean",
    "  (u) a declared key the SQL does NOT select     -> MISSING (gate bites)",
    "  (v) camelCase key, DOUBLE-QUOTED alias         -> clean",
    "  (w) camelCase key, UNQUOTED alias              -> CASEFOLD (gate bites)",
    "  (x) an unreadable site                         -> no false violation",
    "  (y) every raw-row entry names a seam kind",
    "  (z) every raw-row entry carries a written invariant",
    "  (aa) a plain `as X`                            -> counted (rule 4)",
    "  (ab) `as const`                                -> excluded by decision",
    "  (ac) `as unknown as`                           -> rule 2's, not double-ledgered",
    "  (ad) a non-null `!`                            -> counted",
    "  (ae) an inequality `!==`                       -> not a non-null assertion",
    "  (af) the angle-bracket cast `<T>x`             -> counted",
    "  (ag) `satisfies`                               -> not counted",
    "  (ah) a definite-assignment `x!: T`             -> not counted",
    "  (ak) root `dist`/`coverage`                    -> skipped (output)",
    "  (al) NESTED dist/coverage/build/public         -> scanned (the frontend's blind spot)",
    "  (am) node_modules/__tests__ at any depth       -> skipped",
    "  (as) a narrow-me entry names no contract test    -> debt, not a permitted exception",
    "  (at) every EXTERNAL entry names one as path::title",
    "  (au) the named spec file is on disk               -> a dead pointer fails (gate bites)",
    "  (av) the named test title is IN that file         -> a rename fails (gate bites)",
    "  (an) every spec filename the app walk skips     -> taken by the spec walk (no gap)",
    "  (ao) an ordinary application file                -> not spec-suite (no overlap)",
    "  (ap) an ordinarily named file under __tests__    -> spec-suite (the app walk cannot see it)",
    "  (aq) a `.d.ts`                                   -> neither corpus, by construction",
    "  (ar) the partition is stated against SKIP_FILE itself",
    "  (ai) the ceiling ledger loads at all",
    "  (aj) every ceiling entry has a readable split",
  ]) console.log(line);
}

function main() {
  const { banned, doubleCasts, rawRows, plain, asConstTotal, projectionFailures, checkedProjections, files } = scan(SRC);
  const { banned: specBanned, files: specFiles } = scanSpecs(SRC);

  if (files < SCAN_FLOOR_FILES) {
    console.error(`FAIL: scanned only ${files} file(s), below the floor of ${SCAN_FLOOR_FILES}. The scan is broken, not the tree clean.`);
    process.exit(1);
  }

  if (specFiles < SCAN_FLOOR_SPEC_FILES) {
    console.error(`FAIL: rule 1's spec-suite walk scanned only ${specFiles} file(s), below the floor of ${SCAN_FLOOR_SPEC_FILES}. A second corpus that collapses to nothing reports the same clean zero as a clean corpus — which is the exact hole this walk was added to close.`);
    process.exit(1);
  }

  const total = [...doubleCasts.values()].reduce((a, b) => a + b, 0);

  const rawRowTotal = [...rawRows.values()].reduce((a, b) => a + b, 0);

  if (process.argv.includes("--list")) {
    for (const [file, count] of [...doubleCasts].sort()) console.log(`${count}\t${file}`);
    console.log(`\n${files} application files, ${doubleCasts.size} with a double cast, ${total} sites.`);
    console.log("\n--- rule 3: db.execute<T> raw-row generics ---");
    for (const [file, count] of [...rawRows].sort()) console.log(`${count}\t${file}`);
    console.log(`\n${rawRows.size} file(s), ${rawRowTotal} site(s), ${checkedProjections} cross-checkable against their SQL.`);
    return;
  }

  const plainTotal = [...plain.values()].reduce((a, v) => a + v.count, 0);
  const plainAs = [...plain.values()].reduce((a, v) => a + v.as, 0);
  const plainNonNull = [...plain.values()].reduce((a, v) => a + v.nonNull, 0);

  if (process.argv.includes("--seed-ledger")) {
    if (CEILING_LEDGER.size) {
      console.error("REFUSED: assertion-ceiling-ledger.json already exists. Seeding again would erase the ratchet. Use --update-ledger, which can only lower.");
      process.exit(1);
    }
    writeCeilingLedger(plain);
    console.log(`Seeded ${plain.size} file(s), ${plainTotal} assertion(s).`);
    return;
  }

  if (process.argv.includes("--update-ledger")) {
    const raised = [...plain].filter(([f, v]) => !CEILING_LEDGER.has(f) || v.count > CEILING_LEDGER.get(f).count);
    if (raised.length) {
      console.error(`REFUSED: --update-ledger only ever LOWERS. ${raised.length} file(s) would go up, which is the growth this gate exists to stop. Remove the assertion instead:`);
      for (const [f, v] of raised) console.error(`  ${f}: ledger ${CEILING_LEDGER.get(f)?.count ?? "(absent)"} -> tree ${v.count}`);
      process.exit(1);
    }
    const merged = new Map(plain);
    for (const [f, v] of CEILING_LEDGER) if (!merged.has(f) && plain.has(f)) merged.set(f, v);
    writeCeilingLedger(merged);
    console.log(`Lowered the ceiling to ${merged.size} file(s), ${[...merged.values()].reduce((a, v) => a + v.count, 0)} assertion(s).`);
    return;
  }

  const external = [...DOUBLE_CAST_LEDGER.values()].filter((e) => e.seam === "external").reduce((a, e) => a + e.count, 0);
  const narrowMe = [...DOUBLE_CAST_LEDGER.values()].filter((e) => e.seam === "narrow-me").reduce((a, e) => a + e.count, 0);

  console.log(`=== application files scanned: ${files} ===`);
  console.log(`=== spec-suite files scanned (rule 1 only): ${specFiles} ===`);
  console.log(`=== \`as unknown as\`: ${total} site(s) in ${doubleCasts.size} file(s) ===`);
  const externalEntries = [...DOUBLE_CAST_LEDGER.values()].filter((e) => e.seam === "external");
  const covered = externalEntries.filter((e) => typeof e.test === "string").length;
  console.log(`=== ledger: ${external} at a proven external seam, ${narrowMe} owed a Zod parse ===`);
  console.log(`=== C031 contract tests: ${covered}/${externalEntries.length} external entr(ies) name a negative/runtime test (self-test (at)-(av) proves each one exists and still bears that title) ===`);
  console.log(`=== \`db.execute<T>\` raw-row generics: ${rawRowTotal} site(s) in ${rawRows.size} file(s), ${checkedProjections} cross-checked against their SQL ===`);
  console.log(`=== plain assertions under a zero-growth ceiling: ${plainTotal} (${plainAs} \`as X\` + ${plainNonNull} non-null \`!\`) in ${plain.size} file(s) ===`);
  console.log(`=== \`as const\` excluded by decision (a const assertion narrows, it does not force): ${asConstTotal} ===`);

  let failed = false;

  if (banned.size) {
    console.error(`\nFAIL: ${banned.size} forced-typing escape(s) in application code — these have no ledger and no permitted count:`);
    for (const [where, n] of banned) console.error(`  ${where} x${n}`);
    failed = true;
  } else {
    console.log("=== as any / @ts-ignore / @ts-expect-error / @ts-nocheck: 0 (application) ===");
  }

  if (specBanned.size) {
    console.error(`\nFAIL: ${specBanned.size} forced-typing escape(s) in the SPEC SUITE. ts-jest runs isolatedModules, so nothing typechecks a spec at run time: \`as any\` on a mock lets it name a method the real service does not have and the assertion beneath it proves nothing. Rule 1 has no ledger and no permitted count on either side of the corpus:`);
    for (const [where, n] of specBanned) console.error(`  ${where} x${n}`);
    failed = true;
  } else {
    console.log("=== as any / @ts-ignore / @ts-expect-error / @ts-nocheck: 0 (spec suite) ===");
  }

  const { added, grown, shrunk, gone } = diffLedger(doubleCasts, DOUBLE_CAST_LEDGER);

  if (added.length) {
    console.error(`\nFAIL: ${added.length} file(s) hold a double cast and are not in DOUBLE_CAST_LEDGER. Narrow with Zod, or add an entry naming the seam and the invariant:`);
    for (const { file, count } of added) console.error(`  ${file} (${count} site(s))`);
    failed = true;
  }
  if (grown.length) {
    console.error(`\nFAIL: ${grown.length} file(s) gained a double cast. The ledger does not grow:`);
    for (const { file, was, now } of grown) console.error(`  ${file}: ${was} -> ${now}`);
    failed = true;
  }
  if (shrunk.length || gone.length) {
    console.error(`\nFAIL: ${shrunk.length + gone.length} ledger entr(ies) are out of date — the ratchet only ratchets down, so write the new number:`);
    for (const { file, was, now } of shrunk) console.error(`  ${file}: ledger says ${was}, tree has ${now} — lower the entry`);
    for (const file of gone) console.error(`  ${file}: no casts left — delete the entry`);
    failed = true;
  }

  const raw = diffLedger(rawRows, RAW_ROW_LEDGER);
  if (raw.added.length) {
    console.error(`\nFAIL: ${raw.added.length} file(s) carry a \`db.execute<T>\` raw-row generic and are not in RAW_ROW_LEDGER. Convert at the use site per CLAUDE.md section 6, or add an entry naming the seam and the invariant:`);
    for (const { file, count } of raw.added) console.error(`  ${file} (${count} site(s))`);
    failed = true;
  }
  if (raw.grown.length) {
    console.error(`\nFAIL: ${raw.grown.length} file(s) gained a \`db.execute<T>\` raw-row generic. The ledger does not grow:`);
    for (const { file, was, now } of raw.grown) console.error(`  ${file}: ${was} -> ${now}`);
    failed = true;
  }
  if (raw.shrunk.length || raw.gone.length) {
    console.error(`\nFAIL: ${raw.shrunk.length + raw.gone.length} raw-row ledger entr(ies) are out of date — write the new number:`);
    for (const { file, was, now } of raw.shrunk) console.error(`  ${file}: ledger says ${was}, tree has ${now} — lower the entry`);
    for (const file of raw.gone) console.error(`  ${file}: no raw-row generic left — delete the entry`);
    failed = true;
  }

  if (projectionFailures.length) {
    console.error(`\nFAIL: ${projectionFailures.length} \`db.execute<T>\` site(s) declare a row shape the query beside them does not produce. This is the defect that shipped twice on the frontend half of this seam — the read compiles, and the field arrives undefined:`);
    for (const reason of projectionFailures) console.error(`  ${reason}`);
    failed = true;
  } else {
    console.log(`=== every one of the ${checkedProjections} cross-checkable raw-row types is supported by its SQL ===`);
  }

  if (!CEILING_LEDGER.size) {
    console.error("\nFAIL: assertion-ceiling-ledger.json is missing or unreadable. Rule 4 is unenforced without it; a gate that cannot find its ledger must not pass.");
    failed = true;
  } else if (plainTotal < CEILING_FLOOR_TOTAL) {
    console.error(`\nFAIL: rule 4 counted only ${plainTotal} plain assertion(s), below the floor of ${CEILING_FLOOR_TOTAL}. The counter is broken, not the tree clean.`);
    failed = true;
  }

  const ceiling = diffLedger(new Map([...plain].map(([f, v]) => [f, v.count])), CEILING_LEDGER);
  if (ceiling.added.length) {
    console.error(`\nFAIL: ${ceiling.added.length} file(s) hold a plain \`as X\` or non-null \`!\` assertion and are not in the ceiling ledger. CLAUDE.md section 6 says never force a type — narrow at the use site, or the assertion does not land:`);
    for (const { file, count } of ceiling.added) console.error(`  ${file} (${count} assertion(s))`);
    failed = true;
  }
  if (ceiling.grown.length) {
    console.error(`\nFAIL: ${ceiling.grown.length} file(s) gained a plain assertion. The ceiling does not rise:`);
    for (const { file, was, now } of ceiling.grown) console.error(`  ${file}: ${was} -> ${now}`);
    failed = true;
  }
  if (ceiling.shrunk.length || ceiling.gone.length) {
    console.error(`\nFAIL: ${ceiling.shrunk.length + ceiling.gone.length} ceiling entr(ies) are stale — an exception that outlives its site is how the next reader inherits a licence nobody meant to grant. Run \`pnpm check:type-assertions --update-ledger\`, which can only lower:`);
    for (const { file, was, now } of ceiling.shrunk) console.error(`  ${file}: ledger ${was}, tree ${now} — lower it`);
    for (const file of ceiling.gone) console.error(`  ${file}: no plain assertion left — delete the entry`);
    failed = true;
  }

  if (failed) process.exit(1);
  console.log("\nPASS: no forced-typing escape in application code, every double cast is ledgered at its recorded count, and every statically readable `db.execute<T>` row type matches the projection beside it.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else main();
