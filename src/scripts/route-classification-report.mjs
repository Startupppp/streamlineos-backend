/**
 * Route classification report — static analysis over every *.controller.ts.
 *
 * WHAT IT CHECKS
 * Every HTTP handler must carry exactly one of four classifications, either on
 * the handler method itself or inherited from the class:
 *
 *   @Public()             — unauthenticated access permitted
 *   @Universal()          — authenticated, no permission key required (platform
 *                           core per root CLAUDE.md §8: home, mail, chat,
 *                           notifications, /me/*, calendar, search, sessions)
 *   @RequirePermission    — gated by PermissionGuard with a catalog key
 *   @AuthorizedInService  — authorized downstream of the guard, naming what does
 *                           it. The module-access surface resolves module
 *                           management *standing*, which no permission key can
 *                           express — §5 makes `<module>:access:manage` view-only
 *                           on purpose, so a key there would advertise a weaker
 *                           second way in.
 *
 * Absence is the defect RouteClassifierGuard was built to catch at runtime.
 * This script provides the same signal statically so CI can gate on it before
 * the app ever boots.
 *
 * HOW IT WORKS
 * Line-by-line parse of each controller file:
 *   1. Decorator lines (@...) accumulate in a pending buffer.
 *   2. A `class` keyword flushes the buffer into class-level decorators.
 *   3. An HTTP verb decorator (@Get, @Post, …) marks the buffer as containing
 *      a handler.  The very next non-decorator, non-comment, non-blank code
 *      line is taken as the handler declaration.
 *   4. Classification resolves handler-first, then class, matching NestJS's
 *      Reflector.getAllAndOverride behaviour.
 *
 * LIMITATIONS
 * - This is a static, regex-based scanner.  Dynamic registration (e.g.
 *   RouteModule.forChild) is not covered.  The authoritative list comes from
 *   booting with REQUIRE_ROUTE_CLASSIFICATION=true, which makes the guard deny
 *   at startup.
 * - Decorator lines that span multiple source lines (rare) may not be picked
 *   up.  All real-world decorators in this codebase use a single line.
 *
 * Usage:
 *   node src/scripts/route-classification-report.mjs [options]
 *   pnpm check:route-classification
 *
 * Options:
 *   --self-test   Run internal assertions and exit.
 *   --json        Output JSON instead of human-readable text.
 *   --verbose     Include the full per-file handler list, not just undeclared.
 *
 * Exit codes:
 *   0 = every route is classified
 *   1 = one or more UNDECLARED routes found, or --self-test failed
 *   2 = no controller files found (likely a working-directory issue)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC_ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------

const PUBLIC_RE = /@Public\s*\(\s*\)/;
const UNIVERSAL_RE = /@Universal\s*\(\s*\)/;
const PERMISSION_RE = /@RequirePermission\s*\(/;
// Authorization that lives downstream of the guard and names what performs it —
// module-access resolves standing, which no permission key can express.
const IN_SERVICE_RE = /@AuthorizedInService\s*\(\s*["'`]/;
const HTTP_VERB_RE = /@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(/;
const CLASS_RE = /^(export\s+)?(abstract\s+)?class\s+\w+/;
// A method/function name: optional async, identifier, then ( or < (generics).
// Exclude keywords that also match: if, for, while, return, throw, catch, const, …
const KEYWORDS = new Set([
  "if", "for", "while", "return", "throw", "catch", "switch", "case",
  "const", "let", "var", "new", "import", "export", "await", "try",
  "else", "default", "typeof", "instanceof", "void", "delete",
]);
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
 * @typedef {{ method: string, classification: 'public'|'universal'|'permissioned'|'in-service'|'UNDECLARED' }} HandlerResult
 * @typedef {{ file: string, handlers: HandlerResult[] }} FileResult
 */

function emptyDecorators() {
  return {
    isPublic: false,
    isUniversal: false,
    isPermissioned: false,
    isInService: false,
    hasHttpVerb: false,
  };
}

/**
 * Parse a single controller file and return the classification of each HTTP
 * handler it contains.
 *
 * Multi-line decorator arguments (e.g. `@UseInterceptors(\n  FileInterceptor(…),\n)`)
 * are handled by tracking parenthesis depth.  When a decorator line ends with an
 * unclosed `(`, subsequent lines are consumed until the depth returns to zero —
 * they are part of the decorator, not method declarations.
 *
 * @param {string} content  File source text.
 * @returns {HandlerResult[]}
 */
function parseControllerHandlers(content) {
  const lines = content.split("\n");
  const handlers = [];

  let classDecorators = emptyDecorators();
  let pending = emptyDecorators();
  let inClass = false;
  // Tracks unclosed parens inside a multi-line decorator argument block.
  let decoratorParenDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments — they do NOT break a decorator block.
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }

    // If we are inside the argument list of a multi-line decorator, consume
    // lines until the depth returns to zero, then resume normal parsing.
    if (decoratorParenDepth > 0) {
      for (const ch of trimmed) {
        if (ch === "(") decoratorParenDepth++;
        else if (ch === ")") decoratorParenDepth--;
      }
      continue;
    }

    // Decorator line.
    if (trimmed.startsWith("@")) {
      // Determine if this decorator's argument list is still open at end of line.
      let depth = 0;
      for (const ch of trimmed) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      if (depth > 0) decoratorParenDepth = depth; // multi-line decorator

      if (PUBLIC_RE.test(trimmed)) pending.isPublic = true;
      if (UNIVERSAL_RE.test(trimmed)) pending.isUniversal = true;
      if (PERMISSION_RE.test(trimmed)) pending.isPermissioned = true;
      if (IN_SERVICE_RE.test(trimmed)) pending.isInService = true;
      if (HTTP_VERB_RE.test(trimmed)) pending.hasHttpVerb = true;
      continue;
    }

    // Class declaration — flush pending buffer into class-level decorators.
    if (CLASS_RE.test(trimmed)) {
      classDecorators = { ...pending };
      pending = emptyDecorators();
      inClass = true;
      continue;
    }

    // Handler declaration (pending has at least one HTTP verb decorator).
    if (inClass && pending.hasHttpVerb) {
      const m = trimmed.match(METHOD_RE);
      if (m && !KEYWORDS.has(m[1]) && m[1] !== "constructor") {
        // Handler-level classification takes priority (NestJS getAllAndOverride).
        const handlerHasAny =
          pending.isPublic || pending.isUniversal || pending.isPermissioned || pending.isInService;
        let classification;
        if (handlerHasAny) {
          if (pending.isPublic) classification = "public";
          else if (pending.isUniversal) classification = "universal";
          else if (pending.isInService) classification = "in-service";
          else classification = "permissioned";
        } else {
          // Fall back to class-level.
          if (classDecorators.isPublic) classification = "public";
          else if (classDecorators.isUniversal) classification = "universal";
          else if (classDecorators.isInService) classification = "in-service";
          else if (classDecorators.isPermissioned) classification = "permissioned";
          else classification = "UNDECLARED";
        }
        handlers.push({ method: m[1], classification });
      }
    }

    // Any non-decorator non-comment non-blank line resets the pending buffer.
    pending = emptyDecorators();
  }

  return handlers;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function runSelfTest() {
  const checks = {};

  // --- Fixture: public class, no method-level override ---
  const publicClass = `
@Public()
@Controller("auth")
class AuthController {
  @Post("login")
  login() {}

  @Get("status")
  status() {}
}
`;
  const r1 = parseControllerHandlers(publicClass);
  checks.publicClassAppliesToAllHandlers =
    r1.length === 2 && r1.every((h) => h.classification === "public");

  // --- Fixture: permissioned class with one public override ---
  const mixed = `
@Controller("mixed")
@UseGuards(JwtAuthGuard)
class MixedController {
  @Get()
  @Public()
  healthz() {}

  @Get("data")
  @RequirePermission("data:read")
  getData() {}
}
`;
  const r2 = parseControllerHandlers(mixed);
  const healthz = r2.find((h) => h.method === "healthz");
  const getData = r2.find((h) => h.method === "getData");
  checks.handlerLevelPublicOverridesClass = healthz?.classification === "public";
  checks.handlerLevelPermissionParsed = getData?.classification === "permissioned";

  // --- Fixture: no classification at all ---
  const undeclared = `
@Controller("bad")
class BadController {
  @Get()
  missing() {}
}
`;
  const r3 = parseControllerHandlers(undeclared);
  checks.undeclaredDetected = r3.length === 1 && r3[0]?.classification === "UNDECLARED";

  // --- Fixture: universal class ---
  const universal = `
@Universal()
@Controller("me")
class MeController {
  @Get()
  me() {}

  @Patch("profile")
  update() {}
}
`;
  const r4 = parseControllerHandlers(universal);
  checks.universalClassAppliesToAllHandlers =
    r4.length === 2 && r4.every((h) => h.classification === "universal");

  // --- Fixture: keyword false-positive guard ---
  const withKeywords = `
@Controller("things")
class ThingController {
  @Get()
  @RequirePermission("things:view")
  list() {
    if (x) return y;
    for (const z of arr) {}
  }
}
`;
  const r5 = parseControllerHandlers(withKeywords);
  checks.keywordsInsideBodyDoNotCreateFakeHandlers = r5.length === 1;

  // --- Fixture: async handler ---
  const asyncHandler = `
@Controller("async")
class AsyncController {
  @Post()
  @RequirePermission("foo:create")
  async create() {}
}
`;
  const r6 = parseControllerHandlers(asyncHandler);
  checks.asyncHandlerClassifiedCorrectly = r6[0]?.classification === "permissioned";

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(
    JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--self-test")) runSelfTest();

const asJson = args.includes("--json");
const verbose = args.includes("--verbose");

/** @type {FileResult[]} */
const results = [];

for (const filePath of walk(SRC_ROOT)) {
  const content = readFileSync(filePath, "utf8");
  const handlers = parseControllerHandlers(content);
  if (handlers.length > 0) {
    results.push({ file: relative(SRC_ROOT, filePath), handlers });
  }
}

// Count totals.
let totalHandlers = 0;
let totalPublic = 0;
let totalUniversal = 0;
let totalPermissioned = 0;
let totalUndeclared = 0;
let totalInService = 0;

/** @type {{ file: string, handler: string }[]} */
const undeclaredList = [];

for (const { file, handlers } of results) {
  for (const { method, classification } of handlers) {
    totalHandlers++;
    if (classification === "public") totalPublic++;
    else if (classification === "universal") totalUniversal++;
    else if (classification === "permissioned") totalPermissioned++;
    else if (classification === "in-service") totalInService++;
    else {
      totalUndeclared++;
      undeclaredList.push({ file, handler: method });
    }
  }
}

if (totalHandlers === 0) {
  process.stdout.write(
    "ERROR: No HTTP handlers found. Is the working directory correct?\n",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (asJson) {
  process.stdout.write(
    JSON.stringify(
      {
        summary: {
          total: totalHandlers,
          public: totalPublic,
          universal: totalUniversal,
          permissioned: totalPermissioned,
          inService: totalInService,
          undeclared: totalUndeclared,
        },
        undeclared: undeclaredList,
        ...(verbose ? { all: results } : {}),
      },
      null,
      2,
    ) + "\n",
  );
} else {
  process.stdout.write(
    `\nRoute classification report\n` +
      `  Total handlers : ${totalHandlers}\n` +
      `  public         : ${totalPublic}\n` +
      `  universal      : ${totalUniversal}\n` +
      `  permissioned   : ${totalPermissioned}\n` +
      `  in-service     : ${totalInService}\n` +
      `  UNDECLARED     : ${totalUndeclared}\n`,
  );

  if (totalUndeclared > 0) {
    process.stdout.write(`\nUNDECLARED routes (add @Public, @Universal, @RequirePermission or @AuthorizedInService):\n`);
    for (const { file, handler } of undeclaredList) {
      process.stdout.write(`  ${file}  →  ${handler}\n`);
    }
  }

  if (verbose && results.length > 0) {
    process.stdout.write(`\nFull handler list:\n`);
    for (const { file, handlers } of results) {
      for (const { method, classification } of handlers) {
        process.stdout.write(`  [${classification.padEnd(12)}]  ${file}  →  ${method}\n`);
      }
    }
  }

  process.stdout.write(
    `\n${totalUndeclared === 0 ? "RESULT: ALL ROUTES CLASSIFIED" : `RESULT: ${totalUndeclared} UNDECLARED ROUTE(S) — fix before enabling REQUIRE_ROUTE_CLASSIFICATION`}\n`,
  );
}

process.exit(totalUndeclared > 0 ? 1 : 0);
