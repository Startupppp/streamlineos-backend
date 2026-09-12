import request from "supertest";
import {
  createAuthzHarness,
  ORG_B,
  type AuthzHarness,
  type GatedRoute,
} from "../../../../test/helpers/authz-deny-harness";
import { InvBarcodeController } from "../barcode/inv-barcode.controller";
import { InvGlReconController } from "../reconciliation/gl/inv-gl-recon.controller";
import { InvLabelsController } from "../labels/inv-labels.controller";
import { InvOpsController } from "../ops/inv-ops.controller";
import { InvProductsController } from "../products/inv-products.controller";
import { InvProjectsController } from "../projects/inv-projects.controller";
import { InvReconciliationController } from "../reconciliation/inv-reconciliation.controller";
import { InvSettingsController } from "../settings/settings.controller";
import { InvStockAdjustmentsController } from "../stock/inv-stock-adjustments.controller";
import { InvStockController } from "../stock/inv-stock.controller";
import { InvStockTransfersController } from "../stock/inv-stock-transfers.controller";
import { InvValuationController } from "../valuation/inv-valuation.controller";
import { InvVendorsController } from "../vendors/inv-vendors.controller";
import { InvWarehousesController } from "../warehouses/inv-warehouses.controller";
import { LaborController } from "../labor/labor.controller";
import { OwnershipController } from "../stock-types/stock-types.controller";
import { TransitExitController } from "../stock/transit-exit.controller";
import { ALL_PERMISSION_NAMES } from "../../rbac/permissions";

/**
 * The deny branch of every authorization gate on inventory catalog and stock.
 *
 * Products, warehouses, stock levels and transfers, vendors, valuation, settings and the operational read surfaces around them.
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
  { verb: "get", path: `/inventory/barcode/lookup`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/labels/goods-receipts/${ID}/pdf`, key: "inventory:labels:print" },
  { verb: "get", path: `/inventory/labels/pick-lists/${ID}/pdf`, key: "inventory:labels:print" },
  { verb: "get", path: `/inventory/labels/variants/${ID}`, key: "inventory:labels:print" },
  { verb: "get", path: `/inventory/labor/board`, key: "inventory:labor:read" },
  { verb: "get", path: `/inventory/labor/records`, key: "inventory:labor:read" },
  { verb: "get", path: `/inventory/ops/attention`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/ops/summary`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/ops/zones`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/ownership/consigned`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/products`, key: "inventory:products:read" },
  { verb: "get", path: `/inventory/products/${ID}`, key: "inventory:products:read" },
  { verb: "get", path: `/inventory/products/categories`, key: "inventory:products:read" },
  { verb: "get", path: `/inventory/products/pharmacy/h1-register`, key: "inventory:products:read" },
  { verb: "get", path: `/inventory/products/uom`, key: "inventory:products:read" },
  { verb: "get", path: `/inventory/products/variants`, key: "inventory:products:read" },
  { verb: "get", path: `/inventory/products/variants/${ID}/pharmacy`, key: "inventory:products:read" },
  { verb: "get", path: `/inventory/products/variants/${ID}/quantity-capture`, key: "inventory:products:read" },
  { verb: "get", path: `/inventory/products/variants/${ID}/receipt-requirements`, key: "inventory:products:read" },
  { verb: "get", path: `/inventory/products/variants/${ID}/tax-treatment`, key: "inventory:products:read" },
  { verb: "get", path: `/inventory/projects`, key: "inventory:projects:read" },
  { verb: "get", path: `/inventory/projects/${ID}`, key: "inventory:projects:read" },
  { verb: "get", path: `/inventory/projects/at-risk`, key: "inventory:projects:read" },
  { verb: "get", path: `/inventory/reconciliation/gl`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/reconciliation/gl/periods`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/settings`, key: "inventory:settings:manage" },
  { verb: "get", path: `/inventory/settings/health`, key: "inventory:settings:manage" },
  { verb: "get", path: `/inventory/settings/number-sequences`, key: "inventory:settings:manage" },
  { verb: "get", path: `/inventory/settings/packs`, key: "inventory:products:read" },
  { verb: "get", path: `/inventory/settings/shelf-life-rules`, key: "inventory:settings:manage" },
  { verb: "get", path: `/inventory/stock`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/stock/adjustments`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/stock/adjustments/${ID}`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/stock/availability`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/stock/reconciliation`, key: "inventory:stock:reconcile" },
  { verb: "get", path: `/inventory/stock/reservations`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/stock/transactions`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/stock/transfers`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/stock/transfers/${ID}`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/stock/transit/stranded`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/valuation`, key: "inventory:valuation:read" },
  { verb: "get", path: `/inventory/valuation/consumptions`, key: "inventory:valuation:read" },
  { verb: "get", path: `/inventory/valuation/layers`, key: "inventory:valuation:read" },
  { verb: "get", path: `/inventory/valuation/periods`, key: "inventory:valuation:read" },
  { verb: "get", path: `/inventory/vendors`, key: "inventory:vendors:read" },
  { verb: "get", path: `/inventory/vendors/${ID}`, key: "inventory:vendors:read" },
  { verb: "get", path: `/inventory/vendors/${ID}/deliveries`, key: "inventory:vendors:read" },
  { verb: "get", path: `/inventory/vendors/${ID}/performance`, key: "inventory:vendors:read" },
  { verb: "get", path: `/inventory/warehouses`, key: "inventory:warehouses:read" },
  { verb: "get", path: `/inventory/warehouses/${ID}`, key: "inventory:warehouses:read" },
  { verb: "get", path: `/inventory/warehouses/${ID}/assignable-users`, key: "inventory:warehouses:manage" },
  { verb: "get", path: `/inventory/warehouses/${ID}/locations`, key: "inventory:warehouses:read" },
  { verb: "get", path: `/inventory/warehouses/${ID}/stock`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/warehouses/${ID}/users`, key: "inventory:warehouses:manage" },
  { verb: "get", path: `/inventory/warehouses/putaway/suggestions`, key: "inventory:stock:read" },
];

const POST_ROUTES: readonly GatedRoute[] = [
  { verb: "post", path: `/inventory/barcode/scan`, key: "inventory:stock:read" },
  { verb: "post", path: `/inventory/barcode/scan/capture`, key: "inventory:stock:read" },
  { verb: "post", path: `/inventory/ownership/convert`, key: "inventory:stock:adjust" },
  { verb: "post", path: `/inventory/products`, key: "inventory:products:create" },
  { verb: "post", path: `/inventory/products/${ID}/archive`, key: "inventory:products:update" },
  { verb: "post", path: `/inventory/products/${ID}/restore`, key: "inventory:products:update" },
  { verb: "post", path: `/inventory/products/${ID}/variants`, key: "inventory:products:update" },
  { verb: "post", path: `/inventory/products/categories`, key: "inventory:products:create" },
  { verb: "post", path: `/inventory/products/uom`, key: "inventory:products:create" },
  { verb: "post", path: `/inventory/projects`, key: "inventory:projects:manage" },
  { verb: "post", path: `/inventory/projects/${ID}/requirements`, key: "inventory:projects:manage" },
  { verb: "post", path: `/inventory/projects/${ID}/requirements/${ID}/release`, key: "inventory:stock:reserve" },
  { verb: "post", path: `/inventory/projects/${ID}/requirements/${ID}/reserve`, key: "inventory:stock:reserve" },
  { verb: "post", path: `/inventory/settings/maintenance/expire-reservations`, key: "inventory:settings:manage" },
  { verb: "post", path: `/inventory/stock/adjustments`, key: "inventory:stock:adjust" },
  { verb: "post", path: `/inventory/stock/adjustments/${ID}/approve`, key: "inventory:adjustments:approve" },
  { verb: "post", path: `/inventory/stock/adjustments/${ID}/cancel`, key: "inventory:stock:adjust" },
  { verb: "post", path: `/inventory/stock/adjustments/${ID}/post`, key: "inventory:adjustments:post" },
  { verb: "post", path: `/inventory/stock/opening`, key: "inventory:stock:adjust" },
  { verb: "post", path: `/inventory/stock/reconciliation/repair`, key: "inventory:stock:reconcile" },
  { verb: "post", path: `/inventory/stock/release-reservation`, key: "inventory:stock:reserve" },
  { verb: "post", path: `/inventory/stock/reserve`, key: "inventory:stock:reserve" },
  { verb: "post", path: `/inventory/stock/transfers`, key: "inventory:stock:transfer" },
  { verb: "post", path: `/inventory/stock/transfers/${ID}/cancel`, key: "inventory:stock:transfer" },
  { verb: "post", path: `/inventory/stock/transfers/${ID}/complete`, key: "inventory:stock:transfer" },
  { verb: "post", path: `/inventory/stock/transfers/${ID}/dispatch`, key: "inventory:stock:transfer" },
  { verb: "post", path: `/inventory/stock/transfers/${ID}/reserve`, key: "inventory:stock:transfer" },
  { verb: "post", path: `/inventory/stock/transit/exit`, key: "inventory:transit:abandon" },
  { verb: "post", path: `/inventory/vendors`, key: "inventory:vendors:manage" },
  { verb: "post", path: `/inventory/warehouses`, key: "inventory:warehouses:manage" },
  { verb: "post", path: `/inventory/warehouses/${ID}/locations`, key: "inventory:warehouses:manage" },
  { verb: "post", path: `/inventory/warehouses/${ID}/users`, key: "inventory:warehouses:manage" },
];

const PUT_ROUTES: readonly GatedRoute[] = [
  { verb: "put", path: `/inventory/settings/shelf-life-rules`, key: "inventory:settings:manage" },
];

const PATCH_ROUTES: readonly GatedRoute[] = [
  { verb: "patch", path: `/inventory/products/${ID}`, key: "inventory:products:update" },
  { verb: "patch", path: `/inventory/products/${ID}/variants/${ID}`, key: "inventory:products:update" },
  { verb: "patch", path: `/inventory/products/categories/${ID}`, key: "inventory:products:update" },
  { verb: "patch", path: `/inventory/products/uom/${ID}`, key: "inventory:products:update" },
  { verb: "patch", path: `/inventory/projects/${ID}`, key: "inventory:projects:manage" },
  { verb: "patch", path: `/inventory/projects/${ID}/requirements/${ID}`, key: "inventory:projects:manage" },
  { verb: "patch", path: `/inventory/settings`, key: "inventory:settings:manage" },
  { verb: "patch", path: `/inventory/settings/number-sequences/${ID}`, key: "inventory:settings:manage" },
  { verb: "patch", path: `/inventory/vendors/${ID}`, key: "inventory:vendors:manage" },
  { verb: "patch", path: `/inventory/warehouses/${ID}`, key: "inventory:warehouses:manage" },
  { verb: "patch", path: `/inventory/warehouses/${ID}/locations/${ID}`, key: "inventory:warehouses:manage" },
];

const DELETE_ROUTES: readonly GatedRoute[] = [
  { verb: "delete", path: `/inventory/projects/${ID}`, key: "inventory:projects:manage" },
  { verb: "delete", path: `/inventory/warehouses/${ID}/users/${ID}`, key: "inventory:warehouses:manage" },
];

const ALL_ROUTES: readonly GatedRoute[] = [
  ...GET_ROUTES,
  ...POST_ROUTES,
  ...PUT_ROUTES,
  ...PATCH_ROUTES,
  ...DELETE_ROUTES,
];

describe("inventory catalog and stock — authorization deny", () => {
  let harness: AuthzHarness;

  beforeAll(async () => {
    harness = await createAuthzHarness([
      InvBarcodeController,
      InvGlReconController,
      InvLabelsController,
      InvOpsController,
      InvProductsController,
      InvProjectsController,
      InvReconciliationController,
      InvSettingsController,
      InvStockAdjustmentsController,
      InvStockController,
      InvStockTransfersController,
      InvValuationController,
      InvVendorsController,
      InvWarehousesController,
      LaborController,
      OwnershipController,
      TransitExitController,
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
    expect(ALL_ROUTES.length).toBe(101);
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

    it.each(DELETE_ROUTES)("DELETE $path is 403 without $key", async ({ path, key }) => {
      harness.denyOnly(key);
      const res = await request(harness.server()).delete(path);
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

    it.each(DELETE_ROUTES)("DELETE $path is not 403 with $key", async ({ path }) => {
      harness.allowAll();
      const res = await request(harness.server()).delete(path);
      expect(res.status).not.toBe(403);
    });

  });

  describe("the refusal is the permission check, not something upstream of it", () => {
    it("answers 401 — not 403 — when no AuthContext is attached at all", async () => {
      harness.withoutAuthContext();
      harness.denyAll();
      const res = await request(harness.server()).get(`/inventory/barcode/lookup`);
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
      const res = await request(harness.server()).get(`/inventory/barcode/lookup`);
      expect(res.status).toBe(402);
    });

    it("refuses a principal from another tenant the same way", async () => {
      /*
       * The refusal must not depend on which tenant is asking: a caller in
       * org B without the key is refused exactly as one in org A is, and never
       * reaches org A's rows on the way to finding that out.
       */
      harness.actAs({ orgId: ORG_B, userId: "user-b" });
      harness.denyOnly("inventory:stock:read");
      const res = await request(harness.server()).get(`/inventory/barcode/lookup`);
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
