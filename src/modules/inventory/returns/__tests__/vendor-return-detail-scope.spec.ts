import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { VendorReturnsService } from "../vendor-returns.service";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { cacheWith, dbWith, scopeClause, scopeOf, sqlText } from "./warehouse-scope-harness";

/**
 * The customer half's twin, against a different attribution rule.
 *
 * `list` resolves the caller's warehouses and attributes each vendor return
 * through the RECEIPT it is sending back. `get` took no `userId` — the
 * controller had `@CurrentUser()` and passed only `orgId` — so a return an
 * operator could not see in their list was theirs to read whole, vendor and
 * lines included. `cancel` was the same and writes; `approve` and `post` had a
 * `userId` and spent it on authorship columns.
 *
 * Worth keeping separate from the customer suite rather than parameterising the
 * two together: the rules are genuinely different. A customer return is
 * attributed through a sales order or a shipment, both of which name a
 * WAREHOUSE; a vendor return is attributed through a GRN, which names a
 * LOCATION. `scope.warehouse` there, `scope.location` here — following each
 * aggregate rather than a house default is the entire point of this pass, and a
 * shared parameterised suite would have quietly imposed one rule on both.
 */

function serviceWith(
  db: unknown,
  cache: unknown,
  scope: WarehouseScopeService,
  engine: unknown = {},
): VendorReturnsService {
  return new VendorReturnsService(
    db as never,
    cache as never,
    engine as never,
    {} as never,
    scope,
  );
}

describe("one vendor return, read by id", () => {
  it("makes it unreachable for a caller holding no warehouse, and answers not found", async () => {
    /*
     * The PREDICATE is the assertion, not the throw: the fixture answers with no
     * row whichever way the service is written, so `rejects` alone would pass
     * against the unscoped code it was written to reject. 404 rather than 403,
     * per §4 — "forbidden" on a return id confirms the return exists.
     */
    const { db, wheres } = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(db, cache, scope).get("org-1", "nobody-1", 5),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(wheres[0] as SQL)).toContain("inv_grns WHERE org_id = $3 AND FALSE");
  });

  it("narrows through the receipt's LOCATION, and excludes a return raised against no receipt", async () => {
    /*
     * `grn_id IN (SELECT id FROM inv_grns WHERE … location_id IN (the caller's
     * warehouses))` — the list's predicate, because it is now the same
     * expression. Note `location_id`, not `warehouse_id`: a GRN names the bin it
     * was received into, so this goes through `scope.location` where the
     * customer half goes through `scope.warehouse`. Asserted explicitly so the
     * two cannot be quietly collapsed into one rule.
     *
     * The NULL rule: a NULL `grn_id` makes `NULL IN (…)` NULL, so a vendor
     * return raised against no receipt is EXCLUDED from a scoped caller's view.
     * Not the ASN rule, where an unattributed row stays visible to everyone —
     * there a null warehouse means "not known yet", here it means the return is
     * anchored to no receipt and therefore to no warehouse.
     */
    const { db, wheres } = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7, 9]);

    await expect(
      serviceWith(db, cache, scope).get("org-1", "picker-1", 5),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(wheres[0] as SQL);
    expect(text).toContain("inv_grns WHERE org_id = $3 AND location_id IN (");
    expect(text).toContain("WHERE warehouse_id IN ($4, $5)");
    expect(text).not.toContain("IS NULL");
  });

  it("consults the scope even for an org-wide reader, and then narrows nothing", async () => {
    // "No predicate" cannot on its own tell an UNRESTRICTED reader from an
    // UNSCOPED method — which is the defect — so the absence is asserted
    // alongside proof that the scope was resolved at all.
    const { db, wheres } = dbWith({ detail: { id: 5, orgId: "org-1", lines: [] } });
    const { cache } = cacheWith();
    const { service: scope, consulted } = scopeOf(null);

    await serviceWith(db, cache, scope).get("org-1", "auditor-1", 5);

    expect(consulted).toHaveBeenCalledWith("org-1", "auditor-1");
    expect(sqlText(wheres[0] as SQL)).not.toContain("inv_grns");
  });

  it("builds exactly the predicate the list builds", async () => {
    // The drift guard, and the reason the predicate lives in one private method
    // rather than a second copy: the list gained its scope and the detail beside
    // it was never told, which is the whole defect.
    const { service: scope } = scopeOf([7, 9]);

    const list = dbWith();
    const { cache: listCache } = cacheWith();
    await serviceWith(list.db, listCache, scope).list("org-1", "picker-1", {
      page: 1,
      limit: 20,
    } as never);

    const detail = dbWith();
    const { cache: detailCache } = cacheWith();
    await expect(
      serviceWith(detail.db, detailCache, scope).get("org-1", "picker-1", 5),
    ).rejects.toBeInstanceOf(NotFoundException);

    const fromList = scopeClause(sqlText(list.wheres[0] as SQL), "inv_vendor_returns");
    const fromDetail = scopeClause(sqlText(detail.wheres[0] as SQL), "inv_vendor_returns");
    expect(fromList).toContain("inv_grns");
    expect(fromDetail).toBe(fromList);
  });
});

describe("cancelling a vendor return", () => {
  it("refuses one outside the caller's warehouses, and writes nothing", async () => {
    // Asserted on the predicate AND on no UPDATE: a version that cancelled first
    // and refused afterwards would satisfy a throw-only assertion, and the
    // fixture returns no row either way so the throw proves nothing alone.
    const { db, wheres, updates } = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(db, cache, scope).cancel("org-1", "nobody-1", 5),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(wheres[0] as SQL)).toContain("AND FALSE");
    expect(updates).toHaveLength(0);
  });

  it("applies the list's own predicate for a scoped canceller", async () => {
    const { db, wheres, updates } = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7]);

    await expect(
      serviceWith(db, cache, scope).cancel("org-1", "picker-1", 5),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(wheres[0] as SQL)).toContain("WHERE warehouse_id IN ($4)");
    expect(updates).toHaveLength(0);
  });
});

describe("approving and posting a vendor return", () => {
  it("refuses to approve one outside the caller's warehouses, before the row is ever locked", async () => {
    /*
     * `approve` opens with `SELECT … FOR UPDATE`, so the assertion is that the
     * transaction was never opened. The harness's transaction mock DOES run its
     * callback — one that skipped it would void every assertion inside — and the
     * tx it hands over throws on `execute`, so a gate that failed to refuse
     * fails loudly rather than passing quietly.
     */
    const { db, wheres, transaction } = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(db, cache, scope).approve("org-1", 5, "nobody-1", {} as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(transaction).not.toHaveBeenCalled();
    expect(sqlText(wheres[0] as SQL)).toContain("AND FALSE");
  });

  it("refuses to post one outside the caller's warehouses, before the idempotency claim", async () => {
    // The engine refuses the movements, but only for lines that produce any and
    // only with a 403 that confirms the return exists. Refusing here also keeps
    // an out-of-scope post from burning an idempotency key.
    const { db, wheres, transaction } = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(db, cache, scope).post("org-1", 5, "nobody-1", "key-1", {} as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(transaction).not.toHaveBeenCalled();
    expect(sqlText(wheres[0] as SQL)).toContain("AND FALSE");
  });
});

describe("the ungated read that is allowed to stay", () => {
  it("is a separate named private method, not a flag on the public one", () => {
    // `create` hands back the return it has just written, and gating that would
    // 404 an operator against their own new record — so the unscoped read is
    // named and private rather than a boolean a future route could be pointed
    // at. Same shape as `loadAsnUnscoped`.
    const service = readFileSync(join(__dirname, "..", "vendor-returns.service.ts"), "utf8");
    expect(service).toContain("private loadVendorReturnUnscoped(orgId: string, returnId: number)");
    expect(service).toContain("return this.loadVendorReturnUnscoped(orgId, ret.id);");
    expect(service).toMatch(/async get\(orgId: string, userId: string, returnId: number\)/);
    expect(service).toMatch(/async cancel\(orgId: string, userId: string, returnId: number\)/);

    const controller = readFileSync(join(__dirname, "..", "vendor-returns.controller.ts"), "utf8");
    expect(controller).toContain("this.service.get(u.orgId, u.userId, returnId)");
    expect(controller).toContain("this.service.cancel(u.orgId, u.userId, returnId)");
  });
});
