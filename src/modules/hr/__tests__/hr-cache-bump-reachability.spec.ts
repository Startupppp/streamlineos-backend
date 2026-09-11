import fs from "node:fs";
import path from "node:path";
import { CelebrationsService } from "../directory/celebrations.service";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import { ScopedRead } from "../../access/scoped-read";

/**
 * A cache bump nobody reads, and a cached read no bump reaches, are the same
 * defect seen from opposite ends, and neither shows up in a type check, a lint
 * run or any behavioural test — the code runs, the Redis command succeeds, and
 * the stale value is served for the whole TTL.
 *
 * Three instances were live in HR when this file was written, and a fourth was
 * found by widening the scan past the ones that had been reported:
 *
 *   dead bumps   EmployeeOnboardingService.invalidateHrDashboardCache retired
 *                `hr:salary-bands:<org>` and `hr:dashboard:payroll-summary:<org>`,
 *                and HrSalaryStructuresService.upsert deleted the first of those
 *                again. No `cached()` anywhere in `src/` ever wrote either key —
 *                the routes they were named for (`/hr/dashboard/salary-bands`,
 *                `/hr/dashboard/payroll-summary`) no longer exist.
 *   dead bumps   HrPoliciesService bumped `hr:policies:list:<org>` from six
 *                mutation paths while `list()` does not cache at all. NOT in the
 *                triage that produced this file; found only because the scan
 *                below covers every HR service rather than the reported ones.
 *   stale read   CelebrationsService.getAnniversaryFeed cached under
 *                `hr:anniversary-feed:…` via plain `cached()`, so the
 *                `hr:celebrations` namespace bump that onboarding and
 *                termination both fire could not reach it — even though
 *                cache-invalidation-matrix.ts documents that namespace as
 *                "Birthday and WORK-ANNIVERSARY feed".
 *
 * The scan therefore covers `src/modules/hr/**` for bumps and all of `src/**`
 * for reads (a reader may legitimately live in another module — `careers`
 * bumps `hr:candidates:list` and HR reads it). Restricting the corpus to the
 * files this change touched would have missed the policies instance.
 */

const SRC = path.resolve(__dirname, "..", "..", "..");
const HR = path.join(SRC, "modules", "hr");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".e2e-spec.ts")
    )
      out.push(full);
  }
  return out;
}

/** The text of the balanced argument list whose opening paren is at `open`. */
function argumentText(src: string, open: number): string {
  let depth = 0;
  let index = open;
  for (; index < src.length; index++) {
    const char = src[index];
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(open + 1, index);
}

function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inTemplate = false;
  let current = "";
  for (const char of text) {
    if (char === "`") inTemplate = !inTemplate;
    if (!inTemplate) {
      if ("([{".includes(char)) depth++;
      else if (")]}".includes(char)) depth--;
      else if (char === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
        continue;
      }
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Module-level key builders, so `POLICY_CACHE(orgId, id)` and
 * `CACHE_KEYS.hrEmployeesListNamespace(orgId)` resolve to their key shape
 * instead of being skipped as unreadable.
 */
function buildSymbolTable(files: readonly string[]): Map<string, string> {
  const symbols = new Map<string, string>();
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const match of src.matchAll(
      /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*\([^)]*\)\s*=>\s*(?:namespace\()?`([^`]*)`/gm,
    ))
      symbols.set(`CACHE_KEYS.${match[1]}`, match[2] ?? "");
    for (const match of src.matchAll(
      /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:\([^)]*\)\s*=>\s*)?`([^`]*)`/gm,
    ))
      symbols.set(match[1] ?? "", match[2] ?? "");
    for (const match of src.matchAll(
      /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"/gm,
    ))
      symbols.set(match[1] ?? "", match[2] ?? "");
    for (const match of src.matchAll(
      /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*namespace\(\s*[`"]([^`"]*)[`"]/gm,
    ))
      symbols.set(match[1] ?? "", match[2] ?? "");
  }
  return symbols;
}

const ALL_SOURCES = sourceFiles(SRC);
const SYMBOLS = buildSymbolTable(ALL_SOURCES);

/** `hr:x:${orgId}` -> `hr:x:*`; an unresolvable expression -> null. */
function keyShape(expression: string, enclosingSource: string | null): string | null {
  const expr = expression.trim();
  if (enclosingSource !== null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(expr)) {
    const local = new RegExp(`(?:const|let)\\s+${expr}\\s*=\\s*([^;\\n]+)`).exec(
      enclosingSource,
    );
    if (local?.[1]) return keyShape(local[1], null);
  }
  const template = /^`([^`]*)`$/.exec(expr);
  if (template?.[1] !== undefined) return template[1].replace(/\$\{[^}]*\}/g, "*");
  const literal = /^"([^"]*)"$/.exec(expr);
  if (literal?.[1] !== undefined) return literal[1];
  const called = /^([A-Za-z_.]+)\(/.exec(expr);
  const symbol = called?.[1] ?? expr;
  const resolved = SYMBOLS.get(symbol);
  return resolved === undefined ? null : resolved.replace(/\$\{[^}]*\}/g, "*");
}

/** Cache method -> which argument carries the key or namespace. */
const READ_METHODS: Record<string, number> = {
  cached: 0,
  cachedVersioned: 0,
  cachedForOrg: 1,
  cachedForOrgWith: 1,
  cachedVersionedForOrg: 1,
  set: 0,
};
const BUMP_METHODS: Record<string, number> = {
  invalidate: 0,
  del: 0,
  invalidateNamespace: 0,
  invalidateForOrg: 1,
  invalidateNamespaceForOrg: 1,
};

interface Site {
  readonly file: string;
  readonly line: number;
  readonly method: string;
  readonly expression: string;
  readonly shape: string | null;
}

function collect(files: readonly string[], methods: Record<string, number>): Site[] {
  const sites: Site[] = [];
  const pattern = new RegExp(`cache\\.(${Object.keys(methods).join("|")})\\s*\\(`, "g");
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(src)) !== null) {
      const method = match[1] ?? "";
      const parts = splitArguments(argumentText(src, match.index + match[0].length - 1));
      const expression = parts[methods[method] ?? 0] ?? "";
      sites.push({
        file: path.relative(SRC, file),
        line: src.slice(0, match.index).split("\n").length,
        method,
        expression,
        shape: expression === "" ? null : keyShape(expression, src),
      });
    }
    pattern.lastIndex = 0;
  }
  return sites;
}

const HR_FILES = sourceFiles(HR);
const READS = collect(ALL_SOURCES, READ_METHODS);
const HR_BUMPS = collect(HR_FILES, BUMP_METHODS);

describe("hr — every cache bump reaches a key something actually reads", () => {
  it("scans the whole HR module, not the files a single fix touched", () => {
    expect(HR_FILES.length).toBeGreaterThan(300);
    expect(HR_BUMPS.length).toBeGreaterThan(30);
    expect(READS.length).toBeGreaterThan(150);
  });

  it("resolves every HR bump target to a concrete key shape", () => {
    const unresolved = HR_BUMPS.filter((site) => site.shape === null).map(
      (site) => `${site.file}:${site.line} ${site.method}(${site.expression})`,
    );
    expect(unresolved).toEqual([]);
  });

  it("has no HR cache bump whose key or namespace nothing in src/ ever writes", () => {
    const readShapes = READS.flatMap((site) => (site.shape === null ? [] : [site.shape]));
    const orphans = HR_BUMPS.flatMap((site) => {
      if (site.shape === null) return [];
      const prefix = site.shape.split("*")[0] ?? site.shape;
      const reached = readShapes.some(
        (read) => read.startsWith(prefix) || prefix.startsWith(read),
      );
      return reached ? [] : [`${site.file}:${site.line} ${site.method} -> ${site.shape}`];
    });
    expect(orphans).toEqual([]);
  });
});

function recordingCache() {
  const cached = jest.fn().mockResolvedValue([]);
  const cachedVersionedForOrg = jest.fn().mockResolvedValue([]);
  const cache = { cached, cachedVersionedForOrg } as unknown as CacheService;
  return { cache, cached, cachedVersionedForOrg };
}

describe("hr — the anniversary feed sits in the namespace its invalidators bump", () => {
  const ORG = "org-1";
  const ACTOR = "user-1";

  it("reads through the versioned hr:celebrations namespace, not a standalone key", async () => {
    const { cache, cached, cachedVersionedForOrg } = recordingCache();
    const service = new CelebrationsService({} as unknown as Db, cache);

    await service.getAnniversaryFeed(ScopedRead.of(ORG, ACTOR, "all"));

    expect(cached).not.toHaveBeenCalled();
    expect(cachedVersionedForOrg).toHaveBeenCalledTimes(1);
    expect(cachedVersionedForOrg.mock.calls[0]?.[0]).toBe(ORG);
    expect(cachedVersionedForOrg.mock.calls[0]?.[1]).toBe("hr:celebrations");
  });

  it("does not collide with the celebrations feed inside that namespace", async () => {
    const { cache, cachedVersionedForOrg } = recordingCache();
    const service = new CelebrationsService({} as unknown as Db, cache);

    await service.getAnniversaryFeed(ScopedRead.of(ORG, ACTOR, "all"));
    await service.getCelebrations(ScopedRead.of(ORG, ACTOR, "all"));

    const subKeys = cachedVersionedForOrg.mock.calls.map((call) => call[2]);
    expect(subKeys).toHaveLength(2);
    expect(new Set(subKeys).size).toBe(2);
  });

  it("is bumped by both HR lifecycle invalidators", () => {
    const invalidators = [
      "modules/hr/directory/employee-onboarding.service.ts",
      "modules/hr/lifecycle/termination-lifecycle.service.ts",
    ];
    for (const file of invalidators) {
      const bumps = collect([path.join(SRC, file)], BUMP_METHODS);
      expect(bumps.map((site) => site.shape)).toContain("hr:celebrations");
    }
  });
});
