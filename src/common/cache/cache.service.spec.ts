import { CacheService } from "./cache.service";

describe("CacheService (no redis)", () => {
  const svc = new CacheService(null);

  it("falls back to the fetcher when redis is absent", async () => {
    const fetcher = jest.fn().mockResolvedValue(99);
    await expect(svc.cached("k", fetcher)).resolves.toBe(99);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("invalidate is a no-op without redis", async () => {
    await expect(svc.invalidate("k")).resolves.toBeUndefined();
  });
});
