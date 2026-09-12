import { NotFoundException, ForbiddenException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { InvStockAdjustmentsService } from "../inv-stock-adjustments.service";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import type { CreateAdjustmentInput } from "../dto/inv-stock.schemas";
import { cacheWith, dbWith, scopeOf, sqlText, type DbHarness } from "../../__tests__/warehouse-scope-harness";
import { ScopedRead } from "../../../access/scoped-read";

/**
 * Five ways to reach another building's write-off, behind a list that scopes.
 *
 * `listAdjustments` has scoped since the warehouse work landed -- an adjustment
 * is in scope when any of its lines sits in a location in one of the caller's
 * warehouses -- and `getAdjustment`, `approveAdjustment`, `postAdjustment` and
 * `cancelAdjustment` all reached the row on `org_id` and the id alone. The
 * controller had `@CurrentUser()` in hand for three of them and spent it only on
 * cost visibility; `cancelAdjustment` was never given it.
 *
 * WHY IT SURVIVED, which is the part worth keeping. The STOCK was never at risk:
 * `StockEngineService.executeInTx` calls `assertLocationsInScope` on every
 * movement, so posting an out-of-scope adjustment is refused there. Anyone
 * checking "can I move stock in Chennai from Pune" got the right answer and
 * stopped. What was open is the DOCUMENT -- reading a write-off with its lines,
 * locations and value; approving one, which satisfies maker-checker for a
 * warehouse you have no standing in and leaves an in-scope poster free to post
 * it; and cancelling one out of somebody else's queue.
 */

const ORG = "org-1";
const USER = "user-1";

/** A scope that resolves to a warehouse the row is not in. */
function outOfScope() {
  return scopeOf([7]);
}

function serviceWith(harness: DbHarness, scope: WarehouseScopeService) {
  const { cache } = cacheWith();
  const stub = {} as never;
  return new InvStockAdjustmentsService(
    harness.db,
    cache,
    stub,
    stub,
    /*
      Settings and the threshold rule run before the gate. They must ANSWER
      rather than be absent, or the create dies on a missing stub and the
      refusal under test is never reached.
    */
    { get: () => Promise.resolve({ adjustmentApprovalThreshold: null }) } as never,
    scope,
    { canSeeCost: () => Promise.resolve(false) } as never,
    { post: jest.fn().mockResolvedValue(undefined) } as never,
  );
}

function lastRead(harness: DbHarness): SQL {
  return harness.wheres[harness.wheres.length - 1]!;
}

describe("an adjustment document is reachable only inside the caller's warehouses", () => {
  it("refuses the detail read, and does not fall through to the unscoped query", async () => {
    /* `reads` is empty, so the gate's EXISTS finds nothing. */
    const harness = dbWith({ detail: { id: 42, status: "PENDING_APPROVAL" } });
    const svc = serviceWith(harness, outOfScope().service);

    await expect(svc.getAdjustment(ORG, 42, USER)).rejects.toThrow(NotFoundException);

    /*
      One read, not two. A gate that threw AFTER loading the row would still
      satisfy `rejects` while having already put the lines, the locations and
      the write-off value on the wire.
    */
    expect(harness.wheres).toHaveLength(1);
  });

  it("refuses approval before maker-checker is even consulted", async () => {
    const harness = dbWith({ detail: { id: 42, createdBy: USER, status: "PENDING_APPROVAL" } });
    const svc = serviceWith(harness, outOfScope().service);

    /*
      `createdBy` is deliberately the caller, so the maker-checker rule would
      also refuse -- with a Forbidden. Asserting NotFound proves the warehouse
      gate ran FIRST, and that the answer does not confirm the row exists.
    */
    await expect(svc.approveAdjustment(ORG, USER, 42, "key-1")).rejects.toThrow(NotFoundException);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("refuses to post, and never opens the transaction the engine would gate inside", async () => {
    const harness = dbWith({ detail: { id: 42, status: "APPROVED", lines: [] } });
    const svc = serviceWith(harness, outOfScope().service);

    await expect(svc.postAdjustment(ORG, USER, 42, "key-1")).rejects.toThrow(NotFoundException);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("refuses to cancel, and writes nothing", async () => {
    const harness = dbWith({ detail: { id: 42, status: "PENDING_APPROVAL" } });
    const svc = serviceWith(harness, outOfScope().service);

    await expect(svc.cancelAdjustment(ORG, USER, 42)).rejects.toThrow(NotFoundException);
    /* The UPDATE is the whole damage here; `rejects` alone would not see it. */
    expect(harness.updates).toHaveLength(0);
  });

  it("lets an unrestricted caller straight through", async () => {
    const harness = dbWith({ detail: { id: 42, status: "PENDING_APPROVAL" } });
    const svc = serviceWith(harness, scopeOf(null).service);

    await expect(svc.cancelAdjustment(ORG, USER, 42)).resolves.toBeUndefined();
    expect(harness.updates).toHaveLength(1);
  });
});

describe("the create-side claim", () => {
  const body: CreateAdjustmentInput = {
    reason: "RECOUNT",
    notes: null,
    lines: [{ productVariantId: 1, locationId: 99, quantityChange: 5, notes: null }],
  } as unknown as CreateAdjustmentInput;

  it("refuses locations the caller does not hold, and inserts nothing", async () => {
    /*
      Over the approval threshold the command stops at PENDING_APPROVAL and posts
      nothing, so the engine's own `assertLocationsInScope` never sees it -- the
      document simply exists, naming another building's locations and sitting in
      that building's queue.
    */
    /*
      The variant lookup runs first and must ANSWER, or the create fails on a
      missing product and the gate behind it is never reached -- a green test
      over a code path that never ran.
    */
    const harness = dbWith({
      detail: undefined,
      reads: [
        /*
          The tenant check (`assertLinesResolve`, from the accounting merge) runs
          first and 404s unless the variant and the location are this
          organisation's. Location 99 IS the org's; it is only outside the
          caller's warehouses, which is the refusal under test.
        */
        [{ id: 1 }],
        [{ id: 99 }],
        [{ id: 1, productId: 1, sku: "SKU", costPrice: "1", sellingPrice: "2",
           measureMode: "EACH", variantActive: true, productStatus: "ACTIVE", productDeletedAt: null }],
        /* the threshold rule's own narrow projection, then the gate's location lookup */
        [],
        [],
      ],
    });
    const svc = serviceWith(harness, outOfScope().service);

    await expect(svc.createAdjustment(ORG, USER, body, "key-1")).rejects.toThrow(ForbiddenException);
    expect(harness.inserts).toHaveLength(0);
  });
});

describe("the detail gate follows its own aggregate", () => {
  it("uses the same EXISTS over lines and locations that the list uses", async () => {
    const listHarness = dbWith({});
    const listSvc = serviceWith(listHarness, outOfScope().service);
    await listSvc.listAdjustments(ScopedRead.of(ORG, USER, "all"), { page: 1, limit: 20 } as never);

    const detailHarness = dbWith({});
    const detailSvc = serviceWith(detailHarness, outOfScope().service);
    await expect(detailSvc.getAdjustment(ORG, 42, USER)).rejects.toThrow(NotFoundException);

    /*
      Whether a row attributed to NO warehouse is visible differs per table on
      purpose, so the rule that matters is that the detail and its aggregate
      agree -- not that either matches a house style. Comparing the EXISTS
      fragment is how that agreement is checked; placeholder numbers shift
      because the detail binds its id first.
    */
    const exists = (statement: SQL) => {
      const text = sqlText(statement).replace(/\$\d+/g, "$?").replace(/\s+/g, " ");
      const from = text.indexOf("EXISTS (");
      expect(from).toBeGreaterThanOrEqual(0);
      return text.slice(from);
    };

    expect(exists(lastRead(detailHarness))).toBe(exists(listHarness.wheres[0]!));
  });
});
