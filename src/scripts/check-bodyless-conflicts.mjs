#!/usr/bin/env node
/**
 * check-bodyless-conflicts.mjs
 *
 * WHAT IT CHECKS
 * @BodylessAction() tells check:openapi-coverage to skip that handler from
 * both the numerator and denominator of the request-schema coverage metric.
 * A false mark is completely invisible to the gate — coverage does not move
 * and the gate exits 0.
 *
 * A handler is a conflict if it carries @BodylessAction() AND:
 *   (a) its decorator block also contains @Validate({ ... body: ... }), OR
 *   (b) its parameter list contains @Body( (a direct NestJS @Body() decorator)
 *
 * HOW IT WORKS
 * Static line-by-line scan of every *.controller.ts under src/:
 *   1. Multi-line decorators are joined onto one line (collapseMultilineDecorators,
 *      identical to route-classification-report.mjs).
 *   2. A "decorator block" is any contiguous sequence of lines beginning with @
 *      (blank lines and comments do not break it).
 *   3. A block containing an HTTP-verb decorator is a handler.
 *   4. For each such handler:
 *        — if @BodylessAction() is in the block AND @Validate with body: is too
 *          → conflict (case a)
 *        — if @BodylessAction() is in the block AND @Body( appears in the
 *          method signature lines (up to the opening { of the body) → conflict (case b)
 *
 * SELF-TEST (--self-test)
 * Runs synthetic cases through the same detection functions and asserts each
 * expected outcome.  Same code path as the real scan.
 *
 * Usage:
 *   node src/scripts/check-bodyless-conflicts.mjs [--self-test]
 *   pnpm check:bodyless-conflicts
 *   pnpm check:bodyless-conflicts:self-test
 *
 * Exit codes:
 *   0 — clean (or self-test passed)
 *   1 — one or more conflicts found (or self-test failed)
 *   2 — no controller files found (working-directory issue), or self-test error
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC_ROOT = join(__dirname, "..");

const HTTP_VERB_RE = /^@(Get|Post|Put|Patch|Delete)\b/;
const BODYLESS_RE = /^@BodylessAction\s*\(\s*\)/;
const VALIDATE_BODY_RE = /^@Validate\s*\(\s*\{[^}]*\bbody\s*:/;
const BODY_PARAM_RE = /@Body\s*\(/;
const REQ_BODY_RE = /\breq\.body\b/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (entry.endsWith(".controller.ts")) yield full;
  }
}

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

/**
 * @typedef {{ handler: string, file: string, lineNum: number, reason: string }} Conflict
 */

/**
 * Parse a single controller source and return all @BodylessAction conflicts.
 *
 * @param {string} rawContent  File source text.
 * @param {string} filePath    Display path for reporting.
 * @returns {Conflict[]}
 */
export function findBodylessConflicts(rawContent, filePath) {
  const content = collapseMultilineDecorators(rawContent);
  const lines = content.split("\n");
  const conflicts = [];

  let decoratorBlock = [];
  let decoratorBlockStart = -1;
  let hasHttpVerb = false;
  let inClass = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }

    if (trimmed.startsWith("@")) {
      if (decoratorBlock.length === 0) decoratorBlockStart = i + 1;
      decoratorBlock.push(trimmed);
      if (HTTP_VERB_RE.test(trimmed)) hasHttpVerb = true;
      continue;
    }

    if (trimmed.startsWith("class ") || trimmed.match(/^\w.*\bclass\b/)) {
      decoratorBlock = [];
      hasHttpVerb = false;
      inClass = true;
      continue;
    }

    if (!inClass || !hasHttpVerb) {
      decoratorBlock = [];
      hasHttpVerb = false;
      continue;
    }

    const isBodyless = decoratorBlock.some((d) => BODYLESS_RE.test(d));

    if (isBodyless) {
      const hasValidateBody = decoratorBlock.some((d) => VALIDATE_BODY_RE.test(d));

      const handlerLineNum = decoratorBlockStart;
      const handlerName = extractHandlerName(trimmed);

      if (hasValidateBody) {
        conflicts.push({
          handler: handlerName,
          file: filePath,
          lineNum: handlerLineNum,
          reason: "@BodylessAction() but @Validate has a body: key",
        });
      } else {
        const signatureLines = collectSignatureLines(lines, i);
        const signatureText = signatureLines.join(" ");
        if (BODY_PARAM_RE.test(signatureText)) {
          conflicts.push({
            handler: handlerName,
            file: filePath,
            lineNum: handlerLineNum,
            reason: "@BodylessAction() but method has a @Body( parameter",
          });
        } else {
          const bodyLines = collectMethodBodyLines(lines, i);
          const bodyText = bodyLines.join(" ");
          if (REQ_BODY_RE.test(bodyText)) {
            conflicts.push({
              handler: handlerName,
              file: filePath,
              lineNum: handlerLineNum,
              reason: "@BodylessAction() but method reads req.body directly",
            });
          }
        }
      }
    }

    decoratorBlock = [];
    hasHttpVerb = false;
  }

  return conflicts;
}

function extractHandlerName(declarationLine) {
  const m = declarationLine.match(/(?:async\s+)?(\w+)\s*[(<]/);
  return m ? m[1] : declarationLine.slice(0, 40).trim();
}

function collectSignatureLines(lines, startIdx) {
  const collected = [lines[startIdx]];
  let depth = 0;
  for (const ch of lines[startIdx]) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  if (depth <= 0) return collected;

  for (let j = startIdx + 1; j < lines.length && j < startIdx + 30; j++) {
    const l = lines[j];
    collected.push(l);
    for (const ch of l) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    if (depth <= 0) break;
  }
  return collected;
}

function collectMethodBodyLines(lines, startIdx) {
  const collected = [];
  let braceDepth = 0;
  let foundOpen = false;
  for (let j = startIdx; j < lines.length && j < startIdx + 150; j++) {
    const l = lines[j];
    collected.push(l);
    for (const ch of l) {
      if (ch === "{") { braceDepth++; foundOpen = true; }
      else if (ch === "}" && foundOpen) braceDepth--;
    }
    if (foundOpen && braceDepth <= 0) break;
  }
  return collected;
}

if (SELF_TEST) {
  process.stdout.write("Running self-test...\n");
  let failed = false;

  const pass = (label) => process.stdout.write(`  [pass] ${label}\n`);
  const fail = (label, detail) => {
    process.stderr.write(`  [FAIL] ${label}: ${detail}\n`);
    failed = true;
  };

  const run = (src) => findBodylessConflicts(src, "test.controller.ts");

  const clean = `
class Ctrl {
  @Post("submit")
  @BodylessAction()
  @Validate({ params: idParams })
  async submit(@Param("id") id: string) {}
}
`;
  const r1 = run(clean);
  if (r1.length !== 0)
    fail("no-conflict-params-only", `expected 0, got ${JSON.stringify(r1)}`);
  else pass("no-conflict: @BodylessAction + @Validate(params only) is clean");

  const validateBodyConflict = `
class Ctrl {
  @Post("create")
  @BodylessAction()
  @Validate({ body: createSchema })
  async create(@Body() body: CreateDto) {}
}
`;
  const r2 = run(validateBodyConflict);
  if (r2.length !== 1 || !r2[0].reason.includes("body: key"))
    fail("validate-body-conflict", `expected 1 validate-body conflict, got ${JSON.stringify(r2)}`);
  else pass("conflict: @BodylessAction + @Validate({ body: ... }) is flagged");

  const bodyParamConflict = `
class Ctrl {
  @Post("update")
  @BodylessAction()
  async update(
    @Param("id") id: string,
    @Body() body: UpdateDto,
  ) {}
}
`;
  const r3 = run(bodyParamConflict);
  if (r3.length !== 1 || !r3[0].reason.includes("@Body("))
    fail("body-param-conflict", `expected 1 @Body() param conflict, got ${JSON.stringify(r3)}`);
  else pass("conflict: @BodylessAction + @Body() parameter is flagged");

  const noBodyless = `
class Ctrl {
  @Post("reject")
  @Validate({ body: rejectSchema })
  async reject(@Body() body: RejectDto) {}
}
`;
  const r4 = run(noBodyless);
  if (r4.length !== 0)
    fail("no-bodyless-no-conflict", `expected 0 conflicts without @BodylessAction(), got ${JSON.stringify(r4)}`);
  else pass("no-conflict: @Validate(body) without @BodylessAction() is not flagged");

  const noHttpVerb = `
class Ctrl {
  @BodylessAction()
  @Validate({ body: createSchema })
  helperMethod(@Body() body: CreateDto) {}
}
`;
  const r5 = run(noHttpVerb);
  if (r5.length !== 0)
    fail("no-http-verb-no-flag", `non-HTTP helper with @BodylessAction should not be flagged, got ${JSON.stringify(r5)}`);
  else pass("no-conflict: non-HTTP handler with @BodylessAction is not flagged");

  const multiLine = `
class Ctrl {
  @Post("create")
  @BodylessAction()
  @Validate({
    body: createSchema,
  })
  async create() {}
}
`;
  const r6 = run(multiLine);
  if (r6.length !== 1 || !r6[0].reason.includes("body: key"))
    fail("multiline-validate-body", `expected 1 conflict for multi-line @Validate with body, got ${JSON.stringify(r6)}`);
  else pass("conflict: multi-line @Validate collapsed to single line, body: key detected");

  const bodylessOnGetBody = `
class Ctrl {
  @Get("download/:id")
  @BodylessAction()
  async download(@Param("id") id: string) {}

  @Post("ingest")
  @Validate({ body: ingestSchema })
  async ingest(@Body() body: IngestDto) {}
}
`;
  const r7 = run(bodylessOnGetBody);
  if (r7.length !== 0)
    fail("get-bodyless-no-conflict", `GET with @BodylessAction and no body should be clean, got ${JSON.stringify(r7)}`);
  else pass("no-conflict: @BodylessAction on GET with no body key is clean");

  const reqBodyDirect = `
class Ctrl {
  @Post("webhook")
  @BodylessAction()
  async webhook(@Req() req: Request) {
    const data = req.body;
    return { ok: true };
  }
}
`;
  const r8 = run(reqBodyDirect);
  if (r8.length !== 1 || !r8[0].reason.includes("req.body"))
    fail("req-body-direct", `expected 1 req.body conflict, got ${JSON.stringify(r8)}`);
  else pass("conflict: @BodylessAction + direct req.body read is flagged");

  const reqBodyNonBodyless = `
class Ctrl {
  @Post("track")
  async track(@Req() req: Request) {
    const data = req.body;
    return data;
  }
}
`;
  const r9 = run(reqBodyNonBodyless);
  if (r9.length !== 0)
    fail("req-body-no-bodyless", `no @BodylessAction mark, should not flag, got ${JSON.stringify(r9)}`);
  else pass("no-conflict: req.body without @BodylessAction() is not flagged");

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

const files = [...walk(SRC_ROOT)];
if (files.length === 0) {
  process.stderr.write(
    "check-bodyless-conflicts: no *.controller.ts files found under src/\n" +
    "Check the working directory (should be the backend root).\n",
  );
  process.exit(2);
}

const allConflicts = [];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
  const conflicts = findBodylessConflicts(content, rel);
  allConflicts.push(...conflicts);
}

process.stdout.write(
  `check-bodyless-conflicts: scanned ${String(files.length)} controller file(s)\n`,
);

if (allConflicts.length === 0) {
  process.stdout.write("  OK — no @BodylessAction conflicts found\n");
  process.exit(0);
}

process.stderr.write(
  `check-bodyless-conflicts: FAIL — ${String(allConflicts.length)} handler(s) carry @BodylessAction() but also read a body\n\n`,
);
for (const { handler, file, lineNum, reason } of allConflicts) {
  process.stderr.write(`  ${file}:${String(lineNum)}\n`);
  process.stderr.write(`    handler: ${handler}\n`);
  process.stderr.write(`    reason:  ${reason}\n`);
}
process.stderr.write(
  "\nFor each listed handler: either remove @BodylessAction() (preferred),\n" +
  "or remove the body schema / @Body() parameter if the body is genuinely unused.\n",
);
process.exit(1);
