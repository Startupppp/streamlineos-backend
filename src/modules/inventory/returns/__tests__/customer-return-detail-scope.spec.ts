import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { CustomerReturnsService } from "../customer-returns.service";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { cacheWith, dbWith, scopeClause, scopeOf, sqlText } from "../../__tests__/warehouse-scope-harness";

/**
 * `list` was scoped and everything you could do to one return by id was not.
 *
 * The list resolves the caller's warehouses and attributes each return through
 * the order or the shipment it came back against. `get` took no `userId` at all
 * — the controller had `@CurrentUser()` in hand and passed only `orgId` — so a
 * return an operator could not see in their list was theirs to read whole:
 * client, creator, approver, every line.
 *
 * `cancel` was the same and worse, because it writes. Any return in the
 * organisation could be cancelled by id, including one approved in a warehouse
 * the caller has never worked in, and cancellation is exactly the operation
 * whose damage is invisible until somebody goes looking for goods that were
 * supposed to be coming back.
 *
 * `approve`, `post` and `inspectLine` had `userId` and spent it only on
 * authorship columns. `post`'s stock movements were refused by the engine, but
 * only for the lines that produce movements and only with a 403 that confirms
 * the return exists; the approval and the disposition in front of it were
 * reachable outright.
 */

function serviceWith(
  db: unknown,
  cache: unknown,
  scope: WarehouseScopeService,
  engine: unknown = {},
): CustomerReturnsService {
  return new CustomerReturnsService(
    db as never,
    cache as never,
    engine as never,
    {} as never,
    scope,
  );
}

describe("one customer return, read by id", () => {
  it("makes it unreachable for a caller holding no warehouse, and answers not found", async () => {
    /*
     * The PREDICATE is the assertion, not the throw. The fixture answers with no
     * row whichever way the service is written, so `rejects` alone would pass
     * against the unscoped code it was written to reject. An empty scope
     * compiles both arms to `… AND FALSE`, and that is what a database acts on.
     *
     * 404 rather than 403 is deliberate and load-bearing: §4 bars an existence
     * oracle, and "forbidden" on a return id is one.
     */
    const { db, wheres } = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(db, cache, scope).get("org-1", "nobody-1", 5),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(wheres[0] as SQL);
    expect(text).toContain("inv_sales_orders WHERE org_id = $3 AND FALSE");
    expect(text).toContain("inv_shipments WHERE org_id = $4 AND FALSE");
  });

  it("narrows a scoped caller to their own warehouses, and excludes a return anchored to neither document", async () => {
    /*
     * The list's rule, character for character, because it is now the same
     * expression: visible when the sales order OR the shipment sits in one of
     * the caller's warehouses.
     *
     * The NULL rule is the half worth stating, and it differs by table on
     * purpose. A NULL `so_id` makes `NULL IN (…)` NULL; so does a NULL
     * `shipment_id`; `NULL OR NULL` is NULL, which is not true — so a return
     * anchored to neither document is INVISIBLE to a scoped operator. That is
     * the opposite of the ASN detail, which keeps `warehouse_id IS NULL OR …`
     * because an ASN's warehouse may simply not be known yet. A return with no
     * order and no shipment is anchored to nothing. Hence the absence of any
     * `IS NULL` escape is asserted rather than merely left out.
     */
    const { db, wheres } = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7, 9]);

    await expect(
      serviceWith(db, cache, scope).get("org-1", "picker-1", 5),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(wheres[0] as SQL);
    expect(text).toContain("inv_sales_orders WHERE org_id = $3 AND warehouse_id IN ($4, $5)");
    expect(text).toContain("inv_shipments WHERE org_id = $6 AND warehouse_id IN ($7, $8)");
    expect(text).toContain(" OR ");
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
    expect(sqlText(wheres[0] as SQL)).not.toContain("inv_sales_orders");
  });

  it("builds exactly the predicate the list builds", async () => {
    /*
     * The drift guard, and the reason the predicate lives in one private method
     * rather than a second copy. Two hand-copied predicates agreeing today is
     * not the same as them being one predicate: this list gained its scope and
     * the detail beside it was simply never told, which is the whole defect.
     */
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

    const fromList = scopeClause(sqlText(list.wheres[0] as SQL), "inv_customer_returns");
    const fromDetail = scopeClause(sqlText(detail.wheres[0] as SQL), "inv_customer_returns");
    expect(fromList).toContain("inv_sales_orders");
    expect(fromDetail).toBe(fromList);
  });
});

describe("cancelling a customer return", () => {
  it("refuses one outside the caller's warehouses, and writes nothing", async () => {
    /*
     * Asserted on the predicate AND on no UPDATE having been issued: a version
     * that cancelled first and refused afterwards would satisfy a throw-only
     * assertion, and the fixture returns no row either way so the throw proves
     * nothing on its own.
     */
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

    expect(sqlText(wheres[0] as SQL)).toContain("warehouse_id IN ($4)");
    expect(updates).toHaveLength(0);
  });
});

describe("the other mutations that take a return id", () => {
  it("refuses to approve one outside the caller's warehouses, before the row is ever locked", async () => {
    /*
     * `approve` opens with `SELECT … FOR UPDATE`, so the assertion is that the
     * transaction was never opened at all. The harness's transaction mock DOES
     * run its callback — a mock that silently skipped it would void every
     * assertion inside — and the tx it passes throws on `execute`, so a gate
     * that failed to refuse fails loudly rather than passing quietly.
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
    /*
     * The engine does refuse the movements — but only for the lines that produce
     * any, and with a 403 that confirms the return exists. Refusing here means
     * an out-of-scope post never reaches the claim, so it cannot burn an
     * idempotency key either.
     */
    const { db, wheres, transaction } = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(db, cache, scope).post("org-1", 5, "nobody-1", "key-1", {} as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(transaction).not.toHaveBeenCalled();
    expect(sqlText(wheres[0] as SQL)).toContain("AND FALSE");
  });

  it("refuses to record a disposition on one outside the caller's warehouses", async () => {
    // Recording a disposition decides what happens to the goods, and it gated on
    // the return's STATUS and nothing else.
    const { db, wheres, updates } = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(db, cache, scope).inspectLine("org-1", "nobody-1", 5, {
        lineId: 1,
        disposition: "RESTOCK",
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(wheres[0] as SQL)).toContain("AND FALSE");
    expect(updates).toHaveLength(0);
  });
});

describe("the ungated read that is allowed to stay", () => {
  it("is a separate named private method, not a flag on the public one", () => {
    /*
     * `create` ends by handing back the return it has just written, and gating
     * that would 404 an operator against their own new record. So the unscoped
     * read is named, private, and reachable only from the tails entitled to it,
     * rather than a boolean on `get` that a future route could be pointed at by
     * accident. Same shape as `loadAsnUnscoped`.
     */
    const service = readFileSync(join(__dirname, "..", "customer-returns.service.ts"), "utf8");
    expect(service).toContain(
      "private loadCustomerReturnUnscoped(orgId: string, returnId: number)",
    );
    expect(service).toContain("return this.loadCustomerReturnUnscoped(orgId, ret.id);");
    expect(service).toMatch(/async get\(orgId: string, userId: string, returnId: number\)/);
    expect(service).toMatch(/async cancel\(orgId: string, userId: string, returnId: number\)/);

    // The half the census cannot see: a controller still sending only `orgId`.
    const controller = readFileSync(join(__dirname, "..", "customer-returns.controller.ts"), "utf8");
    expect(controller).toContain("this.service.get(u.orgId, u.userId, returnId)");
    expect(controller).toContain("this.service.cancel(u.orgId, u.userId, returnId)");
  });
});
