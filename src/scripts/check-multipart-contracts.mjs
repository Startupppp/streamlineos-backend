#!/usr/bin/env node
/**
 * check-multipart-contracts.mjs
 *
 * WHAT IT CHECKS
 * Every handler that uses a NestJS file upload interceptor
 * (FileInterceptor, FilesInterceptor, AnyFilesInterceptor, FileFieldsInterceptor)
 * MUST carry exactly one of:
 *   @MultipartAction(…)   — tells the OpenAPI builder to emit multipart/form-data
 *   @BodylessAction()     — tells the OpenAPI builder to skip the request body entirely
 *                           (legitimate for webhook receivers whose body is raw provider payload)
 *
 * A handler with a file interceptor and NEITHER decorator produces an application/json
 * request body in OpenAPI, which does not match what the client actually sends.
 *
 * HOW IT WORKS
 * Static line-by-line scan of every *.controller.ts under src/:
 *   1. Multi-line decorators are collapsed to one line (same logic as
 *      check-bodyless-conflicts.mjs).
 *   2. A "decorator block" is any contiguous sequence of lines beginning with @.
 *   3. A block containing an HTTP-verb decorator is a handler.
 *   4. For each such handler: if the block contains a file-interceptor reference
 *      but neither @MultipartAction( nor @BodylessAction(), flag it.
 *
 * SELF-TEST (--self-test)
 * Runs synthetic cases through the same detection functions and asserts each
 * expected outcome.
 *
 * Usage:
 *   node src/scripts/check-multipart-contracts.mjs [--self-test]
 *   pnpm check:multipart-contracts
 *   pnpm check:multipart-contracts:self-test
 *
 * Exit codes:
 *   0 — clean (or self-test passed)
 *   1 — one or more undeclared multipart handlers found (or self-test failed)
 *   2 — no controller files found (working-directory issue), or self-test error
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC_ROOT = join(__dirname, "..");

const HTTP_VERB_RE = /^@(Get|Post|Put|Patch|Delete)\b/;
const FILE_INTERCEPTOR_RE =
  /\b(FileInterceptor|FilesInterceptor|AnyFilesInterceptor|FileFieldsInterceptor)\s*\(/;
const MULTIPART_ACTION_RE = /^@MultipartAction\s*\(/;
const BODYLESS_ACTION_RE = /^@BodylessAction\s*\(\s*\)/;

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
 * @typedef {{ handler: string, file: string, lineNum: number }} Finding
 */

/**
 * Parse a single controller source and return handlers that use a file
 * interceptor without @MultipartAction or @BodylessAction.
 *
 * @param {string} rawContent  File source text.
 * @param {string} filePath    Display path for reporting.
 * @returns {Finding[]}
 */
export function findUndeclaredMultipartHandlers(rawContent, filePath) {
  const content = collapseMultilineDecorators(rawContent);
  const lines = content.split("\n");
  const findings = [];

  let decoratorBlock = [];
  let decoratorBlockStart = -1;
  let hasHttpVerb = false;
  let inClass = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"))
      continue;

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

    const hasFileInterceptor = decoratorBlock.some((d) => FILE_INTERCEPTOR_RE.test(d));
    if (hasFileInterceptor) {
      const hasMultipart = decoratorBlock.some((d) => MULTIPART_ACTION_RE.test(d));
      const hasBodyless = decoratorBlock.some((d) => BODYLESS_ACTION_RE.test(d));
      if (!hasMultipart && !hasBodyless) {
        findings.push({
          handler: extractHandlerName(trimmed),
          file: filePath,
          lineNum: decoratorBlockStart,
        });
      }
    }

    decoratorBlock = [];
    hasHttpVerb = false;
  }

  return findings;
}

function extractHandlerName(declarationLine) {
  const m = declarationLine.match(/(?:async\s+)?(\w+)\s*[(<]/);
  return m ? m[1] : declarationLine.slice(0, 40).trim();
}

if (SELF_TEST) {
  process.stdout.write("Running self-test...\n");
  let failed = false;

  const pass = (label) => process.stdout.write(`  [pass] ${label}\n`);
  const fail = (label, detail) => {
    process.stderr.write(`  [FAIL] ${label}: ${detail}\n`);
    failed = true;
  };

  const run = (src) => findUndeclaredMultipartHandlers(src, "test.controller.ts");

  const withMultipart = `
class Ctrl {
  @Post("upload")
  @MultipartAction({ file: "file", fields: { folder: "string" } })
  @UseInterceptors(FileInterceptor("file"))
  async upload(@UploadedFile() file: Express.Multer.File) {}
}
`;
  const r1 = run(withMultipart);
  if (r1.length !== 0)
    fail("multipart-declared", `expected 0, got ${JSON.stringify(r1)}`);
  else pass("no-finding: handler with @MultipartAction + FileInterceptor is clean");

  const withBodyless = `
class Ctrl {
  @Post("webhook")
  @BodylessAction()
  @UseInterceptors(FileInterceptor("payload"))
  async webhook() {}
}
`;
  const r2 = run(withBodyless);
  if (r2.length !== 0)
    fail("bodyless-declared", `expected 0, got ${JSON.stringify(r2)}`);
  else pass("no-finding: handler with @BodylessAction + FileInterceptor is clean");

  const undeclared = `
class Ctrl {
  @Post("import")
  @UseInterceptors(FileInterceptor("file"))
  @Validate({ body: importSchema })
  async import(@UploadedFile() file: Express.Multer.File, @Body() body: ImportDto) {}
}
`;
  const r3 = run(undeclared);
  if (r3.length !== 1)
    fail("undeclared-flagged", `expected 1 finding, got ${JSON.stringify(r3)}`);
  else pass("finding: FileInterceptor without @MultipartAction or @BodylessAction is flagged");

  const noInterceptor = `
class Ctrl {
  @Post("create")
  @Validate({ body: createSchema })
  async create(@Body() body: CreateDto) {}
}
`;
  const r4 = run(noInterceptor);
  if (r4.length !== 0)
    fail("no-interceptor-clean", `expected 0, got ${JSON.stringify(r4)}`);
  else pass("no-finding: handler without a file interceptor is not flagged");

  const fileFieldsInterceptor = `
class Ctrl {
  @Post("submit")
  @UseInterceptors(FileFieldsInterceptor([{ name: "screenshot" }, { name: "recording" }]))
  async submit(@UploadedFiles() files: Record<string, Express.Multer.File[]>) {}
}
`;
  const r5 = run(fileFieldsInterceptor);
  if (r5.length !== 1)
    fail("file-fields-undeclared", `expected 1 finding for FileFieldsInterceptor, got ${JSON.stringify(r5)}`);
  else pass("finding: FileFieldsInterceptor without declaration is flagged");

  const fileFieldsWithMultipart = `
class Ctrl {
  @Post("submit")
  @MultipartAction({ file: "screenshot", fileRequired: false, additionalFiles: ["recording"] })
  @UseInterceptors(FileFieldsInterceptor([{ name: "screenshot" }, { name: "recording" }]))
  async submit(@UploadedFiles() files: Record<string, Express.Multer.File[]>) {}
}
`;
  const r6 = run(fileFieldsWithMultipart);
  if (r6.length !== 0)
    fail("file-fields-declared", `expected 0, got ${JSON.stringify(r6)}`);
  else pass("no-finding: FileFieldsInterceptor + @MultipartAction is clean");

  const getHandler = `
class Ctrl {
  @Get("download")
  @UseInterceptors(FileInterceptor("file"))
  async download() {}
}
`;
  const r7 = run(getHandler);
  if (r7.length !== 1)
    fail("get-with-interceptor-flagged", `expected 1 finding for GET with file interceptor, got ${JSON.stringify(r7)}`);
  else pass("finding: GET with FileInterceptor is also flagged (unusual but wrong)");

  const multilineDecorator = `
class Ctrl {
  @Post("upload")
  @MultipartAction({
    file: "file",
    fields: { type: "string" },
    requiredFields: ["type"],
  })
  @UseInterceptors(FileInterceptor("file"))
  async upload() {}
}
`;
  const r8 = run(multilineDecorator);
  if (r8.length !== 0)
    fail("multiline-multipart-declared", `expected 0 for multi-line @MultipartAction, got ${JSON.stringify(r8)}`);
  else pass("no-finding: multi-line @MultipartAction is collapsed and detected correctly");

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
    "check-multipart-contracts: no *.controller.ts files found under src/\n" +
    "Check the working directory (should be the backend root).\n",
  );
  process.exit(2);
}

const allFindings = [];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
  const findings = findUndeclaredMultipartHandlers(content, rel);
  allFindings.push(...findings);
}

process.stdout.write(
  `check-multipart-contracts: scanned ${String(files.length)} controller file(s)\n`,
);

if (allFindings.length === 0) {
  process.stdout.write(
    "  OK — every handler with a file interceptor carries @MultipartAction or @BodylessAction\n",
  );
  process.exit(0);
}

process.stderr.write(
  `check-multipart-contracts: FAIL — ${String(allFindings.length)} handler(s) use a file interceptor without a multipart contract\n\n`,
);
for (const { handler, file, lineNum } of allFindings) {
  process.stderr.write(`  ${file}:${String(lineNum)}\n`);
  process.stderr.write(`    handler: ${handler}\n`);
}
process.stderr.write(
  "\nFor each listed handler: add @MultipartAction({ file: \"<fieldName>\", ... }) to declare\n" +
  "the multipart/form-data schema, or @BodylessAction() if the body is a raw provider payload\n" +
  "that bypasses Zod validation (e.g. webhook receivers with signature verification).\n",
);
process.exit(1);
