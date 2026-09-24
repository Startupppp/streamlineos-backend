#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const IS_ENTRY = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
const SELF_TEST = IS_ENTRY && process.argv.includes("--self-test");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const MODULES_SRC = join(BACKEND_ROOT, "src", "modules");

const MIN_ROUTES = 30;

export function extractRouteParams(path) {
  return [...path.matchAll(/:(\w+)/g)].map((m) => m[1]);
}

export function extractSchemaKeys(content, schemaName) {
  const re = new RegExp(
    `(?:export\\s+)?const\\s+${schemaName}\\s*=\\s*z\\s*\\.\\s*object\\s*\\(\\s*\\{([^}]*)\\}`,
  );
  const m = content.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/(\w+)\s*:/g)].map((km) => km[1]);
}

export function extractExtendedSchema(content, schemaName) {
  const re = new RegExp(
    `(?:export\\s+)?const\\s+${schemaName}\\s*=\\s*(\\w+)\\s*\\.\\s*(?:extend|merge)\\s*\\(\\s*\\{([^}]*)\\}`,
  );
  const m = content.match(re);
  if (!m) return null;
  return {
    base: m[1],
    ownKeys: [...m[2].matchAll(/(\w+)\s*:/g)].map((km) => km[1]),
  };
}

export function resolveSchemaKeys(filePath, content, schemaName, seen = new Set()) {
  if (seen.has(schemaName)) return null;
  seen.add(schemaName);

  const inFile = extractSchemaKeys(content, schemaName);
  if (inFile !== null) return inFile;

  const extended = extractExtendedSchema(content, schemaName);
  if (extended !== null) {
    const baseKeys = resolveSchemaKeys(filePath, content, extended.base, seen);
    if (baseKeys === null) return null;
    return [...new Set([...baseKeys, ...extended.ownKeys])];
  }

  const importRe = new RegExp(
    `import\\s*\\{[^}]*\\b${schemaName}\\b[^}]*\\}\\s*from\\s*['"\`]([^'"\`]*)['"\`]`,
  );
  const importMatch = content.match(importRe);
  if (!importMatch) return null;

  const importPath = importMatch[1];
  const fileDir = dirname(filePath);
  const resolvedPath = importPath.endsWith(".ts")
    ? resolve(fileDir, importPath)
    : resolve(fileDir, importPath + ".ts");

  try {
    const importedContent = readFileSync(resolvedPath, "utf8");
    return extractSchemaKeys(importedContent, schemaName);
  } catch {
    return null;
  }
}

export function findControllerPrefix(content, beforePos) {
  const re = /@Controller\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/g;
  let prefix = "";
  for (const m of content.slice(0, beforePos).matchAll(re)) prefix = m[1];
  return prefix;
}

export function findMethodPath(content, beforePos) {
  const re = /@(?:Get|Post|Put|Patch|Delete)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
  let path = "";
  for (const m of content.slice(0, beforePos).matchAll(re)) path = m[1] ?? "";
  return path;
}

export function analyzeControllerContent(filePath, content) {
  const violations = [];
  const unresolved = [];
  let routeCount = 0;

  const validateRe = /@Validate\s*\(\s*\{[^}]*?params\s*:\s*(\w+)/g;
  for (const vm of content.matchAll(validateRe)) {
    const schemaName = vm[1];
    const validatePos = vm.index;

    const prefix = findControllerPrefix(content, validatePos);
    const methodPath = findMethodPath(content, validatePos);
    const fullPath = [prefix, methodPath].filter(Boolean).join("/");
    const routeParams = extractRouteParams(fullPath);

    if (routeParams.length === 0) {
      routeCount++;
      continue;
    }

    const schemaKeys = resolveSchemaKeys(filePath, content, schemaName);
    if (schemaKeys === null) {
      unresolved.push({ filePath, schemaName, fullPath });
      continue;
    }

    routeCount++;
    const keySet = new Set(schemaKeys);
    const missing = routeParams.filter((p) => !keySet.has(p));
    if (missing.length > 0) {
      violations.push({ filePath, schemaName, fullPath, missing });
    }
  }

  return { violations, unresolved, routeCount };
}

function findControllerFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...findControllerFiles(full));
    } else if (entry.endsWith(".controller.ts")) {
      files.push(full);
    }
  }
  return files;
}

if (SELF_TEST) {
  process.stdout.write("Running self-test...\n");
  let failed = false;

  const pass = (label) => process.stdout.write(`  [pass] ${label}\n`);
  const fail = (label, detail) => {
    process.stderr.write(`  [FAIL] ${label}: ${detail}\n`);
    failed = true;
  };

  {
    const r = extractRouteParams("build/:projectId/test-cases/:caseId");
    if (r.length !== 2 || r[0] !== "projectId" || r[1] !== "caseId")
      fail("extractRouteParams", `expected [projectId, caseId], got ${JSON.stringify(r)}`);
    else pass("extractRouteParams extracts both prefix and method params from full path");
  }

  {
    const content = `
const caseIdParams = z.object({ caseId: z.coerce.number().int().positive() }).strict();

@Controller("build/:projectId/test-cases")
export class TestCasesController {
  @Get(":caseId")
  @RequirePermission("build:qa:view")
  @Validate({ params: caseIdParams })
  getCase() {}
}
`;
    const result = analyzeControllerContent("fake.ts", content);
    if (result.violations.length !== 1 || !result.violations[0].missing.includes("projectId"))
      fail("defect-fixture", `expected 1 violation with projectId missing, got ${JSON.stringify(result.violations)}`);
    else pass("fixture with schema missing prefix param is flagged — gate is non-vacuous for the failure case");
  }

  {
    const content = `
const caseIdParams = z.object({ projectId: z.coerce.number().int().positive(), caseId: z.coerce.number().int().positive() }).strict();

@Controller("build/:projectId/test-cases")
export class TestCasesController {
  @Get(":caseId")
  @RequirePermission("build:qa:view")
  @Validate({ params: caseIdParams })
  getCase() {}
}
`;
    const result = analyzeControllerContent("fake.ts", content);
    if (result.violations.length !== 0)
      fail("correct-fixture", `expected 0 violations, got ${JSON.stringify(result.violations)}`);
    else pass("fixture with schema declaring all params produces no violation — gate is non-vacuous for the pass case");
  }

  {
    const content = `
const resourceIdParams = z.object({ resourceId: z.coerce.number().int().positive() }).strict();

@Controller("build/resources")
export class ResourcesController {
  @Get(":resourceId")
  @Validate({ params: resourceIdParams })
  get() {}
}
`;
    const result = analyzeControllerContent("fake.ts", content);
    if (result.violations.length !== 0)
      fail("no-prefix-params", `expected 0 violations for route with no prefix params, got ${JSON.stringify(result.violations)}`);
    else pass("route with no prefix params and method-path-only schema produces no violation");
  }

  {
    const content = `
@Controller("build/:projectId/things")
export class ThingsController {
  @Get(":thingId")
  @Validate({ params: missingSchema })
  get() {}
}
`;
    const result = analyzeControllerContent("fake.ts", content);
    if (result.unresolved.length !== 1)
      fail("unresolved-schema", `expected 1 unresolved entry, got ${result.unresolved.length}`);
    else pass("schema not found in file is counted as unresolved, not silently skipped");
  }

  {
    const content = `
const pairParams = z.object({ projectId: z.coerce.number().int().positive(), itemId: z.coerce.number().int().positive() }).strict();

@Controller("build/:projectId/items")
export class ItemsController {
  @Get()
  list() {}

  @Get(":itemId")
  @Validate({ params: pairParams })
  get() {}

  @Patch(":itemId")
  @Validate({ params: pairParams })
  update() {}
}
`;
    const result = analyzeControllerContent("fake.ts", content);
    if (result.violations.length !== 0)
      fail("multi-method", `expected 0 violations for two correct routes, got ${JSON.stringify(result.violations)}`);
    else if (result.routeCount !== 2)
      fail("multi-method-count", `expected routeCount 2, got ${result.routeCount}`);
    else pass("multiple methods on same controller all pass with correct schema");
  }

  {
    const content = `
@Controller("build/things")
export class ThingsController {
  @Get()
  list() {}
}
`;
    const result = analyzeControllerContent("fake.ts", content);
    if (result.routeCount !== 0)
      fail("no-validate-params", `controller with no @Validate params should count 0 routes, got ${result.routeCount}`);
    else pass("controller with no @Validate({ params }) counts zero routes");
  }

  {
    const content = `
const submissionIdParams = z.object({ submissionId: z.coerce.number().int().positive() }).strict();
const submissionMediaParams = submissionIdParams.extend({ mediaKind: mediaKindSchema }).strict();

@Controller("feedbucket")
export class FeedbucketController {
  @Delete("submissions/:submissionId/media/:mediaKind")
  @Validate({ params: submissionMediaParams })
  remove() {}
}
`;
    const result = analyzeControllerContent("fake.ts", content);
    if (result.unresolved.length !== 0)
      fail("extend-resolved", `expected extend() chain to resolve, got ${result.unresolved.length} unresolved`);
    else if (result.violations.length !== 0)
      fail("extend-clean", `expected 0 violations, got ${JSON.stringify(result.violations)}`);
    else pass("a params schema built with .extend() resolves through its base instead of reporting unresolved");
  }

  {
    const content = `
const submissionIdParams = z.object({ submissionId: z.coerce.number().int().positive() }).strict();
const submissionMediaParams = submissionIdParams.extend({ mediaKind: mediaKindSchema }).strict();

@Controller("feedbucket/:widgetId")
export class FeedbucketController {
  @Delete("submissions/:submissionId/media/:mediaKind")
  @Validate({ params: submissionMediaParams })
  remove() {}
}
`;
    const result = analyzeControllerContent("fake.ts", content);
    if (result.violations.length !== 1 || !result.violations[0].missing.includes("widgetId"))
      fail("extend-defect", `expected widgetId flagged through the extend chain, got ${JSON.stringify(result.violations)}`);
    else pass("an .extend() chain still missing a prefix param is flagged — resolving the base did not make the check vacuous");
  }

  {
    const content = `
const orphanParams = unknownBase.extend({ mediaKind: mediaKindSchema }).strict();

@Controller("feedbucket")
export class FeedbucketController {
  @Delete("submissions/:submissionId/media/:mediaKind")
  @Validate({ params: orphanParams })
  remove() {}
}
`;
    const result = analyzeControllerContent("fake.ts", content);
    if (result.unresolved.length !== 1)
      fail("extend-unresolvable-base", `expected 1 unresolved when the base cannot be found, got ${result.unresolved.length}`);
    else pass("an .extend() on a base the gate cannot find stays unresolved rather than passing on partial keys");
  }

  {
    const content = `
const entryIdParams = z.object({ entryId: z.coerce.number().int().positive() }).strict();
const projectAndTicketIdParams = z.object({ projectId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive() }).strict();

@Controller("build/time-entries")
export class TimeEntriesController {
  @Patch(":entryId/approve")
  @Validate({ params: entryIdParams })
  approve() {}
}

@Controller("build/:projectId/tickets/:ticketId/time-entries")
export class TicketTimeEntriesController {
  @Get()
  @Validate({ params: projectAndTicketIdParams })
  list() {}
}
`;
    const result = analyzeControllerContent("fake.ts", content);
    if (result.violations.length !== 0)
      fail("multi-controller", `expected 0 violations across two controllers in one file, got ${JSON.stringify(result.violations)}`);
    else if (result.routeCount !== 2)
      fail("multi-controller-count", `expected routeCount 2, got ${result.routeCount}`);
    else pass("a file declaring two controllers resolves each route against its own nearest prefix, not the first one in the file");
  }

  {
    const content = `
const entryIdParams = z.object({ entryId: z.coerce.number().int().positive() }).strict();

@Controller("build/time-entries")
export class TimeEntriesController {
  @Patch(":entryId/approve")
  @Validate({ params: entryIdParams })
  approve() {}
}

@Controller("build/:projectId/tickets/:ticketId/time-entries")
export class TicketTimeEntriesController {
  @Get(":entryId")
  @Validate({ params: entryIdParams })
  get() {}
}
`;
    const result = analyzeControllerContent("fake.ts", content);
    const missing = result.violations[0]?.missing ?? [];
    if (result.violations.length !== 1 || !missing.includes("projectId") || !missing.includes("ticketId"))
      fail("multi-controller-defect", `expected the second controller's route flagged for projectId and ticketId, got ${JSON.stringify(result.violations)}`);
    else pass("a schema reused under a second controller with a richer prefix is flagged there — the multi-controller walk is not vacuous");
  }

  {
    if (MIN_ROUTES <= 0)
      fail("vacuity-const", "MIN_ROUTES must be positive");
    else pass(`vacuity guard constant MIN_ROUTES = ${MIN_ROUTES} is positive`);
  }

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

function runScan() {
  const files = findControllerFiles(MODULES_SRC);
  const allViolations = [];
  const allUnresolved = [];
  let totalRoutes = 0;

  for (const filePath of files) {
    const content = readFileSync(filePath, "utf8");
    const { violations, unresolved, routeCount } = analyzeControllerContent(filePath, content);
    allViolations.push(...violations);
    allUnresolved.push(...unresolved);
    totalRoutes += routeCount;
  }

  if (totalRoutes < MIN_ROUTES) {
    process.stderr.write(
      `check-params-schema-completeness: resolved only ${totalRoutes} parameterised routes — expected at least ${MIN_ROUTES}.\n` +
      `The scan is likely broken or no controller files were found under ${MODULES_SRC}.\n`,
    );
    process.exit(2);
  }

  if (allViolations.length === 0 && allUnresolved.length === 0) {
    process.stdout.write(
      `check-params-schema-completeness: OK — ${files.length} controllers, ${totalRoutes} parameterised routes checked, all strict schemas include every route param\n`,
    );
    process.exit(0);
  }

  if (allUnresolved.length > 0) {
    process.stderr.write(`check-params-schema-completeness: ${allUnresolved.length} schema(s) could not be resolved:\n\n`);
    for (const { filePath, schemaName, fullPath } of allUnresolved) {
      const rel = relative(BACKEND_ROOT, filePath).replace(/\\/g, "/");
      process.stderr.write(`  ${rel}\n    schema: ${schemaName}  route: ${fullPath}\n`);
    }
    process.stderr.write("\n");
  }

  if (allViolations.length > 0) {
    process.stderr.write(`check-params-schema-completeness: FAIL — ${allViolations.length} strict params schema(s) omit route param(s)\n\n`);
    for (const { filePath, schemaName, fullPath, missing } of allViolations) {
      const rel = relative(BACKEND_ROOT, filePath).replace(/\\/g, "/");
      process.stderr.write(`  ${rel}\n    schema: ${schemaName}  route: ${fullPath}\n    missing: ${missing.join(", ")}\n\n`);
    }
  }

  process.exit(allViolations.length > 0 || allUnresolved.length > 0 ? 1 : 0);
}

if (IS_ENTRY) runScan();
