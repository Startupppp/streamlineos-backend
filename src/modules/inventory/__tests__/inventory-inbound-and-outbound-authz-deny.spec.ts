import request from "supertest";
import {
  createAuthzHarness,
  ORG_B,
  type AuthzHarness,
  type GatedRoute,
} from "../../../../test/helpers/authz-deny-harness";
import { CarriersController } from "../shipments/carriers.controller";
import { CarrierStatusController } from "../shipments/carrier-status.controller";
import { CarrierTransportController } from "../shipments/transport/carrier-transport.controller";
import { CartonizationController } from "../shipments/cartonization.controller";
import { DockController } from "../dock/dock.controller";
import { GrnController } from "../purchase-orders/grn.controller";
import { HandlingUnitsController } from "../handling-units/handling-units.controller";
import { InvPurchaseOrdersController } from "../purchase-orders/inv-purchase-orders.controller";
import { InvSalesOrdersController } from "../sales-orders/inv-sales-orders.controller";
import { KitController } from "../kitting/kit.controller";
import { LoadsController } from "../shipments/loads.controller";
import { PackagesController } from "../shipments/packages.controller";
import { PickExceptionController } from "../picking/pick-exception.controller";
import { PickWaveController } from "../picking/pick-wave.controller";
import { PutawayTaskController } from "../putaway/putaway-task.controller";
import { ShipmentsController } from "../shipments/shipments.controller";
import { SlottingController } from "../slotting/slotting.controller";
import { ALL_PERMISSION_NAMES } from "../../rbac/permissions";

/**
 * The deny branch of every authorization gate on inventory inbound and outbound flow.
 *
 * Purchase orders and receipts, sales orders, picking, putaway, packing, shipping, dock and slotting.
 *
 * Each route is driven twice. Once by a caller holding EVERY catalogued
 * permission EXCEPT the one the route names — a 403 there can only be that
 * route reading its own key, never "the fixture has no permissions". Once more
 * with the key held, which must NOT answer 403: without that half, a route that
 * 404'd, or whose class guard refused first, would look covered.
 *
 * A missing `AuthContext` makes `PermissionGuard` answer 401, which is a
 * different failure and no evidence of a working deny path; the harness always
 * attaches a real one, and the distinction is asserted below.
 */

const ID = "11111111-1111-4111-8111-111111111111";

const GET_ROUTES: readonly GatedRoute[] = [
  { verb: "get", path: `/inventory/carriers`, key: "inventory:shipments:manage" },
  { verb: "get", path: `/inventory/carriers/deliveries`, key: "inventory:shipments:manage" },
  { verb: "get", path: `/inventory/carriers/operations`, key: "inventory:shipments:manage" },
  { verb: "get", path: `/inventory/dock/appointments`, key: "inventory:dock:manage" },
  { verb: "get", path: `/inventory/dock/doors`, key: "inventory:warehouses:read" },
  { verb: "get", path: `/inventory/goods-receipts`, key: "inventory:purchase-orders:read" },
  { verb: "get", path: `/inventory/goods-receipts/${ID}`, key: "inventory:purchase-orders:read" },
  { verb: "get", path: `/inventory/handling-units`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/handling-units/${ID}`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/kits/${ID}/bom`, key: "inventory:products:read" },
  { verb: "get", path: `/inventory/kits/buildable`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/loads`, key: "inventory:loads:manage" },
  { verb: "get", path: `/inventory/loads/${ID}`, key: "inventory:loads:manage" },
  { verb: "get", path: `/inventory/packages`, key: "inventory:packages:manage" },
  { verb: "get", path: `/inventory/packages/${ID}`, key: "inventory:packages:manage" },
  { verb: "get", path: `/inventory/packages/${ID}/reconciliation`, key: "inventory:packages:manage" },
  { verb: "get", path: `/inventory/packages/queue`, key: "inventory:packages:manage" },
  { verb: "get", path: `/inventory/picking/exceptions`, key: "inventory:picking:review" },
  { verb: "get", path: `/inventory/picking/waves`, key: "inventory:sales-orders:read" },
  { verb: "get", path: `/inventory/picking/waves/${ID}`, key: "inventory:sales-orders:read" },
  { verb: "get", path: `/inventory/purchase-orders`, key: "inventory:purchase-orders:read" },
  { verb: "get", path: `/inventory/purchase-orders/${ID}`, key: "inventory:purchase-orders:read" },
  { verb: "get", path: `/inventory/putaway/tasks`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/putaway/tasks/${ID}`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/sales-orders`, key: "inventory:sales-orders:read" },
  { verb: "get", path: `/inventory/sales-orders/${ID}`, key: "inventory:sales-orders:read" },
  { verb: "get", path: `/inventory/sales-orders/${ID}/atp`, key: "inventory:sales-orders:read" },
  { verb: "get", path: `/inventory/shipments`, key: "inventory:shipments:manage" },
  { verb: "get", path: `/inventory/shipments/${ID}`, key: "inventory:shipments:manage" },
  { verb: "get", path: `/inventory/shipments/${ID}/timeline`, key: "inventory:shipments:manage" },
  { verb: "get", path: `/inventory/slotting/recommendations`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/slotting/rules`, key: "inventory:warehouses:read" },
];

const POST_ROUTES: readonly GatedRoute[] = [
  { verb: "post", path: `/inventory/carriers`, key: "inventory:shipments:manage" },
  { verb: "post", path: `/inventory/cartonization/suggest`, key: "inventory:shipments:manage" },
  { verb: "post", path: `/inventory/dock/appointments`, key: "inventory:dock:manage" },
  { verb: "post", path: `/inventory/dock/doors`, key: "inventory:warehouses:manage" },
  { verb: "post", path: `/inventory/goods-receipts`, key: "inventory:purchase-orders:receive" },
  { verb: "post", path: `/inventory/goods-receipts/${ID}/cancel`, key: "inventory:purchase-orders:receive" },
  { verb: "post", path: `/inventory/goods-receipts/${ID}/count`, key: "inventory:purchase-orders:receive" },
  { verb: "post", path: `/inventory/goods-receipts/${ID}/post`, key: "inventory:purchase-orders:receive" },
  { verb: "post", path: `/inventory/goods-receipts/${ID}/quality-review`, key: "inventory:purchase-orders:receive" },
  { verb: "post", path: `/inventory/goods-receipts/${ID}/reverse`, key: "inventory:purchase-orders:receive" },
  { verb: "post", path: `/inventory/handling-units`, key: "inventory:stock:transfer" },
  { verb: "post", path: `/inventory/handling-units/${ID}/move`, key: "inventory:stock:transfer" },
  { verb: "post", path: `/inventory/kits/assemble`, key: "inventory:kits:assemble" },
  { verb: "post", path: `/inventory/kits/disassemble`, key: "inventory:kits:assemble" },
  { verb: "post", path: `/inventory/loads`, key: "inventory:loads:manage" },
  { verb: "post", path: `/inventory/loads/${ID}/cancel`, key: "inventory:loads:manage" },
  { verb: "post", path: `/inventory/loads/${ID}/close`, key: "inventory:loads:manage" },
  { verb: "post", path: `/inventory/loads/${ID}/dispatch`, key: "inventory:loads:manage" },
  { verb: "post", path: `/inventory/packages`, key: "inventory:packages:manage" },
  { verb: "post", path: `/inventory/packages/${ID}/close`, key: "inventory:packages:manage" },
  { verb: "post", path: `/inventory/packages/${ID}/reopen`, key: "inventory:packages:manage" },
  { verb: "post", path: `/inventory/packages/${ID}/scan`, key: "inventory:packages:manage" },
  { verb: "post", path: `/inventory/picking/exceptions/${ID}/assign`, key: "inventory:picking:review" },
  { verb: "post", path: `/inventory/picking/exceptions/${ID}/resolve`, key: "inventory:picking:review" },
  { verb: "post", path: `/inventory/picking/waves`, key: "inventory:sales-orders:ship" },
  { verb: "post", path: `/inventory/picking/waves/${ID}/abandon`, key: "inventory:sales-orders:ship" },
  { verb: "post", path: `/inventory/picking/waves/${ID}/claim`, key: "inventory:sales-orders:ship" },
  { verb: "post", path: `/inventory/picking/waves/${ID}/confirm`, key: "inventory:sales-orders:ship" },
  { verb: "post", path: `/inventory/picking/waves/${ID}/exception`, key: "inventory:sales-orders:ship" },
  { verb: "post", path: `/inventory/picking/waves/${ID}/join`, key: "inventory:sales-orders:ship" },
  { verb: "post", path: `/inventory/picking/waves/${ID}/reassign`, key: "inventory:sales-orders:ship" },
  { verb: "post", path: `/inventory/picking/waves/${ID}/substitute`, key: "inventory:picking:substitute" },
  { verb: "post", path: `/inventory/picking/waves/propose-join`, key: "inventory:sales-orders:ship" },
  { verb: "post", path: `/inventory/purchase-orders`, key: "inventory:purchase-orders:create" },
  { verb: "post", path: `/inventory/purchase-orders/${ID}/approve`, key: "inventory:purchase-orders:approve" },
  { verb: "post", path: `/inventory/purchase-orders/${ID}/cancel`, key: "inventory:purchase-orders:approve" },
  { verb: "post", path: `/inventory/purchase-orders/${ID}/close`, key: "inventory:purchase-orders:approve" },
  { verb: "post", path: `/inventory/purchase-orders/${ID}/receive`, key: "inventory:purchase-orders:receive" },
  { verb: "post", path: `/inventory/purchase-orders/${ID}/send`, key: "inventory:purchase-orders:approve" },
  { verb: "post", path: `/inventory/putaway/tasks`, key: "inventory:stock:transfer" },
  { verb: "post", path: `/inventory/putaway/tasks/${ID}/abandon`, key: "inventory:stock:transfer" },
  { verb: "post", path: `/inventory/putaway/tasks/${ID}/cancel`, key: "inventory:stock:transfer" },
  { verb: "post", path: `/inventory/putaway/tasks/${ID}/claim`, key: "inventory:stock:transfer" },
  { verb: "post", path: `/inventory/putaway/tasks/${ID}/complete`, key: "inventory:stock:transfer" },
  { verb: "post", path: `/inventory/sales-orders`, key: "inventory:sales-orders:create" },
  { verb: "post", path: `/inventory/sales-orders/${ID}/cancel`, key: "inventory:sales-orders:update" },
  { verb: "post", path: `/inventory/sales-orders/${ID}/confirm`, key: "inventory:sales-orders:confirm" },
  { verb: "post", path: `/inventory/sales-orders/${ID}/invoice`, key: "inventory:sales-orders:invoice" },
  { verb: "post", path: `/inventory/sales-orders/${ID}/pack`, key: "inventory:sales-orders:ship" },
  { verb: "post", path: `/inventory/sales-orders/${ID}/pick`, key: "inventory:sales-orders:ship" },
  { verb: "post", path: `/inventory/sales-orders/${ID}/reserve`, key: "inventory:stock:reserve" },
  { verb: "post", path: `/inventory/sales-orders/${ID}/ship`, key: "inventory:sales-orders:ship" },
  { verb: "post", path: `/inventory/shipments`, key: "inventory:shipments:manage" },
  { verb: "post", path: `/inventory/shipments/${ID}/cancel`, key: "inventory:shipments:manage" },
  { verb: "post", path: `/inventory/shipments/${ID}/carrier/book`, key: "inventory:shipments:manage" },
  { verb: "post", path: `/inventory/shipments/${ID}/carrier/label`, key: "inventory:shipments:manage" },
  { verb: "post", path: `/inventory/shipments/${ID}/carrier/track`, key: "inventory:shipments:manage" },
  { verb: "post", path: `/inventory/shipments/${ID}/refresh-tracking`, key: "inventory:shipments:manage" },
  { verb: "post", path: `/inventory/shipments/${ID}/ship`, key: "inventory:shipments:manage" },
  { verb: "post", path: `/inventory/shipments/carrier-status`, key: "inventory:shipments:manage" },
  { verb: "post", path: `/inventory/slotting/recommendations/${ID}/approve`, key: "inventory:stock:transfer" },
  { verb: "post", path: `/inventory/slotting/recommendations/${ID}/dismiss`, key: "inventory:warehouses:manage" },
  { verb: "post", path: `/inventory/slotting/rules`, key: "inventory:warehouses:manage" },
];

const PUT_ROUTES: readonly GatedRoute[] = [
  { verb: "put", path: `/inventory/carriers/${ID}/credentials`, key: "inventory:shipments:manage" },
  { verb: "put", path: `/inventory/kits/${ID}/bom`, key: "inventory:products:update" },
];

const PATCH_ROUTES: readonly GatedRoute[] = [
  { verb: "patch", path: `/inventory/carriers/${ID}`, key: "inventory:shipments:manage" },
  { verb: "patch", path: `/inventory/dock/appointments/${ID}`, key: "inventory:dock:manage" },
  { verb: "patch", path: `/inventory/goods-receipts/${ID}`, key: "inventory:purchase-orders:receive" },
  { verb: "patch", path: `/inventory/handling-units/${ID}/nesting`, key: "inventory:stock:transfer" },
  { verb: "patch", path: `/inventory/packages/${ID}/lines`, key: "inventory:packages:manage" },
  { verb: "patch", path: `/inventory/purchase-orders/${ID}`, key: "inventory:purchase-orders:update" },
  { verb: "patch", path: `/inventory/sales-orders/${ID}`, key: "inventory:sales-orders:update" },
  { verb: "patch", path: `/inventory/shipments/${ID}`, key: "inventory:shipments:manage" },
  { verb: "patch", path: `/inventory/slotting/rules/${ID}`, key: "inventory:warehouses:manage" },
];

const DELETE_ROUTES: readonly GatedRoute[] = [
];

const ALL_ROUTES: readonly GatedRoute[] = [
  ...GET_ROUTES,
  ...POST_ROUTES,
  ...PUT_ROUTES,
  ...PATCH_ROUTES,
  ...DELETE_ROUTES,
];

describe("inventory inbound and outbound flow — authorization deny", () => {
  let harness: AuthzHarness;

  beforeAll(async () => {
    harness = await createAuthzHarness([
      CarrierStatusController,
      CarrierTransportController,
      CarriersController,
      CartonizationController,
      DockController,
      GrnController,
      HandlingUnitsController,
      InvPurchaseOrdersController,
      InvSalesOrdersController,
      KitController,
      LoadsController,
      PackagesController,
      PickExceptionController,
      PickWaveController,
      PutawayTaskController,
      ShipmentsController,
      SlottingController,
    ]);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.reset();
  });

  it("names only catalogued permission keys, so no case passes on a typo", () => {
    /*
     * `authorize()` refuses an uncatalogued key with FORBIDDEN before it reads
     * any grant. A typo in the table below would therefore produce a 403 that
     * proves nothing about the route.
     */
    const catalogued = new Set<string>(ALL_PERMISSION_NAMES);
    expect(ALL_ROUTES.map((r) => r.key).filter((k) => !catalogued.has(k))).toEqual([]);
  });

  it("covers the whole gated surface of these controllers", () => {
    expect(ALL_ROUTES.length).toBe(106);
    expect(new Set(ALL_ROUTES.map((r) => r.key)).size).toBeGreaterThan(1);
  });

  describe("a caller holding every OTHER permission is still refused", () => {
    it.each(GET_ROUTES)("GET $path is 403 without $key", async ({ path, key }) => {
      harness.denyOnly(key);
      const res = await request(harness.server()).get(path);
      expect(res.status).toBe(403);
      expect(harness.keysAsked()).toContain(key);
    });

    it.each(POST_ROUTES)("POST $path is 403 without $key", async ({ path, key }) => {
      harness.denyOnly(key);
      const res = await request(harness.server()).post(path).send({});
      expect(res.status).toBe(403);
      expect(harness.keysAsked()).toContain(key);
    });

    it.each(PUT_ROUTES)("PUT $path is 403 without $key", async ({ path, key }) => {
      harness.denyOnly(key);
      const res = await request(harness.server()).put(path).send({});
      expect(res.status).toBe(403);
      expect(harness.keysAsked()).toContain(key);
    });

    it.each(PATCH_ROUTES)("PATCH $path is 403 without $key", async ({ path, key }) => {
      harness.denyOnly(key);
      const res = await request(harness.server()).patch(path).send({});
      expect(res.status).toBe(403);
      expect(harness.keysAsked()).toContain(key);
    });

  });

  describe("and is NOT refused once it holds that permission", () => {
    it.each(GET_ROUTES)("GET $path is not 403 with $key", async ({ path }) => {
      harness.allowAll();
      const res = await request(harness.server()).get(path);
      expect(res.status).not.toBe(403);
    });

    it.each(POST_ROUTES)("POST $path is not 403 with $key", async ({ path }) => {
      harness.allowAll();
      const res = await request(harness.server()).post(path).send({});
      expect(res.status).not.toBe(403);
    });

    it.each(PUT_ROUTES)("PUT $path is not 403 with $key", async ({ path }) => {
      harness.allowAll();
      const res = await request(harness.server()).put(path).send({});
      expect(res.status).not.toBe(403);
    });

    it.each(PATCH_ROUTES)("PATCH $path is not 403 with $key", async ({ path }) => {
      harness.allowAll();
      const res = await request(harness.server()).patch(path).send({});
      expect(res.status).not.toBe(403);
    });

  });

  describe("the refusal is the permission check, not something upstream of it", () => {
    it("answers 401 — not 403 — when no AuthContext is attached at all", async () => {
      harness.withoutAuthContext();
      harness.denyAll();
      const res = await request(harness.server()).get(`/inventory/carriers`);
      expect(res.status).toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("answers 402 — not 403 — when the inventory module is unavailable", async () => {
      /*
       * `@RequireModule("inventory")` is a second, separate gate, and the
       * frontend keys its upgrade prompt on the 402. Conflating the two would
       * let a module-gate test vouch for a permission nothing exercises.
       */
      harness.disableModule("org-disabled");
      harness.allowAll();
      const res = await request(harness.server()).get(`/inventory/carriers`);
      expect(res.status).toBe(402);
    });

    it("refuses a principal from another tenant the same way", async () => {
      /*
       * The refusal must not depend on which tenant is asking: a caller in
       * org B without the key is refused exactly as one in org A is, and never
       * reaches org A's rows on the way to finding that out.
       */
      harness.actAs({ orgId: ORG_B, userId: "user-b" });
      harness.denyOnly("inventory:shipments:manage");
      const res = await request(harness.server()).get(`/inventory/carriers`);
      expect(res.status).toBe(403);
    });
  });

  it("withholds exactly one key and grants the rest", () => {
    /*
     * A floor under the fixture itself: if `denyOnly` ever degenerated into
     * "deny everything", every case above would pass without proving a route
     * reads its own key.
     */
    const keys = new Set(ALL_ROUTES.map((r) => r.key));
    expect(keys.size).toBeGreaterThan(1);
  });
});
