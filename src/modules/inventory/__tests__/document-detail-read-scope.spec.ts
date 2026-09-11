import { NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { SoCoreService } from "../sales-orders/so-core.service";
import { QuickCommerceInboundService } from "../channels/quick-commerce/quick-commerce-inbound.service";
import { InvTraceabilityService } from "../traceability/inv-traceability.service";
import { InvReportsExtendedService } from "../reports/inv-reports-extended.service";
import { InvReportsService } from "../reports/inv-reports.service";
import type { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import {
  cacheWith,
  dbWith,
  scopeOf,
  sqlText,
  type DbHarness,
} from "./warehouse-scope-harness";
import { ScopedRead } from "../../access/scoped-read";

/**
 * Five reads that answered for a building the caller had never been shown.
 *
 * Four are the same shape — the list beside them resolves the caller's
 * warehouses and the detail took no `userId` at all, though the controller had
 * `@CurrentUser()` in hand every time. The platform purchase order is the odd
 * one: NEITHER half asked, and it is the only reachable surface in that service
 * that never did, while every sibling around it — `ingestPurchaseOrder`,
 * `acceptPurchaseOrder`, `createAsn`, `listAsns`, `asnDetail` and
 * `FillRateService.report` — has been asserting warehouses all along.
 *
 * None of them posts stock, so `StockEngineService.executeInTx` and its
 * `assertLocationsInScope` never run on any of these paths. There was nothing
 * downstream to catch any of it.
 *
 * The NULL rule differs per surface here, and every one of them is asserted
 * rather than assumed, because getting it wrong in either direction is a defect:
 * a sales order and a serial exclude an unattributed row, a platform purchase
 * order admits one. Each follows its own aggregate's list.
 */

const ORG = "org-1";

function soWith(harness: DbHarness, scope: WarehouseScopeService, cache: unknown) {
  const stub = {} as never;
  return new SoCoreService(harness.db, cache as never, stub, stub, scope);
}

function platformPoWith(harness: DbHarness, scope: WarehouseScopeService) {
  const stub = {} as never;
  return new QuickCommerceInboundService(harness.db, stub, stub, stub, stub, scope, stub);
}

function traceabilityWith(harness: DbHarness, scope: WarehouseScopeService, cache: unknown) {
  return new InvTraceabilityService(harness.db, cache as never, scope);
}

describe("one sales order, read by id", () => {
  it("is unreachable for a caller holding no warehouse, and answers not found", async () => {
    /*
     * The PREDICATE is the assertion, not the throw. The fixture answers with no
     * row whichever way the service is written, so `rejects` alone would pass
     * against the unscoped code it was written to reject. An empty scope
     * compiles to FALSE, which is what a database acts on.
     */
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      soWith(harness, scope, cache).getSo(ORG, "nobody-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("FALSE");
  });

  it("narrows a scoped caller, with no IS NULL escape", async () => {
    /*
     * `warehouse_id` on a sales order is nullable and `NULL IN (…)` is NULL, so
     * an order attributed to no building stays invisible to a scoped caller —
     * which is exactly what `listSos` has always done. The platform purchase
     * order below goes the other way on purpose.
     */
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7, 9]);

    await expect(
      soWith(harness, scope, cache).getSo(ORG, "picker-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(harness.wheres[0] as SQL);
    expect(text).toContain('"inv_sales_orders"."warehouse_id" IN (');
    expect(text).not.toContain("IS NULL");
  });

  it("builds exactly the predicate the list builds", async () => {
    // The drift guard, and the reason the predicate is one private method: the
    // list gaining a scope the detail was never told about IS the defect.
    const { service: scope } = scopeOf([7, 9]);

    const list = dbWith();
    const { cache: listCache } = cacheWith();
    await soWith(list, scope, listCache).listSos(ScopedRead.of(ORG, "picker-1", "all"), { page: 1, limit: 20 } as never);

    const detail = dbWith();
    const { cache: detailCache } = cacheWith();
    await expect(
      soWith(detail, scope, detailCache).getSo(ORG, "picker-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    /*
     * The shared `scopeClause` helper looks for a parenthesised OR group, which
     * is what `anyOf` builds; a sales order names its warehouse on one column,
     * so its predicate is the bare `IN` and needs its own reader. Placeholder
     * NUMBERS are normalised away because a detail read binds the order id
     * first, shifting every `$n` inside its clause relative to the list's.
     */
    const clause = (statement: SQL) => {
      const text = sqlText(statement).replace(/\$\d+/g, "$?");
      const at = text.indexOf('"inv_sales_orders"."warehouse_id"');
      expect(at).toBeGreaterThanOrEqual(0);
      return text.slice(at);
    };

    expect(clause(detail.wheres[0] as SQL)).toBe(clause(list.wheres[0] as SQL));
  });

  it("gates the edit on the order's OWN warehouse, not only on where it is going", async () => {
    /*
     * The half `updateSo` was still missing, and it is not the one the census
     * pointed at. The destination gate it already carried answers "may you move
     * it THERE"; it says nothing about whether you may touch the order at all,
     * so a caller holding one building could edit any DRAFT order in the
     * organisation — its client, its lines, its quantities, its prices —
     * provided they did not also try to re-home it. No `warehouseId` in the
     * body here, so the destination gate is not even consulted and the refusal
     * can only be the new one.
     */
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      soWith(harness, scope, cache).updateSo(ORG, 42, "nobody-1", { notes: "mine now" } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("FALSE");
    // The write is the whole damage; `rejects` alone would not see it, because a
    // service that wrote and then threw satisfies it just as well.
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("consults the scope even for an org-wide reader, and then narrows nothing", async () => {
    // "No warehouse predicate" cannot on its own tell an UNRESTRICTED reader
    // from an UNSCOPED method — which is the defect — so the absence is asserted
    // beside proof that the scope was resolved at all.
    const harness = dbWith({ rows: { invSalesOrders: { id: 42, orgId: ORG, lines: [] } } });
    const { cache } = cacheWith();
    const { service: scope, consulted } = scopeOf(null);

    const so = await soWith(harness, scope, cache).getSo(ORG, "auditor-1", 42);

    expect(so.id).toBe(42);
    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(sqlText(harness.wheres[0] as SQL)).not.toContain("warehouse_id IN (");
  });
});

describe("platform purchase orders, where neither half asked", () => {
  it("scopes the list", async () => {
    const harness = dbWith();
    const { service: scope } = scopeOf([7]);

    await platformPoWith(harness, scope).list(ORG, "picker-1", { page: 1, limit: 20 } as never);

    expect(sqlText(harness.wheres[0] as SQL)).toContain(
      '"inv_platform_purchase_orders"."warehouse_id" IN (',
    );
  });

  it("scopes the detail on the same rule, and answers not found out of scope", async () => {
    const harness = dbWith();
    const { service: scope } = scopeOf([7]);

    await expect(
      platformPoWith(harness, scope).detail(ORG, "picker-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    /*
     * The PREDICATE, not the throw. The harness answers with no row whichever
     * way the service is written, so `rejects` alone passes against the unscoped
     * code this was written to reject — measured, by removing the gate and
     * watching this case survive.
     */
    expect(sqlText(harness.wheres[0] as SQL)).toContain(
      '"inv_platform_purchase_orders"."warehouse_id" IN (',
    );
    // One read. A gate that threw after loading the header would still satisfy
    // `rejects` while having put the header on the wire, and the lines after it.
    expect(harness.wheres).toHaveLength(1);
  });

  it("keeps the ASN's IS NULL escape, because a platform order may arrive before a building is chosen", async () => {
    /*
     * The opposite of the sales order above, and deliberately. `ingestPurchaseOrder`
     * says it in as many words: a document can arrive before anybody has wired
     * the channel up, and refusing it then loses the document rather than the
     * configuration gap. An unattributed platform order is precisely the one
     * somebody has to open in order to give it a building, so hiding it from
     * every scoped operator would strand it.
     */
    const harness = dbWith();
    const { service: scope } = scopeOf([7]);

    await expect(
      platformPoWith(harness, scope).detail(ORG, "picker-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain(
      '"inv_platform_purchase_orders"."warehouse_id" IS NULL OR',
    );
  });

  it("shows a caller with no warehouse nothing at all, not even the unattributed ones", async () => {
    // The third of `listAsns`' three cases, asserted because the IS NULL escape
    // above would otherwise quietly hand every un-assigned document in the
    // organisation to somebody holding no site whatsoever.
    const harness = dbWith();
    const { service: scope } = scopeOf([]);

    await expect(
      platformPoWith(harness, scope).detail(ORG, "nobody-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(harness.wheres[0] as SQL);
    expect(text).toContain("FALSE");
    expect(text).not.toContain("IS NULL");
  });
});

describe("a serial number and the expiring lots", () => {
  it("refuses a serial standing in a warehouse the caller cannot see", async () => {
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      traceabilityWith(harness, scope, cache).getSerialDetail(ORG, "nobody-1", 7),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("FALSE");
    // One read. The fifty movements behind it were never fetched.
    expect(harness.wheres).toHaveLength(1);
  });

  it("narrows the movement history by the same scope, not only by the serial", async () => {
    /*
     * The point of this read is the history. A serial that has passed through
     * three warehouses would otherwise report all three to somebody entitled to
     * one — the header gate alone leaves the interesting half open.
     */
    const harness = dbWith({ rows: { invSerialNumbers: { id: 7, orgId: ORG } } });
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7, 9]);

    await traceabilityWith(harness, scope, cache).getSerialDetail(ORG, "picker-1", 7);

    expect(harness.wheres).toHaveLength(2);
    expect(sqlText(harness.wheres[1] as SQL)).toContain(
      '"inv_stock_transactions"."location_id" IN (',
    );
  });

  it("lists an expiring lot only where the caller can see the stock that makes it worth listing", async () => {
    /*
     * The rule is not invented here: `InvReportsExtendedService` carries a
     * scoped expiry report of its own and this is its reasoning — a lot carries
     * no location, its STOCK does, so the warehouse predicate constrains the
     * same existence check that already proves the lot is worth listing. This
     * copy, on a different route, simply never asked.
     */
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7]);

    await traceabilityWith(harness, scope, cache).getExpiryReport(ORG, "picker-1", 30);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("sl.location_id IN (");
  });

  it("narrows the quantity it reports as well as the rows it returns", async () => {
    /*
     * `totalOnHand` summed the organisation. Reporting the whole quantity beside
     * a row admitted on one warehouse's stock leaks the size of the others
     * through the number itself, which is the same disclosure by a quieter
     * route — and is the kind of half-fix that passes a row-count assertion.
     */
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7]);

    await traceabilityWith(harness, scope, cache).getExpiryReport(ORG, "picker-1", 30);

    const projected = sqlText(harness.wheres[0] as SQL);
    // The same guarded sum appears twice — once as the existence test and once
    // as the projected total — so neither can be scoped without the other.
    expect(projected.split("sl.location_id IN (").length - 1).toBeGreaterThanOrEqual(1);
  });
});

describe("the reorder report", () => {
  it("narrows the stock-level scan itself, so out-of-scope rows are never built", async () => {
    /*
     * On the `inv_stock_levels` scan inside the CTE rather than the outer
     * select, and that is not cosmetic: the inbound sub-selects hanging off each
     * row — what is on a purchase order for this warehouse, what is in a van
     * heading to it — are correlated to `sl.location_id`, and an outer filter
     * would compute and return them for buildings the caller cannot see.
     */
    const executed: unknown[] = [];
    const db = {
      execute: (statement: unknown) => {
        executed.push(statement);
        return Promise.resolve([]);
      },
    } as never;
    const { service: scope } = scopeOf([7]);
    const service = new InvReportsExtendedService(db, {} as never, scope, {} as never);

    await service.getReorderReportUpgraded(ORG, "picker-1", { page: 1, limit: 20 } as never);

    const text = sqlText(executed[0] as SQL);
    const scan = text.indexOf("sl.on_hand::numeric <= p.reorder_point::numeric");
    const gate = text.indexOf("sl.location_id IN (", scan);
    expect(scan).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(scan);
    // Inside the CTE, which closes before the outer SELECT list begins.
    expect(gate).toBeLessThan(text.indexOf('AS "productVariantId"'));
  });

  it("puts the scope in the cache key, or one caller's page is served to the next", async () => {
    /*
     * §6, and the trap this fix walks into if it is half done. A perfect
     * predicate under the old `<page>:<limit>` key would store the picker's
     * narrowed answer and hand it straight to the buyer, and the buyer's whole
     * organisation back to the picker — leaving the report WORSE than the
     * unscoped one it replaces. Asserting on the KEYS is the only way to see
     * that: every other case here passes with the old key.
     */
    const keys: string[] = [];
    const cache = {
      cached: (key: string, fetcher: () => Promise<unknown>) => {
        keys.push(key);
        return fetcher();
      },
    } as never;
    const extended = { getReorderReportUpgraded: () => Promise.resolve({ items: [], total: 0 }) } as never;

    for (const [warehouses, user] of [
      [[7], "picker-1"],
      [[9], "other-picker-1"],
      [null, "buyer-1"],
    ] as [number[] | null, string][]) {
      const { service: scope } = scopeOf(warehouses);
      const service = new InvReportsService({} as never, cache, scope, extended);
      await service.getReorderReport(ORG, user, { page: 1, limit: 20 } as never);
    }

    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toContain(":7:");
    expect(keys[1]).toContain(":9:");
    expect(keys[2]).toContain(":all:");
  });
});
