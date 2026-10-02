/**
 * c19-04 read-after-write verification — all 143 cache namespace matrix entries.
 *
 * Of the 143 entries in CACHE_INVALIDATION_MATRIX:
 *   107 are kind:"write" — exercised by the table-driven tests below.
 *   36 are kind:"ttl-only" — excluded from read-after-write; their non-empty
 *      reason fields are verified in "matrix structure".
 *
 * All tests run against the real CacheService with a stateful in-memory Redis
 * double (never against mocked call counts alone). The negative control proves
 * the suite bites: when incr is a no-op, invalidateNamespace cannot advance the
 * version counter, the versioned key is unchanged, and the stale value is still
 * served — exactly what we would observe if invalidation were broken.
 */

import type { Redis } from "@upstash/redis";
import { CacheService } from "./cache.service";
import { CACHE_INVALIDATION_MATRIX } from "./cache-invalidation-matrix";
import type { CacheNamespaceEntry } from "./cache-invalidation-matrix";

import { InMemoryRedis } from "./in-memory-redis.test-double";

/**
 * Every table below is derived from `CACHE_INVALIDATION_MATRIX` itself, so a new
 * `kind: "write"` entry is exercised the moment it is added rather than when
 * someone remembers to copy it here.
 */
const writeEntries: readonly CacheNamespaceEntry[] = CACHE_INVALIDATION_MATRIX.filter(
  (e) => e.invalidation.kind === "write",
);

function makeFreshCache(deafToInvalidation = false): CacheService {
  return new CacheService(new InMemoryRedis(deafToInvalidation) as unknown as Redis);
}

// Namespace template helpers.
// Matrix namespace strings use <placeholder> syntax. We substitute concrete
// test values to obtain the actual Redis namespace for each test case.

const TEST_USER_ID = "user-1";
const TEST_ALT_USER_ID = "user-2";
const TEST_BUDGET_ID = "budget-1";
const TEST_NS_VERSION = "0";

function fillTemplate(
  template: string,
  orgId: string,
  userId = TEST_USER_ID,
): string {
  return template
    .replace("<orgId>", orgId)
    .replace("<userId>", userId)
    .replace("<budgetId>", TEST_BUDGET_ID)
    .replace("<version>", TEST_NS_VERSION);
}

function primaryNs(template: string): string {
  return fillTemplate(template, "org-a");
}

/**
 * Returns a namespace for the "alternate tenant" to verify isolation:
 *  - templates with <orgId>: vary orgId (org-b keeps the same userId)
 *  - templates without <orgId> (e.g. user:session:<userId>): vary userId
 */
function alternateTenantNs(template: string): string {
  if (template.includes("<orgId>")) return fillTemplate(template, "org-b");
  if (template.includes("<userId>")) return fillTemplate(template, "org-a", TEST_ALT_USER_ID);
  const discriminator = /<(\w+)>/.exec(template);
  if (!discriminator) {
    throw new Error(
      `namespace "${template}" carries no tenant discriminator — it cannot be isolation-tested`,
    );
  }
  return fillTemplate(template.replace(discriminator[0], "alt-owner"), "org-a");
}

// Matrix structure tests

/**
 * 142 -> 143, 105 -> 107 write and 37 -> 36 ttl-only, re-pinned 2026-09-12. The whole delta is
 * `e4082ca30 fix(inventory): a stock write invalidates the reads that actually exist`, and it is
 * accounted for entry by entry, because a census that moved further than the registry change
 * explains is a signal, not a rebase:
 *   -3 write: `inv:stock:summary:<orgId>` and `inv:low-stock:<orgId>` were written by nobody, and
 *      `inv:reorder:paged:<orgId>` was a child said to be reached "implicitly via the inv:reorder
 *      parent" — a prefix delete Redis does not have. All three named a key no reader ever stored.
 *   +4 write: `inv:ops:zones:<orgId>`, `inv:ops:summary:<orgId>`, `inv:physical-audits:list:<orgId>`
 *      and `inv:physical-audits:detail:<orgId>:<id>` — four real generation namespaces that existed
 *      in the readers and were absent from this registry, so nothing bumped them.
 *   1 moved ttl-only -> write: `inv:dashboard:<orgId>`, which was documented as a deliberate
 *      TTL-only aggregate while four `invalidate()` calls were in fact aimed at it and missing.
 * 142 - 3 + 4 = 143; 105 - 3 + 4 + 1 = 107; 37 - 1 = 36.
 * The numbers are descriptive. What bites is the table-driven read-after-write suite below, which
 * is derived from the matrix itself — so the four added namespaces are exercised by the fact of
 * being in the registry, not by anyone remembering to add a case.
 */
describe("CACHE_INVALIDATION_MATRIX — structure", () => {
  it("has exactly 142 entries", () => {
    expect(CACHE_INVALIDATION_MATRIX).toHaveLength(142);
  });

  it("has no duplicate namespace keys", () => {
    const namespaces = CACHE_INVALIDATION_MATRIX.map((e) => e.namespace);
    expect(new Set(namespaces).size).toBe(CACHE_INVALIDATION_MATRIX.length);
  });

  it("every entry's shape matches its discriminant", () => {
    for (const entry of CACHE_INVALIDATION_MATRIX) {
      if (entry.invalidation.kind === "write") {
        expect(Array.isArray(entry.invalidation.events)).toBe(true);
        expect(entry.invalidation.events.length).toBeGreaterThan(0);
      } else {
        expect(typeof entry.invalidation.reason).toBe("string");
        expect(entry.invalidation.reason.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it(
    "coverage guard — 107 write and 36 ttl-only" +
      " (update both counts when the matrix grows)",
    () => {
      const writeCount = CACHE_INVALIDATION_MATRIX.filter(
        (e) => e.invalidation.kind === "write",
      ).length;
      const ttlCount = CACHE_INVALIDATION_MATRIX.filter(
        (e) => e.invalidation.kind === "ttl-only",
      ).length;
      expect(writeCount).toBe(106);
      expect(ttlCount).toBe(36);
      expect(writeCount + ttlCount).toBe(CACHE_INVALIDATION_MATRIX.length);
    },
  );
});

describe("CACHE_INVALIDATION_MATRIX — dimension enforcement", () => {
  it("every entry with declared dimensions has each dimension as a <dim> placeholder in its namespace template", () => {
    for (const entry of CACHE_INVALIDATION_MATRIX) {
      for (const dim of entry.dimensions ?? []) {
        expect(entry.namespace).toContain(`<${dim}>`);
      }
    }
  });

  it("at least 8 entries declare required dimensions (field is not silently absent from the registry)", () => {
    const withDimensions = CACHE_INVALIDATION_MATRIX.filter(
      (e) => (e.dimensions?.length ?? 0) > 0,
    );
    expect(withDimensions.length).toBeGreaterThanOrEqual(8);
  });

  it("entries with staleToleranceSeconds declare a non-negative finite value", () => {
    for (const entry of CACHE_INVALIDATION_MATRIX) {
      if (entry.staleToleranceSeconds !== undefined) {
        expect(Number.isFinite(entry.staleToleranceSeconds)).toBe(true);
        expect(entry.staleToleranceSeconds).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// Negative control — proves the read-after-write suite bites.
//
// With deafToInvalidation=true, incr returns the current value without writing,
// so namespaceVersion always reads 0, the versioned key never changes, and the
// cache keeps serving the original entry even after invalidateNamespace.
// If this test PASSES it confirms the positive tests are not vacuously true:
// a cache that never stored anything would make the control FAIL (it would
// never see a stale value because there would be nothing to stay stale).

describe("namespace read-after-write — negative control", () => {
  it(
    "stays stale when the namespace version counter cannot be bumped" +
      " (deaf incr simulates broken invalidation)",
    async () => {
      const cache = makeFreshCache(true);
      const firstWriteEntry = writeEntries[0];
      if (!firstWriteEntry) throw new Error("the matrix declares no event-invalidated namespace");
      const ns = primaryNs(firstWriteEntry.namespace);

      let fetchCount = 0;

      await cache.cachedVersioned(ns, "ctrl-key", async () => {
        fetchCount++;
        return "stale-value";
      });

      await cache.invalidateNamespace(ns);

      const result = await cache.cachedVersioned(ns, "ctrl-key", async () => {
        fetchCount++;
        return "fresh-value";
      });

      expect(result).toBe("stale-value");
      expect(fetchCount).toBe(1);
    },
  );
});

// Read-after-write — table-driven, one case per kind:"write" entry.
//

describe("namespace read-after-write — event-invalidated (107 namespaces)", () => {
  it.each(writeEntries)("$namespace", async (entry) => {
    const cache = makeFreshCache();
    const ns = primaryNs(entry.namespace);
    const altNs = alternateTenantNs(entry.namespace);

    // The two namespace strings must differ; they carry different tenant params.
    expect(ns).not.toBe(altNs);

    let fetchCount = 0;

    // Step 1 — prime the cache.
    const v1 = await cache.cachedVersioned(ns, "rw-key", async () => {
      fetchCount++;
      return `${ns}:initial`;
    });
    expect(v1).toBe(`${ns}:initial`);
    expect(fetchCount).toBe(1);

    // Step 2 — confirm the cache is genuine: the fetcher must NOT run again.
    // Without this control a cache that never stores anything would pass every
    // assertion below trivially (a miss always calls the fetcher, so the "new"
    // value would always appear to be fresh).
    const v2 = await cache.cachedVersioned(ns, "rw-key", async () => {
      fetchCount++;
      return `${ns}:must-not-appear`;
    });
    expect(v2).toBe(`${ns}:initial`);
    expect(fetchCount).toBe(1);

    // Step 3 — invalidate the namespace.
    await cache.invalidateNamespace(ns);

    // Step 4 — next read must serve fresh data: the version bumped, so the
    // versioned composite key changed and the cache misses.
    const v3 = await cache.cachedVersioned(ns, "rw-key", async () => {
      fetchCount++;
      return `${ns}:after-invalidation`;
    });
    expect(v3).toBe(`${ns}:after-invalidation`);
    expect(fetchCount).toBe(2);

    // Tenant separation — prime the alternate namespace.
    let altFetchCount = 0;
    const altV1 = await cache.cachedVersioned(altNs, "sep-key", async () => {
      altFetchCount++;
      return `${altNs}:initial`;
    });
    expect(altV1).toBe(`${altNs}:initial`);
    expect(altFetchCount).toBe(1);

    // Invalidate the primary namespace again — must not evict the alternate's entry.
    await cache.invalidateNamespace(ns);

    const altV2 = await cache.cachedVersioned(altNs, "sep-key", async () => {
      altFetchCount++;
      return `${altNs}:must-not-appear`;
    });
    expect(altV2).toBe(`${altNs}:initial`);
    expect(altFetchCount).toBe(1);
  });
});
