import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { InvVendorsService } from "./inv-vendors.service";

describe("InvVendorsService versioned cache namespace", () => {
  it("uses the org-scoped namespace for list readers", async () => {
    const cachedVersioned = jest.fn().mockResolvedValue({ items: [] });
    const service = new InvVendorsService({} as never, { cachedVersioned } as never);

    await service.listVendors("org-a", {
      page: 1,
      limit: 25,
    });

    expect(cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.invVendorsNamespace("org-a"),
      "::25:0",
      expect.any(Function),
      30,
    );
  });

  it("bumps the same namespace after a create", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: 1, code: "V-1" }]);
    const db = {
      query: { invVendors: { findFirst: jest.fn().mockResolvedValue(undefined) } },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning }),
      }),
    };
    const invalidateNamespace = jest.fn().mockResolvedValue(undefined);
    const service = new InvVendorsService(db as never, { invalidateNamespace } as never);

    await service.createVendor("org-a", "user-a", {
      name: "Vendor One",
      code: "V-1",
      leadTimeDays: 0,
      paymentTermsDays: 30,
      currency: "USD",
    });

    expect(invalidateNamespace).toHaveBeenCalledWith(
      CACHE_KEYS.invVendorsNamespace("org-a"),
    );
  });
});
