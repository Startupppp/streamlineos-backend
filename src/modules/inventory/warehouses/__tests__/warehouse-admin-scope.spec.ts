import { NotFoundException } from "@nestjs/common";
import { InvWarehousesService } from "../inv-warehouses.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { cacheWith, dbWith, type DbHarness } from "../../__tests__/warehouse-scope-harness";

/**
 * Editing a building you are not allowed to look at.
 *
 * `getWarehouse` and `listLocations` both call `assertWarehouseVisible`.
 * `updateWarehouse`, `createLocation` and `updateLocation` -- all three behind
 * `inventory:warehouses:manage` -- took no caller id at all, so the read was
 * scoped and the write beside it was not. That is incoherent on its face, and
 * the incoherence is the proof: there is no reading in which you may edit a
 * warehouse you may not see.
 *
 * `:manage` is not org-wide authority. `inventory:warehouses:scope-all` is a
 * SEPARATE key, so a regional manager holding `:manage` and assigned one
 * building held the permission and none of the reach.
 *
 * Two of the three edits are worse than a rename. `isActive: false` deactivates
 * somebody else's warehouse. `isDefault` clears the flag on EVERY warehouse in
 * the organisation before setting it here, which quietly redirects every
 * default-destination decision to your building.
 */

const ORG = "org-1";
const USER = "user-1";

/** A scope holding warehouse 7 only, and a location lookup that finds nothing. */
function scopedTo(warehouseIds: number[] | null, locationsFound: unknown[] = []) {
  return new WarehouseScopeService(
    {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(locationsFound),
        }),
      }),
    } as never,
    {
      resolveUserPermissions: () =>
        Promise.resolve(new Set(warehouseIds === null ? ["inventory:warehouses:scope-all"] : [])),
    } as never,
  );
}

/**
 * `resolve()` and `assertLocationVisible` both read through the same stub, so a
 * scope that must resolve to [7] AND then find no location needs two different
 * answers. Handing back the warehouse rows for the first call and nothing after
 * is what a real out-of-scope location looks like.
 */
function scopeResolvingTo(warehouseIds: number[]) {
  let call = 0;
  return new WarehouseScopeService(
    {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve(call++ === 0 ? warehouseIds.map((warehouseId) => ({ warehouseId })) : []),
        }),
      }),
    } as never,
    { resolveUserPermissions: () => Promise.resolve(new Set<string>()) } as never,
  );
}

function serviceWith(harness: DbHarness, scope: WarehouseScopeService) {
  const { cache } = cacheWith();
  const stub = {} as never;
  return new InvWarehousesService(harness.db, cache, scope, stub);
}

describe("warehouse administration is scoped like the read beside it", () => {
  it("refuses to edit a warehouse the caller does not hold, and writes nothing", async () => {
    const harness = dbWith({});
    const svc = serviceWith(harness, scopedTo([]));

    await expect(
      svc.updateWarehouse(ORG, USER, 99, { name: "Renamed" } as never),
    ).rejects.toThrow(NotFoundException);

    expect(harness.transaction).not.toHaveBeenCalled();
    expect(harness.updates).toHaveLength(0);
  });

  it("refuses to make another building the organisation default", async () => {
    const harness = dbWith({});
    const svc = serviceWith(harness, scopedTo([]));

    /*
      The one that reaches beyond its own row: setting `isDefault` clears the
      flag org-wide first. Refused before the transaction opens, so no other
      warehouse's flag is touched on the way to failing.
    */
    await expect(
      svc.updateWarehouse(ORG, USER, 99, { isDefault: true } as never),
    ).rejects.toThrow(NotFoundException);
    expect(harness.updates).toHaveLength(0);
  });

  it("refuses to add a bin inside another building, and inserts nothing", async () => {
    const harness = dbWith({});
    const svc = serviceWith(harness, scopedTo([]));

    await expect(
      svc.createLocation(ORG, USER, 99, { code: "A-01", name: "Aisle 1" } as never),
    ).rejects.toThrow(NotFoundException);
    expect(harness.inserts).toHaveLength(0);
  });

  it("refuses to edit a bin in another building, scoping by the LOCATION not the path", async () => {
    const harness = dbWith({});
    const svc = serviceWith(harness, scopeResolvingTo([7]));

    /*
      The route carries a warehouse id AND a location id. Trusting the path's
      warehouse would let a caller name their own building while editing a bin
      in another, so the gate reads the location's real warehouse.
    */
    await expect(
      svc.updateLocation(ORG, USER, 4242, { isActive: false } as never),
    ).rejects.toThrow(NotFoundException);
    expect(harness.updates).toHaveLength(0);
  });

  it("lets an unrestricted caller through to the write", async () => {
    const harness = dbWith({});
    const svc = serviceWith(harness, scopedTo(null));

    /*
      The transaction mock's `execute` throws by design, and `updateWarehouse`
      opens a transaction -- so reaching it at all is the assertion. What must
      not happen is a NotFound from the gate.
    */
    await expect(
      svc.updateWarehouse(ORG, USER, 99, { name: "Renamed" } as never),
    ).rejects.not.toThrow(NotFoundException);
    expect(harness.transaction).toHaveBeenCalled();
  });
});
