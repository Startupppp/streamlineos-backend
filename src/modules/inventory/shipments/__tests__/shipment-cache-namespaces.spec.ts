import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { CarriersService } from "../carriers.service";
import { LoadsService } from "../loads.service";
import { PackagesService } from "../packages.service";
import { ShipmentsService } from "../shipments.service";

describe("shipment versioned cache contracts", () => {
  const cachedVersioned = jest.fn().mockResolvedValue({ items: [], total: 0 });
  const cache = { cachedVersioned };

  beforeEach(() => cachedVersioned.mockClear());

  it.each([
    [
      CACHE_KEYS.invCarriersNamespace("org-1"),
      () => new CarriersService({} as never, cache as never, {} as never).list("org-1"),
    ],
    [
      CACHE_KEYS.invLoadsNamespace("org-1"),
      () => new LoadsService({} as never, cache as never, {} as never, {} as never)
        .list("org-1", { page: 1, limit: 25 }),
    ],
    [
      CACHE_KEYS.invPackagesNamespace("org-1"),
      () => new PackagesService({} as never, cache as never, {} as never, {} as never)
        .list("org-1", { page: 1, limit: 25 }),
    ],
    [
      CACHE_KEYS.invShipmentsNamespace("org-1"),
      () => new ShipmentsService(
        {} as never,
        cache as never,
        {} as never,
        {} as never,
        {} as never,
      ).list("org-1", { page: 1, limit: 25 }),
    ],
  ])("reads through namespace %s", async (namespace, read) => {
    await read();
    expect(cachedVersioned).toHaveBeenCalledWith(
      namespace,
      expect.any(String),
      expect.any(Function),
      expect.any(Number),
    );
  });
});
