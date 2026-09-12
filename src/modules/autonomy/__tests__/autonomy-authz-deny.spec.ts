import request from "supertest";
import {
  createAuthzHarness,
  ORG_B,
  type AuthzHarness,
  type GatedRoute,
} from "../../../../test/helpers/authz-deny-harness";
import { AutonomyReviewController } from "../autonomy-review.controller";
import { ColdOutboundAdminController } from "../cold-outbound-admin.controller";
import { NurtureSequencesController } from "../sequences/nurture-sequences.controller";
import { OutboundController } from "../outbound.controller";
import { ALL_PERMISSION_NAMES } from "../../rbac/permissions";

/**
 * The deny branch of every authorization gate on the autonomy HTTP surface that
 * this branch left without one.
 *
 * Each route is driven twice. Once by a caller holding EVERY catalogued
 * permission EXCEPT the one the route names, so a 403 can only be that route
 * reading its own key — not a fixture that holds nothing. Once more with the
 * key held, which must NOT answer 403: without that half a route that 404'd,
 * or whose class guard refused first, would look covered.
 *
 * `PermissionGuard` answers 401 when no `AuthContext` is attached, which is a
 * different failure and no evidence of a deny path; the two are pinned apart
 * below rather than left to the reader.
 */

const ID = "11111111-1111-4111-8111-111111111111";

const GET_ROUTES: readonly GatedRoute[] = [
  { verb: "get", path: `/crm/autonomy/class-stops`, key: "crm:autonomy:view" },
  { verb: "get", path: `/crm/autonomy/cold-outbound`, key: "crm:autonomy:manage" },
  { verb: "get", path: `/crm/autonomy/decisions`, key: "crm:autonomy:view" },
  { verb: "get", path: `/crm/autonomy/decisions/${ID}`, key: "crm:autonomy:view" },
  { verb: "get", path: `/crm/autonomy/holds`, key: "crm:autonomy:view" },
  { verb: "get", path: `/crm/autonomy/nurture/sequences`, key: "crm:autonomy:view" },
  { verb: "get", path: `/crm/autonomy/nurture/sequences/${ID}`, key: "crm:autonomy:view" },
  { verb: "get", path: `/crm/autonomy/nurture/sequences/${ID}/enrollments`, key: "crm:autonomy:view" },
  { verb: "get", path: `/crm/autonomy/repair-measure`, key: "crm:autonomy:view" },
  { verb: "get", path: `/crm/autonomy/repair-policies`, key: "crm:autonomy:view" },
  { verb: "get", path: `/crm/autonomy/repairs`, key: "crm:autonomy:view" },
  { verb: "get", path: `/crm/autonomy/review-queue`, key: "crm:autonomy:view" },
  { verb: "get", path: `/crm/autonomy/scoreboard`, key: "crm:autonomy:view" },
  { verb: "get", path: `/crm/autonomy/settings`, key: "crm:autonomy:view" },
  { verb: "get", path: `/crm/autonomy/switches`, key: "crm:autonomy:view" },
];

const POST_ROUTES: readonly GatedRoute[] = [
  { verb: "post", path: `/crm/autonomy/class-stops/${ID}/release`, key: "crm:autonomy:manage" },
  { verb: "post", path: `/crm/autonomy/cold-outbound/domains`, key: "crm:autonomy:manage" },
  { verb: "post", path: `/crm/autonomy/cold-outbound/domains/${ID}/verify`, key: "crm:autonomy:manage" },
  { verb: "post", path: `/crm/autonomy/cold-outbound/domains/${ID}/warmup`, key: "crm:autonomy:manage" },
  { verb: "post", path: `/crm/autonomy/cold-outbound/resume`, key: "crm:autonomy:manage" },
  { verb: "post", path: `/crm/autonomy/cold-outbound/track`, key: "crm:autonomy:manage" },
  { verb: "post", path: `/crm/autonomy/decisions/${ID}/reverse`, key: "crm:autonomy:reverse" },
  { verb: "post", path: `/crm/autonomy/holds/${ID}/cancel`, key: "crm:autonomy:reverse" },
  { verb: "post", path: `/crm/autonomy/nurture/sequences`, key: "crm:autonomy:manage" },
  { verb: "post", path: `/crm/autonomy/nurture/sequences/${ID}/enrollments`, key: "crm:autonomy:manage" },
  { verb: "post", path: `/crm/autonomy/outbound`, key: "crm:autonomy:manage" },
  { verb: "post", path: `/crm/autonomy/repairs/${ID}/revert`, key: "crm:autonomy:reverse" },
  { verb: "post", path: `/crm/autonomy/repairs/run`, key: "crm:autonomy:repair" },
  { verb: "post", path: `/crm/autonomy/review-queue/${ID}/reviewed`, key: "crm:autonomy:view" },
];

const PUT_ROUTES: readonly GatedRoute[] = [
  { verb: "put", path: `/crm/autonomy/nurture/sequences/${ID}/steps`, key: "crm:autonomy:manage" },
];

const PATCH_ROUTES: readonly GatedRoute[] = [
  { verb: "patch", path: `/crm/autonomy/nurture/sequences/${ID}`, key: "crm:autonomy:manage" },
  { verb: "patch", path: `/crm/autonomy/repair-policies`, key: "crm:autonomy:repair" },
  { verb: "patch", path: `/crm/autonomy/settings`, key: "crm:autonomy:manage" },
  { verb: "patch", path: `/crm/autonomy/switches`, key: "crm:autonomy:manage" },
];

const DELETE_ROUTES: readonly GatedRoute[] = [
  { verb: "delete", path: `/crm/autonomy/nurture/sequences/${ID}`, key: "crm:autonomy:manage" },
  { verb: "delete", path: `/crm/autonomy/nurture/sequences/${ID}/enrollments/${ID}`, key: "crm:autonomy:manage" },
];

const ALL_ROUTES: readonly GatedRoute[] = [
  ...GET_ROUTES,
  ...POST_ROUTES,
  ...PUT_ROUTES,
  ...PATCH_ROUTES,
  ...DELETE_ROUTES,
];

describe("autonomy — authorization deny", () => {
  let harness: AuthzHarness;

  beforeAll(async () => {
    harness = await createAuthzHarness([
      AutonomyReviewController,
      ColdOutboundAdminController,
      NurtureSequencesController,
      OutboundController,
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
     * any grant, so a typo below would produce a 403 that proves nothing.
     */
    const catalogued = new Set<string>(ALL_PERMISSION_NAMES);
    expect(ALL_ROUTES.map((r) => r.key).filter((k) => !catalogued.has(k))).toEqual([]);
  });

  it("covers the whole gated surface of these controllers", () => {
    expect(ALL_ROUTES.length).toBe(36);
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
      const res = await request(harness.server()).get(`/crm/autonomy/class-stops`);
      expect(res.status).toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("answers 402 — not 403 — when the module behind the key is unavailable", async () => {
      /*
       * `authorize()` resolves the key's namespace through `AuthContext` before
       * it looks at any grant, and reports NO_MODULE as a 402 the frontend keys
       * its upgrade prompt on. A module-gate refusal must not be read as proof
       * that the permission itself was checked.
       */
      harness.disableModule("org-disabled");
      harness.allowAll();
      const res = await request(harness.server()).get(`/crm/autonomy/class-stops`);
      expect(res.status).toBe(402);
    });

    it("refuses a principal from another tenant the same way", async () => {
      harness.actAs({ orgId: ORG_B, userId: "user-b" });
      harness.denyOnly("crm:autonomy:view");
      const res = await request(harness.server()).get(`/crm/autonomy/class-stops`);
      expect(res.status).toBe(403);
    });
  });
});
