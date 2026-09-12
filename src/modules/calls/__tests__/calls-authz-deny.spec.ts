import request from "supertest";
import {
  createAuthzHarness,
  ORG_B,
  type AuthzHarness,
  type GatedRoute,
} from "../../../../test/helpers/authz-deny-harness";
import { CallAnalysisController } from "../call-analysis.controller";
import { CallCoachingController } from "../call-coaching.controller";
import { CallIntelligenceController } from "../call-intelligence.controller";
import { CallRecordingConsentController } from "../call-recording-consent.controller";
import { ALL_PERMISSION_NAMES } from "../../rbac/permissions";

/**
 * The deny branch of every authorization gate on the calls HTTP surface that
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
  { verb: "get", path: `/crm/calls/${ID}/analysis`, key: "crm:call-analysis:view" },
  { verb: "get", path: `/crm/calls/${ID}/recording-consent`, key: "crm:call-analysis:view" },
  { verb: "get", path: `/crm/calls/coaching`, key: "crm:call-analysis:view-team" },
  { verb: "get", path: `/crm/calls/consent-refusals`, key: "crm:call-recording-consent:attest" },
  { verb: "get", path: `/crm/calls/exemplars`, key: "crm:call-analysis:view" },
  { verb: "get", path: `/crm/calls/reps`, key: "crm:call-analysis:view" },
];

const POST_ROUTES: readonly GatedRoute[] = [
  { verb: "post", path: `/crm/calls/${ID}/analysis`, key: "crm:call-analysis:run" },
  { verb: "post", path: `/crm/calls/${ID}/analysis/release`, key: "crm:call-analysis:view" },
];

const PUT_ROUTES: readonly GatedRoute[] = [
  { verb: "put", path: `/crm/calls/${ID}/recording-consent`, key: "crm:call-recording-consent:attest" },
];

const PATCH_ROUTES: readonly GatedRoute[] = [
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

describe("calls — authorization deny", () => {
  let harness: AuthzHarness;

  beforeAll(async () => {
    harness = await createAuthzHarness([
      CallAnalysisController,
      CallCoachingController,
      CallIntelligenceController,
      CallRecordingConsentController,
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
    expect(ALL_ROUTES.length).toBe(9);
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

  });

  describe("the refusal is the permission check, not something upstream of it", () => {
    it("answers 401 — not 403 — when no AuthContext is attached at all", async () => {
      harness.withoutAuthContext();
      harness.denyAll();
      const res = await request(harness.server()).get(`/crm/calls/${ID}/analysis`);
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
      const res = await request(harness.server()).get(`/crm/calls/${ID}/analysis`);
      expect(res.status).toBe(402);
    });

    it("refuses a principal from another tenant the same way", async () => {
      harness.actAs({ orgId: ORG_B, userId: "user-b" });
      harness.denyOnly("crm:call-analysis:view");
      const res = await request(harness.server()).get(`/crm/calls/${ID}/analysis`);
      expect(res.status).toBe(403);
    });
  });
});
