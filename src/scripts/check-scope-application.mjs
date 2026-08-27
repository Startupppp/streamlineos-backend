/**
 * check-scope-application.mjs
 *
 * Finds handlers that resolve the caller's DataScope and then never spend it.
 * Fails (exit 1) naming each one.
 *
 * THE DEFECT, WHICH IS WORSE THAN A MISSING CHECK:
 *   LeavesService.analytics resolved `hr:leaves:approve` to a DataScope,
 *   refused only "none", and then called queryAnalytics(orgId, year) -- which
 *   takes no scope and aggregates the whole organisation. An own- or
 *   team-scoped approver received org-wide leave analytics broken down by
 *   department. A reviewer reading that method sees scope handling and stops
 *   looking, which is exactly why it survived: the resolve is decorative.
 *
 *   PermissionGuard answers "may you call this at all" and stores the scope on
 *   req.rbacScope. Whether the query then honours it is decided somewhere else
 *   entirely, by hand, 132 times. This check is the seam that makes the second
 *   half observable, because a type cannot express "you must use this value".
 *
 * WHAT COUNTS AS SPENDING IT:
 *   Passing it to applyScope or any other function, returning it, storing it,
 *   or interpolating it into a SQL template. Anything that carries it toward
 *   the predicate.
 *
 * WHAT DOES NOT:
 *   - `if (scope === "none") throw` and nothing else. Refusing the empty scope
 *     is not applying the scope: "own" and "all" then behave identically, which
 *     is the whole bug.
 *   - A cache key. `${scope}:${year}` makes the cache FINER than the data it
 *     stores, so it hides nothing and fixes nothing -- and it is the detail that
 *     makes the method read as careful. Counting it as use would have cleared
 *     the one confirmed instance.
 *
 * Usage:
 *   node src/scripts/check-scope-application.mjs
 *   node src/scripts/check-scope-application.mjs --self-test
 *
 * Exit codes:
 *   0  every resolved scope is spent, or is a registered exception
 *   1  at least one resolved scope is never applied (or self-test failed)
 *   2  usage error, including the parser finding no resolutions at all
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const MODULES_DIR = join(BACKEND_ROOT, "src", "modules");

const SPEC_RE = /\.(spec|e2e-spec)\.ts$/;

/**
 * `const x = await resolveSomethingScope(...)`, `= readRequestScope(req)`,
 * `= req.rbacScope`. These are the three ways a handler in this codebase gets a
 * DataScope; a new one must be added here or it is invisible.
 */
const RESOLUTION_RE =
  /(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*DataScope\s*)?=\s*(?:await\s+)?((?:this\.)?resolve[A-Za-z0-9_$]*Scope|readRequestScope|[A-Za-z0-9_$.]*\.rbacScope)/;

/**
 * Sites where a resolved scope is deliberately not applied to a predicate, each
 * with the reason. Absence is a failure, so an exception is a line in a diff.
 */
export const NOT_APPLIED_BY_DESIGN = new Map([
  // "file::variable" -> "why"
]);

// -- analysis ----------------------------------------------------------------

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * The lines from the resolution to the end of its enclosing block.
 *
 * Indentation, not brace matching: the source is prettier-formatted, so the
 * method's closing brace is the first line indented less than the statement,
 * and this stays right for nested blocks, which are indented more.
 */
export function enclosingBlock(lines, from) {
  const base = indentOf(lines[from]);
  const block = [lines[from]];
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() && indentOf(line) < base) break;
    block.push(line);
  }
  return block;
}

/**
 * How a resolved scope is used across the lines that follow it.
 * Returns { guardOnly, cacheOnly, spent, uses }.
 */
export function classifyUse(block, name) {
  const word = new RegExp(`\\b${name}\\b`);
  let guards = 0;
  let cacheInterpolations = 0;
  let spends = 0;
  let uses = 0;

  const guardRe = new RegExp(`(?:!\\s*${name}\\b)|(?:\\b${name}\\s*(?:===|!==|==|!=)\\s*["']none["'])`, "g");

  for (let i = 1; i < block.length; i++) {
    const line = block[i];
    if (!word.test(line)) continue;
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
    uses++;

    // A DataScope is one of four words. Interpolating it into a plain string
    // produces a label -- a cache discriminator, a log line -- and a label
    // filters nothing. Only a SQL template can turn it into a predicate.
    //
    // This is the rule, not a heuristic about the surrounding words: an earlier
    // version asked whether the line mentioned "cache", and the one confirmed
    // live instance writes `${scope}:${year}` on its own argument line, which
    // mentions nothing. The check cleared the exact bug it exists to find.
    if (new RegExp(`\\$\\{${name}\\}`).test(line)) {
      if (/\bsql`/.test(line)) spends++;
      else cacheInterpolations++;
      continue;
    }

    // Refusing the empty scope is not applying the scope -- but a line that
    // refuses "none" AND still mentions the scope is doing both, and the second
    // half is the one that counts. Three of the first five findings were
    // `manageScope === "none" ? "own" : manageScope`, where the value survives
    // in the else branch; reading only the comparison called all three
    // decorative. Strip the refusals, then ask whether anything is left.
    const guardsHere = line.match(guardRe)?.length ?? 0;
    const residue = line.replace(guardRe, "");
    if (word.test(residue)) {
      spends++;
      continue;
    }
    guards += guardsHere;
  }

  return {
    uses,
    guards,
    cacheInterpolations,
    spent: spends > 0,
    guardOnly: spends === 0 && guards > 0,
    cacheOnly: spends === 0 && cacheInterpolations > 0,
  };
}

export function analyseSource(src, filePath) {
  const lines = src.split("\n");
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(RESOLUTION_RE);
    if (!match) continue;
    const name = match[1];
    const via = match[2];
    const block = enclosingBlock(lines, i);
    const use = classifyUse(block, name);

    findings.push({
      file: filePath,
      line: i + 1,
      name,
      via,
      ...use,
    });
  }

  return findings;
}

// -- self-test ---------------------------------------------------------------

if (args.includes("--self-test")) {
  // The confirmed instance, copied from leaves.service.ts:211 rather than
  // paraphrased. The discriminator sits on its own argument line, naming
  // neither "cache" nor "key" -- which is precisely how the first version of
  // this check cleared it.
  const decorativeResolve = [
    `  async analytics(u: CurrentUserContext, year: number) {`,
    `    const scope = await resolveLeavesViewScope(this.access, u);`,
    `    if (scope === "none") throw new ForbiddenException("Forbidden");`,
    ``,
    `    return this.cache.cachedVersioned(`,
    `      CACHE_KEYS.leaveAnalyticsNamespace(u.orgId),`,
    `      \`\${scope}:\${year}\`,`,
    `      () => this.queryAnalytics(u.orgId, year),`,
    `      CACHE_TTL.MEDIUM,`,
    `    );`,
    `  }`,
  ].join("\n");

  // A scope genuinely spent inside a SQL template, which a plain string is not.
  const spentInSqlTemplate = [
    `  async rollup(u: CurrentUserContext) {`,
    `    const scope = await resolveReportsScope(this.access, u);`,
    `    return this.db.execute(sql\`SELECT 1 WHERE \${scope} = 'all'\`);`,
    `  }`,
  ].join("\n");

  const appliedToPredicate = [
    `  async list(u: CurrentUserContext) {`,
    `    const scope = await resolveTicketsScope(this.access, u);`,
    `    if (scope === "none") return [];`,
    `    return this.db`,
    `      .select()`,
    `      .from(tickets)`,
    `      .where(and(eq(tickets.orgId, u.orgId), applyScope(scope, u.orgId, u.userId, cols)));`,
    `  }`,
  ].join("\n");

  const handedToAnotherFunction = [
    `  async list(u: CurrentUserContext) {`,
    `    const viewScope = await resolveDealsReadScope(this.access, u);`,
    `    return this.query(u.orgId, viewScope);`,
    `  }`,
  ].join("\n");

  const fromRequest = [
    `  async list(@Req() req: Request, u: CurrentUserContext) {`,
    `    const scope = readRequestScope(req);`,
    `    if (scope === "none") throw new ForbiddenException("nope");`,
    `    return this.svc.listAll(u.orgId);`,
    `  }`,
  ].join("\n");

  // The block must stop at the method's closing brace: a sibling method that
  // happens to use the same variable name must not clear this one.
  const twoMethods = [
    `  async a(u: CurrentUserContext) {`,
    `    const scope = await resolveGoalsScope(this.access, u);`,
    `    if (scope === "none") return [];`,
    `    return this.svc.all(u.orgId);`,
    `  }`,
    ``,
    `  async b(u: CurrentUserContext, scope: DataScope) {`,
    `    return this.db.select().where(applyScope(scope, u.orgId, u.userId, cols));`,
    `  }`,
  ].join("\n");

  // The three shapes that made the first version report false positives: the
  // scope survives in the else branch of the same line that refuses "none", or
  // is compared against a different scope value.
  const ternaryReturn = [
    `export async function resolveAttendanceReadScope(access, u): Promise<DataScope> {`,
    `  const manageScope = await resolveAttendanceScope(access, u);`,
    `  return manageScope === "none" ? "own" : manageScope;`,
    `}`,
  ].join("\n");

  const ternaryThenApplied = [
    `  async updateEmployee(actor: CurrentUserContext, targetUserId: string) {`,
    `    const manageScope = await resolveEmployeesManageScope(this.access, actor);`,
    `    if (!isSelf && manageScope === "none") throw new ForbiddenException("no");`,
    `    const effectiveScope: DataScope = isSelf && manageScope === "none" ? "own" : manageScope;`,
    `    return this.db.query.organizationMembers.findFirst({`,
    `      where: applyScope(effectiveScope, actor.orgId, actor.userId, cols),`,
    `    });`,
    `  }`,
  ].join("\n");

  const comparedToAnotherScope = [
    `  async getSlaAlerts(@CurrentUser() u: CurrentUserContext) {`,
    `    const scope = await resolveLeadsViewScope(this.access, u);`,
    `    return this.reports.getLeadSlaAlerts(u.orgId, {`,
    `      ownScope: scope === "own" || scope === "none",`,
    `      userId: u.userId,`,
    `    });`,
    `  }`,
  ].join("\n");

  const decorative = analyseSource(decorativeResolve, "leaves.service.ts");
  const sqlTemplate = analyseSource(spentInSqlTemplate, "reports.service.ts");
  const ternary = analyseSource(ternaryReturn, "attendance-scope.ts");
  const ternaryApplied = analyseSource(ternaryThenApplied, "employee-mutations.service.ts");
  const otherScope = analyseSource(comparedToAnotherScope, "leads-reports.controller.ts");
  const applied = analyseSource(appliedToPredicate, "tickets.service.ts");
  const delegated = analyseSource(handedToAnotherFunction, "deals.service.ts");
  const request = analyseSource(fromRequest, "thing.controller.ts");
  const sibling = analyseSource(twoMethods, "goals.service.ts");

  const checks = {
    findsTheDecorativeResolve: decorative.length === 1 && decorative[0].spent === false,
    decorativeIsNamedByLine: decorative[0]?.line === 2 && decorative[0]?.name === "scope",
    // The nuance that decides the whole check: the cache key is discriminated,
    // and counting that as use would clear the one confirmed live instance.
    cacheKeyDoesNotCountAsApplication:
      decorative[0]?.cacheInterpolations === 1 && decorative[0]?.spent === false,
    guardAgainstNoneDoesNotCountAsApplication: decorative[0]?.guards === 1,
    sqlTemplateInterpolationDoesCountAsApplication:
      sqlTemplate.length === 1 && sqlTemplate[0].spent === true,
    appliedToAPredicatePasses: applied.length === 1 && applied[0].spent === true,
    ternaryReturningTheScopeIsNotDecorative:
      ternary.length === 1 && ternary[0].spent === true,
    guardAndSurvivingElseBranchOnOneLineIsSpent:
      ternaryApplied.length === 1 && ternaryApplied[0].spent === true,
    comparisonAgainstAnotherScopeValueIsSpent:
      otherScope.length === 1 && otherScope[0].spent === true,
    handedToAnotherFunctionPasses: delegated.length === 1 && delegated[0].spent === true,
    readRequestScopeIsARecognisedSource:
      request.length === 1 && request[0].via === "readRequestScope" && request[0].spent === false,
    blockStopsAtTheMethodEnd: sibling.length === 1 && sibling[0].spent === false,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

// -- run ---------------------------------------------------------------------

if (!existsSync(MODULES_DIR)) {
  process.stderr.write(`Cannot read modules dir: ${MODULES_DIR}\n`);
  process.exit(2);
}

function walkTs(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkTs(full));
    else if (entry.name.endsWith(".ts") && !SPEC_RE.test(entry.name)) results.push(full);
  }
  return results;
}

const all = walkTs(MODULES_DIR).flatMap((file) =>
  analyseSource(readFileSync(file, "utf8"), file),
);

// The vocabulary is 30 named resolvers across 132 call sites. Near zero means
// RESOLUTION_RE stopped matching, not that the codebase changed.
if (all.length < 20) {
  process.stderr.write(
    `Found only ${all.length} scope resolutions. That is a broken pattern, not a clean codebase.\n`,
  );
  process.exit(2);
}

const key = (f) => `${relative(BACKEND_ROOT, f.file).replace(/\\/g, "/")}::${f.name}`;
const unspent = all.filter((f) => !f.spent && !NOT_APPLIED_BY_DESIGN.has(key(f)));
const excused = all.filter((f) => !f.spent && NOT_APPLIED_BY_DESIGN.has(key(f)));

console.log(`Scope resolutions   ${all.length}`);
console.log(`Applied             ${all.filter((f) => f.spent).length}`);
console.log("");

if (excused.length > 0) {
  console.log("NOT APPLIED BY DESIGN — named, not hidden in an allowlist:");
  for (const f of excused) console.log(`  SKIP  ${key(f)}  — ${NOT_APPLIED_BY_DESIGN.get(key(f))}`);
  console.log("");
}

if (unspent.length === 0) {
  console.log("OK — every resolved DataScope reaches a predicate.");
  process.exit(0);
}

console.error("RESOLVED BUT NEVER APPLIED — the scope is decorative:");
for (const f of unspent.sort((a, b) => key(a).localeCompare(key(b)))) {
  const how = f.guardOnly
    ? 'only refuses "none"'
    : f.cacheOnly
      ? "only discriminates a cache key"
      : f.uses === 0
        ? "is never read again"
        : 'only refuses "none" and keys a cache';
  console.error(
    `  FAIL  ${relative(BACKEND_ROOT, f.file).replace(/\\/g, "/")}:${f.line}  ${f.name} = ${f.via}  — ${how}`,
  );
}
console.error("");
console.error(`FAIL — ${unspent.length} of ${all.length} resolved scopes never reach a predicate.`);
process.exit(1);
