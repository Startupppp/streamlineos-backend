/**
 * Rate-limit guard coverage — static analysis over every *.controller.ts.
 *
 * WHAT IT CHECKS
 * `@UseRateLimit("tier")` is metadata. `RateLimitGuard` is the only thing that
 * reads it, and BE-28 lists the five global `APP_GUARD`s — RateLimitGuard is
 * not among them. So every controller is individually responsible for
 * remembering `@UseGuards(..., RateLimitGuard)`, and a handler that carries the
 * decorator without the guard in scope is limited by nothing while reading, in
 * review and in the OpenAPI surface, exactly like one that is.
 *
 * That is the same shape as the problem `RouteClassifierGuard` solved for route
 * exposure: a forgotten decorator with no symptom. This script is the static
 * half of the same answer, and it is modelled on
 * `route-classification-report.mjs` line for line.
 *
 * The runtime counterpart cannot exist as cheaply here. `RouteClassifierGuard`
 * can sweep at boot because it only needs the metadata; guard *registration* is
 * not reflected as metadata Nest exposes per handler in a form a sixth global
 * guard could read reliably, so the sweep is static.
 *
 * HOW IT WORKS
 * Identical parse to the classification report: decorator lines accumulate in a
 * pending buffer, `class` flushes the buffer into class-level decorators, an
 * HTTP-verb decorator marks the buffer as a handler, and the next code line is
 * the handler declaration. A handler is covered when `RateLimitGuard` appears
 * in a `@UseGuards(...)` on the handler OR on its class, because Nest applies
 * class and handler guards together rather than letting one override the other.
 *
 * LIMITATIONS
 * - Static and regex-based. A guard reaching a route by any means other than
 *   `@UseGuards` on the handler or its class is invisible here; today there is
 *   no such means, because `app.module.ts` is the only place an `APP_GUARD` is
 *   registered and RateLimitGuard is not one (pinned by
 *   `src/common/ratelimit/rate-limit-coverage.spec.ts`).
 * - This gate says nothing about whether the tier exists. That is BE-35 and
 *   `rate-limit-coverage.spec.ts`.
 *
 * Usage:
 *   node src/scripts/check-rate-limit-guard-coverage.mjs [options]
 *   pnpm check:rate-limit-guards
 *
 * Options:
 *   --self-test   Run internal assertions and exit.
 *   --json        Output JSON instead of human-readable text.
 *   --verbose     Include every rate-limited handler, not just the uncovered.
 *
 * Exit codes:
 *   0 = every rate-limited handler has RateLimitGuard in scope
 *   1 = one or more UNCOVERED handlers found, or --self-test failed
 *   2 = no controller files found, or RateLimitGuard became global and this
 *       gate would now pass vacuously
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC_ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------

const RATE_LIMIT_RE = /@UseRateLimit\s*\(\s*["'`]([^"'`]*)["'`]/;
const USE_GUARDS_RE = /@UseGuards\s*\(([\s\S]*)\)/;
const RATE_LIMIT_GUARD_RE = /\bRateLimitGuard\b/;
const HTTP_VERB_RE = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(/;
const ROUTE_PATH_RE = /@(?:Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*["'`]([^"'`]*)["'`]/;
const CLASS_RE = /^(export\s+)?(abstract\s+)?class\s+\w+/;
const METHOD_RE = /^(?:async\s+)?(\w+)\s*[(<]/;

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (entry.endsWith(".controller.ts")) yield full;
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Join a decorator whose argument list spans lines back onto one line, so that
 * `@UseGuards(\n  JwtAuthGuard,\n  RateLimitGuard,\n)` — which is how prettier
 * renders three guards — is one string the guard regex can see.
 *
 * @param {string} content
 * @returns {string}
 */
export function collapseMultilineDecorators(content) {
  const lines = content.split("\n");
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("@")) {
      out.push(line);
      continue;
    }

    let depth = 0;
    for (const ch of line) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    if (depth <= 0) {
      out.push(line);
      continue;
    }

    let joined = line.trimEnd();
    while (depth > 0 && i + 1 < lines.length) {
      i++;
      const next = lines[i].trim();
      joined += next;
      for (const ch of next) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
    }
    out.push(joined);
  }

  return out.join("\n");
}

function emptyDecorators() {
  return {
    tier: null,
    hasRateLimitGuard: false,
    hasHttpVerb: false,
    verb: "",
    routePath: "",
  };
}

/**
 * @typedef {{ method: string, tier: string, verb: string, routePath: string, covered: boolean, guardScope: 'handler'|'class'|'none' }} HandlerResult
 */

/**
 * @param {string} rawContent
 * @returns {HandlerResult[]}
 */
export function parseRateLimitedHandlers(rawContent) {
  const content = collapseMultilineDecorators(rawContent);
  const lines = content.split("\n");
  /** @type {HandlerResult[]} */
  const handlers = [];

  let classDecorators = emptyDecorators();
  let pending = emptyDecorators();
  let inClass = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }

    if (trimmed.startsWith("@")) {
      const tierMatch = RATE_LIMIT_RE.exec(trimmed);
      if (tierMatch) pending.tier = tierMatch[1] ?? "";

      const guardsMatch = USE_GUARDS_RE.exec(trimmed);
      if (guardsMatch && RATE_LIMIT_GUARD_RE.test(guardsMatch[1] ?? ""))
        pending.hasRateLimitGuard = true;

      if (HTTP_VERB_RE.test(trimmed)) {
        pending.hasHttpVerb = true;
        pending.verb = HTTP_VERB_RE.exec(trimmed)?.[1] ?? "";
        pending.routePath = ROUTE_PATH_RE.exec(trimmed)?.[1] ?? "";
      }
      continue;
    }

    if (CLASS_RE.test(trimmed)) {
      classDecorators = { ...pending };
      pending = emptyDecorators();
      inClass = true;
      continue;
    }

    if (inClass && pending.hasHttpVerb) {
      const m = trimmed.match(METHOD_RE);
      if (m && m[1] !== "constructor") {
        const tier = pending.tier ?? classDecorators.tier;
        if (tier !== null) {
          const guardScope = pending.hasRateLimitGuard
            ? "handler"
            : classDecorators.hasRateLimitGuard
              ? "class"
              : "none";
          handlers.push({
            method: m[1],
            tier,
            verb: pending.verb,
            routePath: pending.routePath,
            covered: guardScope !== "none",
            guardScope,
          });
        }
      }
    }

    pending = emptyDecorators();
  }

  return handlers;
}

/**
 * RateLimitGuard becoming a global APP_GUARD would make every finding below
 * false, and a gate that reports zero for the wrong reason is worse than no
 * gate. Read app.module.ts and say so rather than printing a clean run.
 *
 * @param {string} appModuleSource
 * @returns {boolean}
 */
export function rateLimitGuardIsGlobal(appModuleSource) {
  return [...appModuleSource.matchAll(/APP_GUARD,\s*useClass:\s*(\w+)/g)].some(
    (match) => match[1] === "RateLimitGuard",
  );
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function runSelfTest() {
  const checks = {};

  const handlerGuard = `
@Controller("things")
class ThingController {
  @Post("invite")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("things:invite")
  invite() {}
}
`;
  const r1 = parseRateLimitedHandlers(handlerGuard);
  checks.handlerLevelGuardCovers = r1.length === 1 && r1[0]?.covered === true;
  checks.handlerLevelGuardScopeReported = r1[0]?.guardScope === "handler";

  const missingGuard = `
@Controller("things")
@UseGuards(JwtAuthGuard, PermissionGuard)
class ThingController {
  @Post(":thingId/invite-link")
  @UseRateLimit("things:invite-link")
  createInviteLink() {}
}
`;
  const r2 = parseRateLimitedHandlers(missingGuard);
  checks.decoratorWithoutGuardIsUncovered = r2.length === 1 && r2[0]?.covered === false;
  checks.uncoveredHandlerKeepsItsTier = r2[0]?.tier === "things:invite-link";
  checks.uncoveredHandlerKeepsItsRoute =
    r2[0]?.verb === "Post" && r2[0]?.routePath === ":thingId/invite-link";

  const classGuard = `
@Controller("things")
@UseGuards(JwtAuthGuard, RateLimitGuard)
class ThingController {
  @Post("a")
  @UseRateLimit("things:a")
  a() {}

  @Post("b")
  @UseRateLimit("things:b")
  b() {}
}
`;
  const r3 = parseRateLimitedHandlers(classGuard);
  checks.classLevelGuardCoversEveryHandler =
    r3.length === 2 && r3.every((h) => h.covered && h.guardScope === "class");

  const noTier = `
@Controller("things")
@UseGuards(JwtAuthGuard)
class ThingController {
  @Get()
  list() {}
}
`;
  checks.handlerWithNoTierIsNotReported = parseRateLimitedHandlers(noTier).length === 0;

  // A guard list that merely mentions another guard must not count. This is the
  // case that makes the gate bite rather than pass on a near miss.
  const otherGuard = `
@Controller("things")
class ThingController {
  @Post("x")
  @UseGuards(IdempotencyGuard)
  @UseRateLimit("things:x")
  x() {}
}
`;
  checks.anUnrelatedGuardDoesNotCount =
    parseRateLimitedHandlers(otherGuard)[0]?.covered === false;

  // Prettier wraps a three-guard list, and the whole point of the collapse pass
  // is that a reformat must not turn a covered handler into a finding.
  const wrappedGuards = `
@Controller("things")
class ThingController {
  @Post("y")
  @UseGuards(
    JwtAuthGuard,
    PermissionGuard,
    RateLimitGuard,
  )
  @UseRateLimit("things:y")
  y() {}
}
`;
  checks.wrappedGuardListStillCovers =
    parseRateLimitedHandlers(wrappedGuards)[0]?.covered === true;

  const wrappedTier = `
@Controller("things")
class ThingController {
  @Post("z")
  @UseGuards(RateLimitGuard)
  @UseRateLimit(
    "things:z",
  )
  z() {}
}
`;
  const r4 = parseRateLimitedHandlers(wrappedTier);
  checks.wrappedTierStillDetected = r4.length === 1 && r4[0]?.tier === "things:z";

  // A class-level tier applies to every handler, and each still needs a guard.
  const classTier = `
@Controller("things")
@UseRateLimit("things:class")
class ThingController {
  @Post("one")
  one() {}

  @Post("two")
  @UseGuards(RateLimitGuard)
  two() {}
}
`;
  const r5 = parseRateLimitedHandlers(classTier);
  checks.classLevelTierAppliesToEveryHandler = r5.length === 2;
  checks.classLevelTierStillNeedsAGuard =
    r5.find((h) => h.method === "one")?.covered === false &&
    r5.find((h) => h.method === "two")?.covered === true;

  // Reserved-word method names are real handlers; the classification report
  // lost 14 of them to an exclusion list and certified the rest.
  const reservedWords = `
@Controller("things")
class ThingController {
  @Delete(":thingId")
  @UseRateLimit("things:delete")
  delete() {}

  @Post("export")
  @UseRateLimit("things:export")
  export() {}
}
`;
  const r6 = parseRateLimitedHandlers(reservedWords);
  checks.reservedWordMethodNamesAreStillHandlers = r6.length === 2;
  checks.reservedWordHandlersAreUncoveredWhenTheyAre = r6.every((h) => !h.covered);

  checks.globalRegistrationIsDetected = rateLimitGuardIsGlobal(
    `{ provide: APP_GUARD, useClass: RateLimitGuard },`,
  );
  checks.absentGlobalRegistrationIsDetected = !rateLimitGuardIsGlobal(
    `{ provide: APP_GUARD, useClass: ModuleGuard },`,
  );

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--self-test")) runSelfTest();

const asJson = args.includes("--json");
const verbose = args.includes("--verbose");

const appModule = readFileSync(join(SRC_ROOT, "app.module.ts"), "utf8");
if (rateLimitGuardIsGlobal(appModule)) {
  process.stdout.write(
    "ERROR: RateLimitGuard is registered as a global APP_GUARD. Every finding this gate " +
      "produces would be false, so it refuses to report. Delete this gate or restate the " +
      "invariant it checks.\n",
  );
  process.exit(2);
}

/** @type {{ file: string, handlers: HandlerResult[] }[]} */
const results = [];

for (const filePath of walk(SRC_ROOT)) {
  const content = readFileSync(filePath, "utf8");
  const handlers = parseRateLimitedHandlers(content);
  if (handlers.length > 0) {
    results.push({ file: relative(SRC_ROOT, filePath).replace(/\\/g, "/"), handlers });
  }
}

let totalRateLimited = 0;
let totalCovered = 0;

/** @type {{ file: string, handler: string, tier: string, route: string }[]} */
const uncovered = [];

for (const { file, handlers } of results) {
  for (const handler of handlers) {
    totalRateLimited++;
    if (handler.covered) totalCovered++;
    else
      uncovered.push({
        file,
        handler: handler.method,
        tier: handler.tier,
        route: `${handler.verb.toUpperCase()} ${handler.routePath}`,
      });
  }
}

if (totalRateLimited === 0) {
  process.stdout.write(
    "ERROR: No @UseRateLimit handlers found. Is the working directory correct?\n",
  );
  process.exit(2);
}

if (asJson) {
  process.stdout.write(
    JSON.stringify(
      {
        summary: {
          controllersWithRateLimits: results.length,
          rateLimitedHandlers: totalRateLimited,
          covered: totalCovered,
          uncovered: uncovered.length,
        },
        uncovered,
        ...(verbose ? { all: results } : {}),
      },
      null,
      2,
    ) + "\n",
  );
} else {
  process.stdout.write(
    `\nRate-limit guard coverage\n` +
      `  Controllers with @UseRateLimit : ${results.length}\n` +
      `  Rate-limited handlers          : ${totalRateLimited}\n` +
      `  RateLimitGuard in scope        : ${totalCovered}\n` +
      `  UNCOVERED                      : ${uncovered.length}\n`,
  );

  if (uncovered.length > 0) {
    process.stdout.write(
      `\nUNCOVERED handlers (@UseRateLimit with no RateLimitGuard on the handler or its class — the tier is metadata nobody reads):\n`,
    );
    for (const { file, handler, tier, route } of uncovered) {
      process.stdout.write(`  ${file}  →  ${handler}  [${route}]  tier="${tier}"\n`);
    }
  }

  if (verbose) {
    process.stdout.write(`\nFull rate-limited handler list:\n`);
    for (const { file, handlers } of results) {
      for (const h of handlers) {
        process.stdout.write(
          `  [${(h.covered ? h.guardScope : "UNCOVERED").padEnd(9)}]  ${file}  →  ${h.method}  tier="${h.tier}"\n`,
        );
      }
    }
  }

  process.stdout.write(
    `\n${
      uncovered.length === 0
        ? "RESULT: EVERY RATE-LIMITED HANDLER HAS RateLimitGuard IN SCOPE"
        : `RESULT: ${uncovered.length} UNCOVERED HANDLER(S) — add RateLimitGuard to @UseGuards on the handler or its controller`
    }\n`,
  );
}

process.exit(uncovered.length > 0 ? 1 : 0);
