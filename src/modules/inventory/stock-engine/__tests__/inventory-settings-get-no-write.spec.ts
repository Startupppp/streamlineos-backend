import { InventorySettingsService, defaultInvSettingsRow } from "../inventory-settings.service";

function buildCacheMiss() {
  return {
    cached: jest.fn().mockImplementation(
      async (_key: string, fn: () => unknown) => fn(),
    ),
    invalidate: jest.fn(),
    invalidateNamespace: jest.fn(),
    cachedVersioned: jest.fn(),
  };
}

function buildDb(findFirstResult: unknown) {
  const insert = jest.fn();
  const findFirst = jest.fn().mockResolvedValue(findFirstResult);
  const db = {
    query: new Proxy({} as Record<string, unknown>, { get: () => ({ findFirst }) }),
    insert,
  };
  return { db, insert, findFirst };
}

describe("InventorySettingsService.get — cache miss, no row in DB", () => {
  it("returns the in-memory defaults and never issues an INSERT when no settings row exists (write-in-GET bug, cache-miss path)", async () => {
    const { db, insert, findFirst } = buildDb(null);
    const cache = buildCacheMiss();
    const svc = new InventorySettingsService(db as never, cache as never);

    const result = await svc.get("org-new");

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
    expect(result).toEqual(defaultInvSettingsRow());
  });

  it("returns the persisted row and never issues an INSERT when a settings row exists (cache-miss path, control)", async () => {
    const { db, insert } = buildDb({ orgId: "org-existing", allowNegativeStock: true });
    const cache = buildCacheMiss();
    const svc = new InventorySettingsService(db as never, cache as never);

    const result = await svc.get("org-existing");

    expect(insert).not.toHaveBeenCalled();
    expect(result.allowNegativeStock).toBe(true);
  });
});
