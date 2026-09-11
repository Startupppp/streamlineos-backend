import { OrgHierarchyCacheService } from "./org-hierarchy-cache.service";
import type { CacheService } from "./cache.service";

function buildCache() {
  const entries = new Map<string, unknown>();
  const versions = new Map<string, number>();
  const composed: string[] = [];

  const scopedNamespace = (orgId: string, namespace: string) => `${orgId}:${namespace}`;

  const fake = {
    async cachedVersionedForOrg<T>(
      orgId: string,
      namespace: string,
      localKey: string,
      fetcher: () => Promise<T>,
    ): Promise<T> {
      const ns = scopedNamespace(orgId, namespace);
      const version = versions.get(ns) ?? 1;
      const key = `${ns}:v${version}:${localKey}`;
      composed.push(key);
      if (entries.has(key)) return entries.get(key) as T;
      const value = await fetcher();
      entries.set(key, value);
      return value;
    },
    async invalidateNamespaceForOrg(orgId: string, namespace: string): Promise<void> {
      const ns = scopedNamespace(orgId, namespace);
      versions.set(ns, (versions.get(ns) ?? 1) + 1);
    },
  };

  const service = new OrgHierarchyCacheService(fake as unknown as CacheService);
  return { service, composed };
}

describe("OrgHierarchyCacheService org unit reads", () => {
  const query = { status: "ACTIVE", limit: 25 };

  it("serves an identical list read from cache instead of the database", async () => {
    const { service } = buildCache();
    const fetcher = jest.fn().mockResolvedValue([{ id: "unit-1" }]);

    await service.readUnitList("org-a", "BRANCH", query, fetcher);
    await service.readUnitList("org-a", "BRANCH", query, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("misses after a mutation bumps the hierarchy namespace version", async () => {
    const { service } = buildCache();
    const fetcher = jest.fn().mockResolvedValue([{ id: "unit-1" }]);

    await service.readUnitList("org-a", "BRANCH", query, fetcher);
    await service.invalidateAfterMutation("org-a");
    await service.readUnitList("org-a", "BRANCH", query, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never serves one organization's units to another", async () => {
    const { service, composed } = buildCache();
    const own = jest.fn().mockResolvedValue([{ id: "org-a-unit" }]);
    const foreign = jest.fn().mockResolvedValue([{ id: "org-b-unit" }]);

    await expect(service.readUnitList("org-a", "BRANCH", query, own)).resolves.toEqual([
      { id: "org-a-unit" },
    ]);
    await expect(service.readUnitList("org-b", "BRANCH", query, foreign)).resolves.toEqual([
      { id: "org-b-unit" },
    ]);

    expect(foreign).toHaveBeenCalledTimes(1);
    expect(composed[0]).not.toEqual(composed[1]);
    expect(composed[0]?.startsWith("org-a:")).toBe(true);
    expect(composed[1]?.startsWith("org-b:")).toBe(true);
  });

  it("keys every filter that changes the result set", async () => {
    const { service, composed } = buildCache();
    const fetcher = jest.fn().mockResolvedValue([]);

    await service.readUnitList("org-a", "BRANCH", { status: "ACTIVE", limit: 25 }, fetcher);
    await service.readUnitList("org-a", "BRANCH", { status: "ARCHIVED", limit: 25 }, fetcher);
    await service.readUnitList("org-a", "BRANCH", { status: "ACTIVE", limit: 50 }, fetcher);
    await service.readUnitList("org-a", "BRANCH", { status: "ACTIVE", search: "ops", limit: 25 }, fetcher);
    await service.readUnitList("org-a", "BRANCH", { status: "ACTIVE", cursor: "c1", limit: 25 }, fetcher);

    expect(new Set(composed).size).toBe(5);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("does not let a separator inside a search term collide with another filter set", async () => {
    const { service, composed } = buildCache();
    const fetcher = jest.fn().mockResolvedValue([]);

    await service.readUnitList("org-a", "BRANCH", { search: "a:b", limit: 1 }, fetcher);
    await service.readUnitList("org-a", "BRANCH", { search: "a", cursor: "b", limit: 1 }, fetcher);

    expect(new Set(composed).size).toBe(2);
  });

  it("separates the two unit kinds and the single-row read", async () => {
    const { service, composed } = buildCache();
    const fetcher = jest.fn().mockResolvedValue([]);

    await service.readUnitList("org-a", "BRANCH", query, fetcher);
    await service.readUnitList("org-a", "TEAM", query, fetcher);
    await service.readUnitGet("org-a", "BRANCH", "unit-1", fetcher);
    await service.readUnitGet("org-a", "BRANCH", "unit-2", fetcher);

    expect(new Set(composed).size).toBe(4);
  });
});
