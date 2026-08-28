/**
 * check-tenant-isolation-coverage.mjs
 *
 * Enumerates every service class in modules/ that holds a Drizzle `db` handle
 * and reports which have NO cross-tenant negative test.
 *
 * "Tenant-owned" = the service queries with an orgId predicate.
 * "Global/platform" = the service queries identity or catalog tables that
 *   RLS does not govern (users, organizations, sessions, …).
 *
 * Anti-vacuity: the scan asserts it found more than MIN_SERVICES service files
 * and more than MIN_TEST_FILES isolation test files.  A broken filesystem walk
 * that matches zero files reports 100% covered — that is a bug, not a pass.
 *
 * Usage:  node src/scripts/check-tenant-isolation-coverage.mjs [--self-test]
 *          node src/scripts/check-tenant-isolation-coverage.mjs [--report-json <path>]
 * Exit:   0 clean (or self-test passed)
 *         1 services below the isolation-coverage baseline exist
 *         2 broken filesystem walk (vacuity check failed)
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const MODULES_DIR = join(BACKEND_ROOT, "src", "modules");
const TEST_DIR = join(BACKEND_ROOT, "test");

const args = process.argv.slice(2);
const SELF_TEST = args.includes("--self-test");
const JSON_PATH = (() => {
  const idx = args.indexOf("--report-json");
  return idx !== -1 ? args[idx + 1] : null;
})();

const SPEC_RE = /\.(spec|e2e-spec)\.ts$/;
const SERVICE_RE = /\.service\.ts$/;

const MIN_SERVICES = 100;
const MIN_TEST_FILES = 5;

const GLOBAL_SERVICE_PATTERNS = [
  /auth\.service/,
  /session\.service/,
  /users\.service/,
  /email\.service/,
  /mailer\.service/,
  /platform-admin/,
  /health\./,
  /metrics\./,
  /redis\.service/,
  /cache\.service/,
];

const ISOLATION_PATTERNS = [
  /cross.?tenant/i,
  /tenant.?isolation/i,
  /different.?org/i,
  /other.?org/i,
  /org.?isolation/i,
  /bola/i,
  /cross-org/i,
  /isolation/i,
  /inaccessible/i,
  /forbidden.*org/i,
  /wrong.*org/i,
];

function walkTs(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkTs(full));
    else if (entry.name.endsWith(".ts")) results.push(full);
  }
  return results;
}

function hasDbHandle(src) {
  return (
    src.includes("@Inject(DRIZZLE)") ||
    src.includes("Inject(DRIZZLE)") ||
    /private\s+readonly\s+db\s*:\s*Db\b/.test(src)
  );
}

function isGlobalService(filePath) {
  const rel = relative(BACKEND_ROOT, filePath).replace(/\\/g, "/");
  return GLOBAL_SERVICE_PATTERNS.some((re) => re.test(rel));
}

function isTenantOwned(src) {
  return (
    src.includes("orgId") &&
    (src.includes("eq(") || src.includes(".where(") || src.includes("and("))
  );
}

function serviceBaseName(filePath) {
  return filePath
    .split(/[\\/]/)
    .pop()
    .replace(/\.service\.ts$/, "");
}

function serviceClassName(src) {
  const match = src.match(/export\s+class\s+([A-Za-z0-9_]+Service)/);
  return match ? match[1] : null;
}

function hasIsolationTest(serviceFile, allSpecFiles) {
  const name = serviceBaseName(serviceFile);
  const className = serviceClassName(readFileSync(serviceFile, "utf8"));
  const serviceDir = dirname(serviceFile);

  for (const specFile of allSpecFiles) {
    const specSrc = readFileSync(specFile, "utf8");

    const referencesService =
      specSrc.includes(name) || (className && specSrc.includes(className));

    if (!referencesService) continue;

    const hasIsolationPattern = ISOLATION_PATTERNS.some((re) => re.test(specSrc));
    if (hasIsolationPattern) return true;
  }
  return false;
}

// ─── self-test ────────────────────────────────────────────────────────────────

if (SELF_TEST) {
  const goodServiceSrc = `
    import { Inject, Injectable } from "@nestjs/common";
    import { DRIZZLE } from "../../db/drizzle.constants";
    import type { Db } from "../../db/drizzle.module";
    import { eq } from "drizzle-orm";
    import { contacts } from "../../db/schema";

    @Injectable()
    export class ContactsService {
      constructor(@Inject(DRIZZLE) private readonly db: Db) {}
      list(orgId: string) {
        return this.db.select().from(contacts).where(eq(contacts.orgId, orgId));
      }
    }
  `;
  const badServiceSrc = `
    import { Inject, Injectable } from "@nestjs/common";
    import { DRIZZLE } from "../../db/drizzle.constants";
    import type { Db } from "../../db/drizzle.module";

    @Injectable()
    export class GlobalCatalogService {
      constructor(@Inject(DRIZZLE) private readonly db: Db) {}
      listFeatures() { return this.db.select().from(features); }
    }
  `;
  const isolationSpecSrc = `
    describe("ContactsService tenant isolation", () => {
      it("hides rows from a different org", async () => {
        const result = await service.list("other-org-id");
        expect(result).toHaveLength(0);
      });
    });
  `;
  const nonIsolationSpecSrc = `
    describe("ContactsService", () => {
      it("returns contacts", async () => {
        const result = await service.list("org-1");
        expect(result).toHaveLength(2);
      });
    });
  `;

  const checks = {
    hasDbHandleDetectsInjectDrizzle: hasDbHandle(goodServiceSrc),
    hasDbHandleDetectsPrivateDb: hasDbHandle(badServiceSrc),
    isTenantOwnedRequiresOrgIdAndFilter: isTenantOwned(goodServiceSrc) === true,
    isTenantOwnedFalseWithoutOrgId: isTenantOwned(badServiceSrc) === false,
    classNameExtraction: serviceClassName(goodServiceSrc) === "ContactsService",
    isolationPatternMatchesIsolationSpec: ISOLATION_PATTERNS.some((re) =>
      re.test(isolationSpecSrc),
    ),
    isolationPatternMissesNonIsolationSpec: !ISOLATION_PATTERNS.some((re) =>
      re.test(nonIsolationSpecSrc),
    ),
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

// ─── scan ─────────────────────────────────────────────────────────────────────

if (!existsSync(MODULES_DIR)) {
  process.stderr.write(`Cannot find modules dir: ${MODULES_DIR}\n`);
  process.exit(2);
}

const allFiles = walkTs(MODULES_DIR);
const allTestFiles = [
  ...walkTs(TEST_DIR),
  ...allFiles.filter((f) => SPEC_RE.test(f)),
];

const serviceFiles = allFiles.filter(
  (f) => SERVICE_RE.test(f) && !SPEC_RE.test(f),
);
const serviceFilesWithDb = serviceFiles.filter((f) =>
  hasDbHandle(readFileSync(f, "utf8")),
);
const isolationSpecFiles = allTestFiles.filter((f) => {
  const src = readFileSync(f, "utf8");
  return ISOLATION_PATTERNS.some((re) => re.test(src));
});

// Anti-vacuity
if (serviceFilesWithDb.length < MIN_SERVICES) {
  process.stderr.write(
    `Found only ${serviceFilesWithDb.length} service files with a db handle (expected >${MIN_SERVICES}). ` +
      `The filesystem walk is broken or the path is wrong.\n`,
  );
  process.exit(2);
}
if (isolationSpecFiles.length < MIN_TEST_FILES) {
  process.stderr.write(
    `Found only ${isolationSpecFiles.length} isolation test files (expected >${MIN_TEST_FILES}). ` +
      `The filesystem walk is broken or the isolation-pattern list is wrong.\n`,
  );
  process.exit(2);
}

const tenantServices = serviceFilesWithDb.filter(
  (f) => !isGlobalService(f) && isTenantOwned(readFileSync(f, "utf8")),
);
const globalServices = serviceFilesWithDb.filter(
  (f) => isGlobalService(f) || !isTenantOwned(readFileSync(f, "utf8")),
);

const covered = tenantServices.filter((f) =>
  hasIsolationTest(f, isolationSpecFiles),
);
const uncovered = tenantServices.filter(
  (f) => !hasIsolationTest(f, isolationSpecFiles),
);

const coveragePercent =
  tenantServices.length > 0
    ? Math.round((covered.length / tenantServices.length) * 100)
    : 0;

console.log(`Service files with db handle   ${serviceFilesWithDb.length}`);
console.log(`  — tenant-owned               ${tenantServices.length}`);
console.log(`  — global/platform            ${globalServices.length}`);
console.log(`Isolation test files found     ${isolationSpecFiles.length}`);
console.log(`Covered tenant services        ${covered.length} / ${tenantServices.length}  (${coveragePercent}%)`);
console.log("");

if (uncovered.length > 0) {
  console.log("UNCOVERED — tenant-owned services with no cross-tenant negative test:");
  for (const f of uncovered.slice(0, 50)) {
    console.log(`  MISSING  ${relative(BACKEND_ROOT, f).replace(/\\/g, "/")}`);
  }
  if (uncovered.length > 50) {
    console.log(`  … and ${uncovered.length - 50} more`);
  }
  console.log("");
}

const report = {
  serviceFilesWithDb: serviceFilesWithDb.length,
  tenantOwned: tenantServices.length,
  globalPlatform: globalServices.length,
  isolationTestFiles: isolationSpecFiles.length,
  covered: covered.length,
  uncovered: uncovered.length,
  coveragePercent,
  uncoveredFiles: uncovered.map((f) => relative(BACKEND_ROOT, f).replace(/\\/g, "/")),
};

if (JSON_PATH) {
  writeFileSync(JSON_PATH, JSON.stringify(report, null, 2));
  console.log(`Report written to ${JSON_PATH}`);
}

if (uncovered.length > 0) {
  console.error(
    `FAIL — ${uncovered.length} tenant-owned service(s) have no cross-tenant negative test (${coveragePercent}% covered).`,
  );
  process.exit(1);
}

console.log("OK — every enumerated tenant-owned service maps to at least one isolation test.");
process.exit(0);
