/**
 * Headcount read-after-write, end to end through the real services.
 *
 * The previous version asserted `cachedVersioned` had been called with a
 * particular namespace. That is satisfied by a read whose generation counter no
 * writer ever touches, which is exactly what shipped: the read keyed
 * `cache:namespace:hr:headcount:<org>:version` and `invalidateAfterMutation`
 * bumped `cache:namespace:<org>:hr:headcount:version`. These tests run the real
 * `CacheService` over a stateful Redis double and assert the number a caller
 * gets back, so a namespace only one side agrees on fails them.
 */

import type { Redis } from "@upstash/redis";
import { CacheService } from "../../../common/cache/cache.service";
import { InMemoryRedis } from "../../../common/cache/in-memory-redis.test-double";
import { OrgHierarchyCacheService } from "../../../common/cache/org-hierarchy-cache.service";
import type { Db } from "../../../db/drizzle.module";
import { OrgStructureService } from "./org-structure.service";

interface HeadcountRow {
  label: string;
  count: number;
}

function headcountDb(rows: () => HeadcountRow[]): { db: Db; queries: () => number } {
  let queries = 0;
  const limit = jest.fn(() => {
    queries++;
    return Promise.resolve(rows());
  });
  const joinChain: Record<string, jest.Mock> = {
    leftJoin: jest.fn(),
    where: jest.fn().mockReturnValue({ groupBy: jest.fn().mockReturnValue({ limit }) }),
  };
  joinChain["leftJoin"].mockReturnValue(joinChain);
  const select = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue(joinChain),
    }),
  });
  return { db: { select } as unknown as Db, queries: () => queries };
}

function build(rows: () => HeadcountRow[], deafToInvalidation = false) {
  const cache = new CacheService(
    new InMemoryRedis(deafToInvalidation) as unknown as Redis,
  );
  const { db, queries } = headcountDb(rows);
  return {
    cache,
    queries,
    hierarchy: new OrgHierarchyCacheService(cache),
    service: new OrgStructureService(
      db,
      cache,
      undefined as never,
      undefined as never,
    ),
  };
}

describe("OrgStructureService headcount aggregation", () => {
  it("groups department headcount in one query", async () => {
    const { service, queries } = build(() => [
      { label: "Engineering", count: 12 },
      { label: "Unassigned", count: 2 },
    ]);

    await expect(
      service.getHeadcount("org-1", { groupBy: "department" }),
    ).resolves.toEqual([
      { label: "Engineering", count: 12 },
      { label: "Unassigned", count: 2 },
    ]);
    expect(queries()).toBe(1);
  });

  it("serves the stale count until a hierarchy mutation retires the namespace", async () => {
    let headcount = 12;
    const { service, hierarchy, queries } = build(() => [
      { label: "Engineering", count: headcount },
    ]);

    await expect(
      service.getHeadcount("org-1", { groupBy: "department" }),
    ).resolves.toEqual([{ label: "Engineering", count: 12 }]);

    headcount = 13;
    await expect(
      service.getHeadcount("org-1", { groupBy: "department" }),
    ).resolves.toEqual([{ label: "Engineering", count: 12 }]);
    expect(queries()).toBe(1);

    await hierarchy.invalidateAfterMutation("org-1");

    await expect(
      service.getHeadcount("org-1", { groupBy: "department" }),
    ).resolves.toEqual([{ label: "Engineering", count: 13 }]);
    expect(queries()).toBe(2);
  });

  it("negative control: a bump that never lands keeps serving the old headcount", async () => {
    let headcount = 12;
    const { service, hierarchy } = build(
      () => [{ label: "Engineering", count: headcount }],
      true,
    );

    await service.getHeadcount("org-1", { groupBy: "department" });
    headcount = 13;
    await hierarchy.invalidateAfterMutation("org-1");

    await expect(
      service.getHeadcount("org-1", { groupBy: "department" }),
    ).resolves.toEqual([{ label: "Engineering", count: 12 }]);
  });

  it("keys each grouping separately, so a department read never answers a role read", async () => {
    const { service } = build(() => [{ label: "Engineering", count: 12 }]);

    await service.getHeadcount("org-1", { groupBy: "department" });

    await expect(
      service.getHeadcount("org-1", { groupBy: "role" }),
    ).resolves.not.toEqual([{ label: "Engineering", count: 12 }]);
  });

  it("one tenant's mutation leaves another tenant's headcount cached", async () => {
    let headcount = 12;
    const { service, hierarchy } = build(() => [
      { label: "Engineering", count: headcount },
    ]);

    await service.getHeadcount("org-2", { groupBy: "department" });
    headcount = 13;
    await hierarchy.invalidateAfterMutation("org-1");

    await expect(
      service.getHeadcount("org-2", { groupBy: "department" }),
    ).resolves.toEqual([{ label: "Engineering", count: 12 }]);
  });
});
