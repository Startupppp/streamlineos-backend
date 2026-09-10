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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MODULE_ROOT = join(__dirname, "..");

function serviceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".service.ts") && !path.includes("__tests__")) found.push(path);
    }
  };
  walk(MODULE_ROOT);
  return found.sort();
}

const RESOLVES_SCOPE = /warehouseScope\.(forUser|resolve)\(/;
const CACHES = /this\.cache\.(cached|cachedVersioned)\(/;
/** `scope.key`, a local `scopeKey`, or the resolved-scope object under another name. */
const SCOPE_IN_KEY = /\bscopeKey\b|\.key\b/;

describe("inventory scoped lists", () => {
  const files = serviceFiles();

  it("finds the service surface", () => {
    expect(files.length).toBeGreaterThanOrEqual(40);
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

  /**
   * The allowlist is names, not shapes, and that is a deliberate trade.
   *
   * A guard that accepted "the scope value is passed to something" would accept
   * passing it to a logger. Naming the predicate builders means a genuinely new
   * one has to be added here — which is the moment somebody reads what it does.
   * `anomalyVisibilityPredicate` (F3) was added after that reading: it returns
   * `FALSE` for an empty scope rather than `TRUE`, so a user scoped to no
   * warehouse sees nothing rather than everything.
   *
   * `returnInScope` was added when vendor-returns.service.ts was split for
   * check:file-sizes and the builder moved to `lib/vendor-return-scope.ts`. Read
   * before adding, as this comment requires: it is
   * `scope.anyOf(grn_id IN (SELECT id FROM inv_grns WHERE org_id = ... AND
   * scope.location(location_id)))` — the scope really is applied, through the
   * GRN's location rather than its warehouse, because a receipt names the bin it
   * landed in.
   *
   * ⚠ Note what this costs. The guard pairs "resolves a scope" with "applies a
   * scope" WITHIN ONE FILE, and only walks `*.service.ts`. Once a builder lives
   * in a sibling `lib/`, this test sees the call site's NAME and not the body, so
   * it can no longer catch that builder being gutted. `scopeFragment` and
   * `stockScope` above are already in that position. If more of these move, this
   * test should walk `lib/*.ts` beside each service rather than growing the list.
   */
  it("never resolves a scope it then fails to apply to a query", () => {
    const unused: string[] = [];
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      if (!RESOLVES_SCOPE.test(source)) continue;
      const applies =
        /\.(warehouse|location|anyOf)\(/.test(source) ||
        /warehousePredicate|locationPredicate|warehouseIdList|assertLocationsInScope|assertWarehouseVisible|assertLocationVisible|scopeFragment|stockScope|anomalyVisibilityPredicate|returnInScope/.test(
          source,
        );
      if (!applies) unused.push(path.replace(MODULE_ROOT + "/", ""));
    }
    expect(unused).toEqual([]);
  });
});
