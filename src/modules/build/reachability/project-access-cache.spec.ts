import { ProjectAccessCache, getOrCreateRequestCache } from "./project-access-cache";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../db/drizzle.types";

const ORG_ID = "org-reach-test";

describe("ProjectAccessCache", () => {
  it("returns the same promise for the same key, so the compute function is called exactly once", async () => {
    const cache = new ProjectAccessCache();
    const compute = jest.fn().mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const [r1, r2] = await Promise.all([
      cache.get(ORG_ID, "u1", 1, compute),
      cache.get(ORG_ID, "u1", 1, compute),
    ]);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  it("returns distinct promises for different projectIds, so per-project access is not blurred", async () => {
    const cache = new ProjectAccessCache();
    const compute1 = jest.fn().mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const compute2 = jest.fn().mockResolvedValue({ hasAccess: false, role: null });
    const [r1, r2] = await Promise.all([
      cache.get(ORG_ID, "u1", 1, compute1),
      cache.get(ORG_ID, "u1", 2, compute2),
    ]);
    expect(r1.hasAccess).toBe(true);
    expect(r2.hasAccess).toBe(false);
    expect(compute1).toHaveBeenCalledTimes(1);
    expect(compute2).toHaveBeenCalledTimes(1);
  });

  it("returns distinct promises for different users, so cross-user bleed cannot occur", async () => {
    const cache = new ProjectAccessCache();
    const computeA = jest.fn().mockResolvedValue({ hasAccess: true, role: "OWNER" });
    const computeB = jest.fn().mockResolvedValue({ hasAccess: false, role: null });
    const [rA, rB] = await Promise.all([
      cache.get(ORG_ID, "u-alice", 5, computeA),
      cache.get(ORG_ID, "u-bob", 5, computeB),
    ]);
    expect(rA.hasAccess).toBe(true);
    expect(rB.hasAccess).toBe(false);
  });

  it("evicts a failed entry so the next call re-computes rather than replaying the error", async () => {
    const cache = new ProjectAccessCache();
    const err = new Error("transient");
    const compute = jest.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ hasAccess: true, role: "MEMBER" });
    await expect(cache.get(ORG_ID, "u1", 1, compute)).rejects.toThrow("transient");
    const result = await cache.get(ORG_ID, "u1", 1, compute);
    expect(result.hasAccess).toBe(true);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("invalidate(projectId) evicts only the matching project entry, leaving others intact", async () => {
    const cache = new ProjectAccessCache();
    const compute1 = jest.fn().mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const compute2 = jest.fn().mockResolvedValue({ hasAccess: true, role: "OWNER" });
    await cache.get(ORG_ID, "u1", 10, compute1);
    await cache.get(ORG_ID, "u1", 20, compute2);
    cache.invalidate(10);
    const recompute1 = jest.fn().mockResolvedValue({ hasAccess: false, role: null });
    await cache.get(ORG_ID, "u1", 10, recompute1);
    expect(recompute1).toHaveBeenCalledTimes(1);
    const recompute2 = jest.fn();
    await cache.get(ORG_ID, "u1", 20, recompute2);
    expect(recompute2).not.toHaveBeenCalled();
  });

  it("invalidate() with no argument clears all entries", async () => {
    const cache = new ProjectAccessCache();
    const compute = jest.fn().mockResolvedValue({ hasAccess: true, role: null });
    await cache.get(ORG_ID, "u1", 1, compute);
    await cache.get(ORG_ID, "u1", 2, compute);
    cache.invalidate();
    const recompute = jest.fn().mockResolvedValue({ hasAccess: false, role: null });
    await cache.get(ORG_ID, "u1", 1, recompute);
    await cache.get(ORG_ID, "u1", 2, recompute);
    expect(recompute).toHaveBeenCalledTimes(2);
  });

  it("cache is request-local: a second cache instance does not share state with the first", async () => {
    const cache1 = new ProjectAccessCache();
    const cache2 = new ProjectAccessCache();
    const compute1 = jest.fn().mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const compute2 = jest.fn().mockResolvedValue({ hasAccess: false, role: null });
    await cache1.get(ORG_ID, "u1", 1, compute1);
    await cache2.get(ORG_ID, "u1", 1, compute2);
    expect(compute1).toHaveBeenCalledTimes(1);
    expect(compute2).toHaveBeenCalledTimes(1);
  });
});

const fakeTx = {} as unknown as TenantTx;

describe("getOrCreateRequestCache — request-scoped sharing (A8)", () => {
  it("returns the same cache instance for two calls within one tenant context so a repeated project-access lookup reuses the cached promise", async () => {
    const instances: ProjectAccessCache[] = [];
    await runWithTenantContext({ orgId: "org-1", audience: "INTERNAL", tx: fakeTx }, async () => {
      instances.push(getOrCreateRequestCache());
      instances.push(getOrCreateRequestCache());
    });
    expect(instances[0]).toBe(instances[1]);
  });

  it("returns a different cache instance for two separate tenant contexts so access resolved in one request does not bleed into the next", async () => {
    const instances: ProjectAccessCache[] = [];
    await runWithTenantContext({ orgId: "org-1", audience: "INTERNAL", tx: fakeTx }, async () => {
      instances.push(getOrCreateRequestCache());
    });
    await runWithTenantContext({ orgId: "org-1", audience: "INTERNAL", tx: fakeTx }, async () => {
      instances.push(getOrCreateRequestCache());
    });
    expect(instances[0]).not.toBe(instances[1]);
  });

  it("two calls within one tenant context invoke the compute function exactly once so the underlying DB query runs once per request", async () => {
    const compute = jest.fn().mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    await runWithTenantContext({ orgId: "org-1", audience: "INTERNAL", tx: fakeTx }, async () => {
      const c1 = getOrCreateRequestCache();
      const c2 = getOrCreateRequestCache();
      await c1.get("org-1", "u1", 1, compute);
      await c2.get("org-1", "u1", 1, compute);
    });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("two calls in different tenant contexts invoke the compute function twice so cross-request state does not leak", async () => {
    const compute = jest.fn().mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    await runWithTenantContext({ orgId: "org-1", audience: "INTERNAL", tx: fakeTx }, async () => {
      await getOrCreateRequestCache().get("org-1", "u1", 1, compute);
    });
    await runWithTenantContext({ orgId: "org-1", audience: "INTERNAL", tx: fakeTx }, async () => {
      await getOrCreateRequestCache().get("org-1", "u1", 1, compute);
    });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("returns a fresh cache when there is no ambient tenant context so unit tests without runWithTenantContext do not throw", () => {
    const cache = getOrCreateRequestCache();
    expect(cache).toBeInstanceOf(ProjectAccessCache);
  });
});
