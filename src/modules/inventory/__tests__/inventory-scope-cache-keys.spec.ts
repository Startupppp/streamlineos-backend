/**
 * INV-109 — a warehouse-scoped list may not be cached under a scope-free key.
 *
 * Caching a scoped query under a key that omits the caller's warehouses serves
 * the first caller's rows to the next one and defeats the scope in both
 * directions: an operator sees warehouses they are not assigned to, and a
 * scope-all holder sees a truncated list. It is invisible in review because the
 * query itself is correct — only the key is wrong.
 *
 * Static rather than behavioural on purpose: the failure is a missing
 * discriminator, and every service that acquires a scope and caches has to be
 * checked, including ones added later.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const MODULE_ROOT = join(__dirname, "..");

function walkTs(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walkTs(path, found);
    else if (path.endsWith(".ts") && !path.endsWith(".spec.ts") && !path.includes("__tests__")) {
      found.push(path);
    }
  }
  return found;
}

const isLib = (path: string): boolean => /(^|\/)lib\//.test(path);

/**
 * `*.service.ts` AND everything under a `lib/` directory.
 *
 * Widened 2026-09-11. The `.service.ts`-only walk went quiet on exactly the
 * code this check exists for as soon as a large service was decomposed: the
 * scoped read moves into `lib/`, the class keeps a delegate that resolves
 * nothing, and neither half matches on its own.
 */
function scannedFiles(): string[] {
  return walkTs(MODULE_ROOT)
    .filter((path) => path.endsWith(".service.ts") || isLib(path))
    .sort();
}

/**
 * A file together with every `.ts` in a `lib/` directory beside it.
 *
 * This is what lets the "applies what it resolves" rule read a BODY again
 * rather than trust a name. A predicate builder that moved to a sibling `lib/`
 * is inside the unit, so gutting it fails the check — which is precisely what
 * the old comment here said the name-matching version could no longer catch.
 */
function unitSource(path: string): string {
  const libDir = join(dirname(path), "lib");
  const libs = existsSync(libDir) && statSync(libDir).isDirectory() ? walkTs(libDir) : [];
  return [path, ...libs].map((file) => readFileSync(file, "utf8")).join("\n");
}

const RESOLVES_SCOPE = /warehouseScope\.(forUser|resolve)\(/;
// `deps.cache` as well as `this.cache`: a decomposed service caches through its bag.
const CACHES = /(?:this|deps)\.cache\.(cached|cachedVersioned)\(/;
/** `scope.key`, a local `scopeKey`, or the resolved-scope object under another name. */
const SCOPE_IN_KEY = /\bscopeKey\b|\.key\b/;

/**
 * Methods of `WarehouseScopeService`. Matching these by NAME is sound because
 * they are one shared, tested implementation, and the last test below asserts
 * each is still a member of that service — so a rename cannot leave a dead
 * entry behind that quietly excuses a caller.
 */
const SCOPE_SERVICE_METHODS = [
  "warehousePredicate",
  "locationPredicate",
  "warehouseIdList",
  "assertWarehouseVisible",
  "assertLocationVisible",
  "assertLocationsInScope",
] as const;

/**
 * Predicate builders that are NOT on the scope service. Each is pinned to the
 * file that defines it, and the last test reads that definition to confirm it
 * really applies the scope.
 *
 * `anomalyVisibilityPredicate` (F3) returns `FALSE` for an empty scope rather
 * than `TRUE`, so a user scoped to no warehouse sees nothing rather than
 * everything — read before it was added, and re-read here on every run.
 *
 * `scopeFragment`, `returnInScope` and `stockScope` used to be here and are
 * gone. The first two now live in a `lib/` beside their service, so the unit
 * walk above reads their bodies and a name is no longer needed. `stockScope`
 * was never a builder at all — it is a local VARIABLE name, which meant any
 * file could have satisfied this check by declaring `const stockScope = 1`.
 */
const LOCAL_BUILDERS = [
  {
    name: "anomalyVisibilityPredicate",
    file: "ai/anomalies/inv-anomaly-visibility.ts",
    // It takes a raw `WarehouseScope`, not a `ResolvedWarehouseScope`, so it
    // builds the predicate itself rather than calling `.warehouse(`. What has
    // to be true of it is therefore spelled out: it constrains the warehouse
    // column, and an empty scope yields FALSE rather than an omitted predicate.
    mustContain: ["scope.length === 0) return sql`FALSE`", "warehouseId} IN ("],
  },
] as const;

const APPLIES_BY_NAME = new RegExp(
  `\\b(${[...SCOPE_SERVICE_METHODS, ...LOCAL_BUILDERS.map((b) => b.name)].join("|")})\\b`,
);
const APPLIES_BY_BODY = /\.(warehouse|location|anyOf)\(/;

describe("inventory scoped lists", () => {
  const files = scannedFiles();

  it("finds the surface, so a broken walk cannot pass as zero violations", () => {
    expect(files.length).toBeGreaterThanOrEqual(150);
    // The regression this floor exists for: the walk used to stop at
    // `*.service.ts` and miss every decomposed service's `lib/`.
    expect(files.filter(isLib).length).toBeGreaterThanOrEqual(20);
    expect(files.filter((f) => RESOLVES_SCOPE.test(readFileSync(f, "utf8"))).length)
      .toBeGreaterThanOrEqual(25);
  });

  it("puts the resolved scope in the cache key of every service that caches a scoped read", () => {
    const offenders: string[] = [];
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      if (!RESOLVES_SCOPE.test(source) || !CACHES.test(source)) continue;
      if (!SCOPE_IN_KEY.test(source)) offenders.push(path.replace(MODULE_ROOT + "/", ""));
    }
    expect(offenders).toEqual([]);
  });

  it("never resolves a scope it then fails to apply to a query", () => {
    const unused: string[] = [];
    for (const path of files) {
      if (!RESOLVES_SCOPE.test(readFileSync(path, "utf8"))) continue;
      const unit = unitSource(path);
      if (!APPLIES_BY_BODY.test(unit) && !APPLIES_BY_NAME.test(unit)) {
        unused.push(path.replace(MODULE_ROOT + "/", ""));
      }
    }
    expect(unused).toEqual([]);
  });

  it("keeps every allowlisted name pointed at something that really applies a scope", () => {
    // Without this, the allowlist is the hole: a name that no longer resolves to
    // anything excuses every caller that mentions it, and nothing fails.
    const scopeService = readFileSync(
      join(MODULE_ROOT, "stock-engine", "warehouse-scope.service.ts"),
      "utf8",
    );
    for (const method of SCOPE_SERVICE_METHODS) {
      expect({ method, isMemberOfScopeService: new RegExp(`\\n  (?:async )?${method}\\(`).test(scopeService) })
        .toEqual({ method, isMemberOfScopeService: true });
    }

    for (const { name, file, mustContain } of LOCAL_BUILDERS) {
      const source = readFileSync(join(MODULE_ROOT, file), "utf8");
      const at = source.search(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
      expect({ name, definedIn: file, found: at !== -1 }).toEqual({
        name,
        definedIn: file,
        found: true,
      });
      const body = source.slice(at);
      for (const fragment of mustContain) {
        expect({ name, fragment, present: body.includes(fragment) }).toEqual({
          name,
          fragment,
          present: true,
        });
      }
    }
  });
});
