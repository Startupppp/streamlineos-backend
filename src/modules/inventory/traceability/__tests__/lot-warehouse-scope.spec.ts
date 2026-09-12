import { NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { InvTraceabilityService } from "../inv-traceability.service";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { cacheWith, dbWith, scopeOf, sqlText, type DbHarness } from "../../__tests__/warehouse-scope-harness";

/**
 * A quarantine anybody could lift, on any building's stock.
 *
 * `listLots` was scoped under INV-109 with a rule it documents at length: a lot
 * carries no warehouse column of its own, so it is attributable through the
 * stock it holds, and a lot with stock nowhere is attributable to none. The two
 * methods immediately below it kept neither half.
 *
 * `getLotDetail` took no caller id, and it returns `stockByLocation` carrying
 * warehouse ids AND warehouse names -- so it did not merely leak a lot, it drew
 * the map. `updateLotStatus` took none either, and the route behind it is
 * `inventory:stock:adjust`, which every operator holds. Releasing a lot somebody
 * else quarantined is the sharp direction: the hold vanishes, the stock becomes
 * pickable, and nobody tells the people who raised it.
 */

const ORG = "org-1";
const USER = "user-1";

function serviceWith(harness: DbHarness, scope: WarehouseScopeService) {
  const { cache } = cacheWith();
  return new InvTraceabilityService(harness.db, cache, scope);
}

describe("a lot is reachable only through stock the caller holds", () => {
  it("refuses the detail read and never draws the warehouse map", async () => {
    const harness = dbWith({ detail: { id: 5, lotNumber: "L-1" } });
    const svc = serviceWith(harness, scopeOf([7]).service);

    await expect(svc.getLotDetail(ORG, USER, 5)).rejects.toThrow(NotFoundException);

    /*
      One read. A gate that threw after loading would still satisfy `rejects`
      having already selected `warehouseName` for every building the lot is in.
    */
    expect(harness.wheres).toHaveLength(1);
  });

  it("refuses to change a lot's status, and writes nothing", async () => {
    const harness = dbWith({ detail: { id: 5, status: "QUARANTINE" } });
    const svc = serviceWith(harness, scopeOf([7]).service);

    await expect(
      svc.updateLotStatus(ORG, USER, 5, { status: "AVAILABLE" } as never),
    ).rejects.toThrow(NotFoundException);
    /* The UPDATE is the damage; `rejects` alone would not see it. */
    expect(harness.updates).toHaveLength(0);
  });

  it("uses the same EXISTS over stock levels that the list uses", async () => {
    const listHarness = dbWith({});
    await serviceWith(listHarness, scopeOf([7]).service)
      .listLots(ORG, USER, { page: 1, limit: 20 } as never);

    const detailHarness = dbWith({});
    await expect(
      serviceWith(detailHarness, scopeOf([7]).service).getLotDetail(ORG, USER, 5),
    ).rejects.toThrow(NotFoundException);

    const exists = (statement: SQL) => {
      const text = sqlText(statement).replace(/\$\d+/g, "$?").replace(/\s+/g, " ");
      const from = text.indexOf("EXISTS (");
      expect(from).toBeGreaterThanOrEqual(0);
      return text.slice(from);
    };

    expect(exists(detailHarness.wheres[0]!)).toBe(exists(listHarness.wheres[0]!));
  });

  it("shows an unrestricted caller everything, with no EXISTS at all", async () => {
    const harness = dbWith({ detail: { id: 5, lotNumber: "L-1" }, reads: [[], []] });
    const svc = serviceWith(harness, scopeOf(null).service);

    await expect(svc.getLotDetail(ORG, USER, 5)).resolves.toMatchObject({ lot: { id: 5 } });
    for (const where of harness.wheres) expect(sqlText(where)).not.toContain("EXISTS (");
  });
});
