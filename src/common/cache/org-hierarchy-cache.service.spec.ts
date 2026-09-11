/**
 * Read-after-write proof for the hierarchy invalidation hook.
 *
 * The previous version asserted `invalidateNamespaceForOrg` had been *called*.
 * That assertion passed for a year while `hr:headcount` was read from
 * `cache:namespace:hr:headcount:<org>:version` and bumped on
 * `cache:namespace:<org>:hr:headcount:version` — two counters, permanently stale
 * headcount. A call-list assertion cannot see a wrong key; only reading the value
 * back can. Every test below therefore runs the real `CacheService` over a
 * stateful Redis double and asserts what a second read returns.
 */

import { ScopedRead } from "../../modules/access/scoped-read";
import type { Redis } from "@upstash/redis";
import { CacheService } from "./cache.service";
import { InMemoryRedis } from "./in-memory-redis.test-double";
import { runWithTenantContext } from "../tenant";
import {
  OrgHierarchyCacheService,
  type OrgHierarchyCacheResource,
} from "./org-hierarchy-cache.service";

const TREE: OrgHierarchyCacheResource = "tree:ADJACENCY:r1";
const ORG = "org-1";

function build(deafToInvalidation = false): {
  cache: CacheService;
  service: OrgHierarchyCacheService;
} {
  const cache = new CacheService(
    new InMemoryRedis(deafToInvalidation) as unknown as Redis,
  );
  return { cache, service: new OrgHierarchyCacheService(cache) };
}

/** The exact call the production readers of each sibling namespace make. */
function readNamespace(
  cache: CacheService,
  namespace: string,
  key: string,
  value: () => string,
): Promise<string> {
  return cache.cachedVersionedForOrg(ORG, namespace, key, () =>
    Promise.resolve(value()),
  );
}

const viewer = (actorUserId: string, scope: "all" | "team" | "own" | "none") => ({
  discriminator: ScopedRead.of("org-any", actorUserId, scope).discriminator,
});

describe("OrgHierarchyCacheService", () => {
  it("partitions versioned entries by tenant and permission-derived viewer scope", async () => {
    const { service } = build();

    const [allScope, viewerOne, viewerTwo, otherOrg] = await Promise.all([
      service.read(ORG, TREE, viewer("user-all", "all"), () =>
        Promise.resolve("everything"),
      ),
      service.read(ORG, TREE, viewer("user-1", "team"), () =>
        Promise.resolve("team-of-user-1"),
      ),
      service.read(ORG, TREE, viewer("user-2", "team"), () =>
        Promise.resolve("team-of-user-2"),
      ),
      service.read("org-2", TREE, viewer("user-1", "team"), () =>
        Promise.resolve("other-tenant"),
      ),
    ]);

    expect([allScope, viewerOne, viewerTwo, otherOrg]).toEqual([
      "everything",
      "team-of-user-1",
      "team-of-user-2",
      "other-tenant",
    ]);
  });

  it("a viewer never inherits another viewer's cached tree", async () => {
    const { service } = build();

    await service.read(ORG, TREE, viewer("user-1", "team"), () =>
      Promise.resolve("team-of-user-1"),
    );
    const second = await service.read(
      ORG,
      TREE,
      viewer("user-2", "team"),
      () => Promise.resolve("team-of-user-2"),
    );

    expect(second).toBe("team-of-user-2");
  });

  it("retires the hierarchy, headcount and directory namespaces a mutation makes stale", async () => {
    const { cache, service } = build();
    let generation = 1;
    const current = (): string => `generation-${String(generation)}`;

    await service.read(ORG, TREE, viewer("u", "all"), () =>
      Promise.resolve(current()),
    );
    await readNamespace(cache, "hr:headcount", "group:department", current);
    await readNamespace(cache, "hr:directory", "u:all", current);

    generation = 2;

    await expect(
      service.read(ORG, TREE, viewer("u", "all"), () =>
        Promise.resolve(current()),
      ),
    ).resolves.toBe("generation-1");

    await service.invalidateAfterMutation(ORG);

    await expect(
      service.read(ORG, TREE, viewer("u", "all"), () =>
        Promise.resolve(current()),
      ),
    ).resolves.toBe("generation-2");
    await expect(
      readNamespace(cache, "hr:headcount", "group:department", current),
    ).resolves.toBe("generation-2");
    await expect(
      readNamespace(cache, "hr:directory", "u:all", current),
    ).resolves.toBe("generation-2");
  });

  it("negative control: a bump that never lands leaves all three namespaces stale", async () => {
    const { cache, service } = build(true);
    let generation = 1;
    const current = (): string => `generation-${String(generation)}`;

    await service.read(ORG, TREE, viewer("u", "all"), () =>
      Promise.resolve(current()),
    );
    await readNamespace(cache, "hr:headcount", "group:department", current);
    await readNamespace(cache, "hr:directory", "u:all", current);

    generation = 2;
    await service.invalidateAfterMutation(ORG);

    await expect(
      service.read(ORG, TREE, viewer("u", "all"), () =>
        Promise.resolve(current()),
      ),
    ).resolves.toBe("generation-1");
    await expect(
      readNamespace(cache, "hr:headcount", "group:department", current),
    ).resolves.toBe("generation-1");
    await expect(
      readNamespace(cache, "hr:directory", "u:all", current),
    ).resolves.toBe("generation-1");
  });

  it("regression witness: the pre-fix wiring read a counter the invalidator never bumped", async () => {
    const { cache, service } = build();
    let generation = 1;
    const current = (): string => `generation-${String(generation)}`;

    await cache.cachedVersioned(`hr:headcount:${ORG}`, "group:department", () =>
      Promise.resolve(current()),
    );

    generation = 2;
    await service.invalidateAfterMutation(ORG);

    await expect(
      cache.cachedVersioned(`hr:headcount:${ORG}`, "group:department", () =>
        Promise.resolve(current()),
      ),
    ).resolves.toBe("generation-1");
  });

  it("one tenant's mutation does not retire another tenant's generation", async () => {
    const { cache, service } = build();
    let generation = 1;
    const current = (): string => `generation-${String(generation)}`;

    await cache.cachedVersionedForOrg("org-2", "hr:headcount", "group:department", () =>
      Promise.resolve(current()),
    );

    generation = 2;
    await service.invalidateAfterMutation(ORG);

    await expect(
      cache.cachedVersionedForOrg("org-2", "hr:headcount", "group:department", () =>
        Promise.resolve(current()),
      ),
    ).resolves.toBe("generation-1");
  });

  it("defers invalidation until the tenant transaction commits", async () => {
    const { cache, service } = build();
    const afterCommit: Array<() => Promise<unknown>> = [];
    let generation = 1;
    const current = (): string => `generation-${String(generation)}`;

    await readNamespace(cache, "hr:headcount", "group:department", current);
    generation = 2;

    await runWithTenantContext(
      {
        orgId: ORG,
        audience: "INTERNAL",
        tx: {} as never,
        afterCommit,
      },
      () => service.invalidateAfterMutation(ORG),
    );

    expect(afterCommit).toHaveLength(1);
    await expect(
      readNamespace(cache, "hr:headcount", "group:department", current),
    ).resolves.toBe("generation-1");

    await afterCommit[0]!();

    await expect(
      readNamespace(cache, "hr:headcount", "group:department", current),
    ).resolves.toBe("generation-2");
  });
});
