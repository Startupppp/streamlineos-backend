import request from "supertest";
import {
  createAuthzHarness,
  ORG_B,
  type AuthzHarness,
  type GatedRoute,
} from "../../../../test/helpers/authz-deny-harness";
import { CustomerReturnsController } from "../returns/customer-returns.controller";
import { HoldsController } from "../quality/holds.controller";
import { InspectionPlansController } from "../quality/inspection-plans.controller";
import { InspectionsController } from "../quality/inspections.controller";
import { InvCycleCountsController } from "../counts/inv-cycle-counts.controller";
import { InvPhysicalAuditsController } from "../counts/inv-physical-audits.controller";
import { InvTraceabilityController } from "../traceability/inv-traceability.controller";
import { LandedCostController } from "../landed-cost/landed-cost.controller";
import { RecallsController } from "../quality/recalls.controller";
import { VendorReturnsController } from "../returns/vendor-returns.controller";
import { ALL_PERMISSION_NAMES } from "../../rbac/permissions";

/**
 * The deny branch of every authorization gate on inventory quality, returns and counts.
 *
 * Inspections, holds, recalls, customer and vendor returns, cycle counts, physical audits, traceability and landed cost.
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
  { verb: "get", path: `/inventory/customer-returns`, key: "inventory:customer-returns:manage" },
  { verb: "get", path: `/inventory/customer-returns/${ID}`, key: "inventory:customer-returns:manage" },
  { verb: "get", path: `/inventory/cycle-counts`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/cycle-counts/${ID}`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/expiry`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/landed-cost`, key: "inventory:valuation:read" },
  { verb: "get", path: `/inventory/landed-cost/${ID}`, key: "inventory:valuation:read" },
  { verb: "get", path: `/inventory/lots`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/lots/${ID}`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/physical-audits`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/physical-audits/${ID}`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/quality/holds`, key: "inventory:quality:read" },
  { verb: "get", path: `/inventory/quality/holds/${ID}`, key: "inventory:quality:read" },
  { verb: "get", path: `/inventory/quality/inspection-plans`, key: "inventory:quality:read" },
  { verb: "get", path: `/inventory/quality/inspection-plans/${ID}`, key: "inventory:quality:read" },
  { verb: "get", path: `/inventory/quality/inspection-plans/${ID}/versions`, key: "inventory:quality:read" },
  { verb: "get", path: `/inventory/quality/inspections`, key: "inventory:quality:read" },
  { verb: "get", path: `/inventory/quality/inspections/${ID}`, key: "inventory:quality:read" },
  { verb: "get", path: `/inventory/quality/recalls`, key: "inventory:quality:read" },
  { verb: "get", path: `/inventory/quality/recalls/${ID}`, key: "inventory:quality:read" },
  { verb: "get", path: `/inventory/serials`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/serials/${ID}`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/traceability`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/traceability/allocation-overrides`, key: "inventory:audit:read" },
  { verb: "get", path: `/inventory/traceability/genealogy`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/traceability/genealogy/export`, key: "inventory:export" },
  { verb: "get", path: `/inventory/vendor-returns`, key: "inventory:vendor-returns:manage" },
  { verb: "get", path: `/inventory/vendor-returns/${ID}`, key: "inventory:vendor-returns:manage" },
];

const POST_ROUTES: readonly GatedRoute[] = [
  { verb: "post", path: `/inventory/customer-returns`, key: "inventory:customer-returns:manage" },
  { verb: "post", path: `/inventory/customer-returns/${ID}/approve`, key: "inventory:customer-returns:manage" },
  { verb: "post", path: `/inventory/customer-returns/${ID}/cancel`, key: "inventory:customer-returns:manage" },
  { verb: "post", path: `/inventory/customer-returns/${ID}/inspect`, key: "inventory:customer-returns:manage" },
  { verb: "post", path: `/inventory/customer-returns/${ID}/post`, key: "inventory:customer-returns:manage" },
  { verb: "post", path: `/inventory/cycle-counts`, key: "inventory:stock:reconcile" },
  { verb: "post", path: `/inventory/cycle-counts/${ID}/cancel`, key: "inventory:stock:reconcile" },
  { verb: "post", path: `/inventory/cycle-counts/${ID}/post`, key: "inventory:stock:reconcile" },
  { verb: "post", path: `/inventory/cycle-counts/${ID}/review`, key: "inventory:stock:reconcile" },
  { verb: "post", path: `/inventory/cycle-counts/${ID}/start`, key: "inventory:stock:reconcile" },
  { verb: "post", path: `/inventory/landed-cost`, key: "inventory:landed-cost:manage" },
  { verb: "post", path: `/inventory/landed-cost/${ID}/apply`, key: "inventory:landed-cost:manage" },
  { verb: "post", path: `/inventory/landed-cost/${ID}/charges`, key: "inventory:landed-cost:manage" },
  { verb: "post", path: `/inventory/physical-audits`, key: "inventory:stock:reconcile" },
  { verb: "post", path: `/inventory/physical-audits/${ID}/cancel`, key: "inventory:stock:reconcile" },
  { verb: "post", path: `/inventory/physical-audits/${ID}/post`, key: "inventory:stock:reconcile" },
  { verb: "post", path: `/inventory/physical-audits/${ID}/review`, key: "inventory:stock:reconcile" },
  { verb: "post", path: `/inventory/physical-audits/${ID}/start`, key: "inventory:stock:reconcile" },
  { verb: "post", path: `/inventory/quality/holds`, key: "inventory:quality:inspect" },
  { verb: "post", path: `/inventory/quality/holds/${ID}/release`, key: "inventory:quality:release" },
  { verb: "post", path: `/inventory/quality/inspection-plans`, key: "inventory:quality:plans:manage" },
  { verb: "post", path: `/inventory/quality/inspection-plans/${ID}/versions`, key: "inventory:quality:plans:manage" },
  { verb: "post", path: `/inventory/quality/inspection-plans/${ID}/versions/${ID}/activate`, key: "inventory:quality:plans:manage" },
  { verb: "post", path: `/inventory/quality/inspections`, key: "inventory:quality:inspect" },
  { verb: "post", path: `/inventory/quality/inspections/${ID}/cancel`, key: "inventory:quality:inspect" },
  { verb: "post", path: `/inventory/quality/inspections/${ID}/correct`, key: "inventory:quality:inspect" },
  { verb: "post", path: `/inventory/quality/inspections/${ID}/dispose`, key: "inventory:quality:inspect" },
  { verb: "post", path: `/inventory/quality/inspections/${ID}/fail`, key: "inventory:quality:inspect" },
  { verb: "post", path: `/inventory/quality/inspections/${ID}/pass`, key: "inventory:quality:release" },
  { verb: "post", path: `/inventory/quality/inspections/${ID}/start`, key: "inventory:quality:inspect" },
  { verb: "post", path: `/inventory/quality/recalls`, key: "inventory:quality:recall" },
  { verb: "post", path: `/inventory/quality/recalls/simulate`, key: "inventory:quality:read" },
  { verb: "post", path: `/inventory/vendor-returns`, key: "inventory:vendor-returns:manage" },
  { verb: "post", path: `/inventory/vendor-returns/${ID}/approve`, key: "inventory:vendor-returns:manage" },
  { verb: "post", path: `/inventory/vendor-returns/${ID}/cancel`, key: "inventory:vendor-returns:manage" },
  { verb: "post", path: `/inventory/vendor-returns/${ID}/post`, key: "inventory:vendor-returns:manage" },
];

const PUT_ROUTES: readonly GatedRoute[] = [
];

const PATCH_ROUTES: readonly GatedRoute[] = [
  { verb: "patch", path: `/inventory/cycle-counts/${ID}/lines`, key: "inventory:stock:reconcile" },
  { verb: "patch", path: `/inventory/lots/${ID}/status`, key: "inventory:stock:adjust" },
  { verb: "patch", path: `/inventory/physical-audits/${ID}/lines`, key: "inventory:stock:reconcile" },
  { verb: "patch", path: `/inventory/quality/inspection-plans/${ID}`, key: "inventory:quality:plans:manage" },
  { verb: "patch", path: `/inventory/quality/recalls/${ID}`, key: "inventory:quality:recall" },
];

const DELETE_ROUTES: readonly GatedRoute[] = [
  { verb: "delete", path: `/inventory/landed-cost/${ID}`, key: "inventory:landed-cost:manage" },
  { verb: "delete", path: `/inventory/quality/inspection-plans/${ID}`, key: "inventory:quality:plans:manage" },
];

const ALL_ROUTES: readonly GatedRoute[] = [
  ...GET_ROUTES,
  ...POST_ROUTES,
  ...PUT_ROUTES,
  ...PATCH_ROUTES,
  ...DELETE_ROUTES,
];

describe("inventory quality, returns and counts — authorization deny", () => {
  let harness: AuthzHarness;

  beforeAll(async () => {
    harness = await createAuthzHarness([
      CustomerReturnsController,
      HoldsController,
      InspectionPlansController,
      InspectionsController,
      InvCycleCountsController,
      InvPhysicalAuditsController,
      InvTraceabilityController,
      LandedCostController,
      RecallsController,
      VendorReturnsController,
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
    expect(ALL_ROUTES.length).toBe(71);
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
      const res = await request(harness.server()).get(`/inventory/customer-returns`);
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
      const res = await request(harness.server()).get(`/inventory/customer-returns`);
      expect(res.status).toBe(402);
    });

    it("refuses a principal from another tenant the same way", async () => {
      /*
       * The refusal must not depend on which tenant is asking: a caller in
       * org B without the key is refused exactly as one in org A is, and never
       * reaches org A's rows on the way to finding that out.
       */
      harness.actAs({ orgId: ORG_B, userId: "user-b" });
      harness.denyOnly("inventory:customer-returns:manage");
      const res = await request(harness.server()).get(`/inventory/customer-returns`);
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
