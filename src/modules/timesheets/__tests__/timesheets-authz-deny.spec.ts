import request from "supertest";
import { DiscoveryService } from "@nestjs/core";
import {
  createAuthzHarness,
  ORG_B,
  type AuthzHarness,
  type GatedRoute,
} from "../../../../test/helpers/authz-deny-harness";
import { EntriesController } from "../core/entries.controller";
import { TimesheetCalendarController } from "../core/calendar.controller";
import { TimesheetPeriodsController } from "../core/periods.controller";
import { ALL_PERMISSION_NAMES } from "../../rbac/permissions";

const ID = "11111111-1111-4111-8111-111111111111";

const GET_ROUTES: readonly GatedRoute[] = [
  { verb: "get", path: `/timesheets/calendar/holidays`, key: "timesheets:entries:view" },
  { verb: "get", path: `/timesheets/entries`, key: "timesheets:entries:view" },
  { verb: "get", path: `/timesheets/periods`, key: "timesheets:entries:view" },
  { verb: "get", path: `/timesheets/periods/${ID}`, key: "timesheets:entries:view" },
  { verb: "get", path: `/timesheets/periods/current`, key: "timesheets:entries:view" },
  { verb: "get", path: `/timesheets/periods/overdue`, key: "timesheets:approvals:view" },
];

const POST_ROUTES: readonly GatedRoute[] = [
  { verb: "post", path: `/timesheets/entries`, key: "timesheets:entries:create" },
  { verb: "post", path: `/timesheets/entries/from-attendance`, key: "timesheets:entries:create" },
  { verb: "post", path: `/timesheets/periods/${ID}/lock`, key: "timesheets:approvals:manage" },
  { verb: "post", path: `/timesheets/periods/${ID}/recall`, key: "timesheets:entries:create" },
  { verb: "post", path: `/timesheets/periods/${ID}/reopen`, key: "timesheets:approvals:manage" },
  { verb: "post", path: `/timesheets/periods/${ID}/submit`, key: "timesheets:entries:create" },
  { verb: "post", path: `/timesheets/periods/${ID}/unlock`, key: "timesheets:approvals:manage" },
];

const PUT_ROUTES: readonly GatedRoute[] = [
];

const PATCH_ROUTES: readonly GatedRoute[] = [
  { verb: "patch", path: `/timesheets/entries/${ID}`, key: "timesheets:entries:update" },
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

describe("timesheets — authorization deny", () => {
  let harness: AuthzHarness;

  beforeAll(async () => {
    harness = await createAuthzHarness(
      [EntriesController, TimesheetCalendarController, TimesheetPeriodsController],
      {
        /*
         * PermissionGuard injects DiscoveryService and sweeps the discovered
         * controllers on bootstrap. The harness builds a bare testing module
         * with no DiscoveryModule, so that dependency is auto-mocked without
         * `getControllers` and `app.init()` throws before a single route is
         * exercised. Supply it explicitly: the sweep is a separate concern
         * (permission.guard-boot-sweep.spec.ts owns it) and this spec is about
         * what each route answers.
         */
        providers: [
          { provide: DiscoveryService, useValue: { getControllers: () => [] } },
        ],
      },
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.reset();
  });

  it("names only catalogued permission keys, so no case passes on a typo", () => {
    const catalogued = new Set<string>(ALL_PERMISSION_NAMES);
    expect(ALL_ROUTES.map((r) => r.key).filter((k) => !catalogued.has(k))).toEqual([]);
  });

  it("covers the whole gated surface of these controllers", () => {
    expect(ALL_ROUTES.length).toBe(14);
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

  });

  describe("the refusal is the permission check, not something upstream of it", () => {
    it("answers 401 — not 403 — when no AuthContext is attached at all", async () => {
      harness.withoutAuthContext();
      harness.denyAll();
      const res = await request(harness.server()).get(`/timesheets/calendar/holidays`);
      expect(res.status).toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("answers 402 — not 403 — when the module behind the key is unavailable", async () => {
      harness.disableModule("org-disabled");
      harness.allowAll();
      const res = await request(harness.server()).get(`/timesheets/calendar/holidays`);
      expect(res.status).toBe(402);
    });

    it("refuses a principal from another tenant the same way", async () => {
      harness.actAs({ orgId: ORG_B, userId: "user-b" });
      harness.denyOnly("timesheets:entries:view");
      const res = await request(harness.server()).get(`/timesheets/calendar/holidays`);
      expect(res.status).toBe(403);
    });
  });
});
