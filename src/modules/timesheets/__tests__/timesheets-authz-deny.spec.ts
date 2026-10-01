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
import { TimesheetApprovalsController } from "../core/approvals.controller";
import { TeamController } from "../core/team.controller";
import { TimesheetReportsController } from "../core/reports.controller";
import { TimesheetBillingController } from "../core/billing.controller";
import { TimesheetSettingsController } from "../core/settings.controller";
import { RatesController } from "../core/rates.controller";
import { TimesheetAuditController } from "../core/audit.controller";
import { TimesheetExceptionsController } from "../core/exceptions.controller";
import { TimerController } from "../core/timer.controller";
import { TimesheetBudgetsController } from "../core/budgets.controller";
import { ALL_PERMISSION_NAMES } from "../../rbac/permissions";

const ID = "11111111-1111-4111-8111-111111111111";

/**
 * The one route here that names several keys, any one of which admits.
 *
 * It is held out of GET_ROUTES because `denyOnly` is the wrong instrument for
 * it: withdrawing one of three alternatives is meant NOT to refuse, and a row in
 * the generic loop would assert the opposite — the shape that kept FE-TS-003
 * alive, since the spec agreed with the guard that one key was required. Its own
 * block below asserts both halves instead, and it still counts toward the 59.
 */
const PERIOD_DETAIL_PATH = `/timesheets/periods/${ID}`;
const PERIOD_DETAIL_KEYS = [
  "timesheets:entries:view",
  "timesheets:team:view",
  "timesheets:approvals:view",
] as const;

const MULTI_KEY_GET_ROUTES: readonly GatedRoute[] = [
  { verb: "get", path: PERIOD_DETAIL_PATH, key: PERIOD_DETAIL_KEYS[0] },
];

const GET_ROUTES: readonly GatedRoute[] = [
  { verb: "get", path: `/timesheets/calendar/holidays`, key: "timesheets:entries:view" },
  { verb: "get", path: `/timesheets/entries`, key: "timesheets:entries:view" },
  { verb: "get", path: `/timesheets/periods`, key: "timesheets:entries:view" },
  { verb: "get", path: `/timesheets/periods/current`, key: "timesheets:entries:view" },
  { verb: "get", path: `/timesheets/periods/${ID}/approver`, key: "timesheets:entries:view" },
  { verb: "get", path: `/timesheets/periods/overdue`, key: "timesheets:approvals:view" },
  { verb: "get", path: `/timesheets/approvals`, key: "timesheets:approvals:view" },
  { verb: "get", path: `/timesheets/team/week-summary`, key: "timesheets:team:view" },
  { verb: "get", path: `/timesheets/reports/overview`, key: "timesheets:reports:view" },
  { verb: "get", path: `/timesheets/reports/utilization`, key: "timesheets:reports:view" },
  { verb: "get", path: `/timesheets/reports/client-profitability`, key: "timesheets:reports:view" },
  { verb: "get", path: `/timesheets/reports/compliance`, key: "timesheets:reports:view" },
  { verb: "get", path: `/timesheets/reports/approval-sla`, key: "timesheets:reports:view" },
  { verb: "get", path: `/timesheets/reports/billing-leakage`, key: "timesheets:reports:view" },
  { verb: "get", path: `/timesheets/billing/uninvoiced`, key: "timesheets:billing:view" },
  { verb: "get", path: `/timesheets/billing/uninvoiced-entries`, key: "timesheets:billing:view" },
  { verb: "get", path: `/timesheets/billing/rate-preview`, key: "timesheets:billing:view" },
  { verb: "get", path: `/timesheets/settings`, key: "timesheets:settings:view" },
  { verb: "get", path: `/timesheets/settings/history`, key: "timesheets:settings:view" },
  { verb: "get", path: `/timesheets/rates`, key: "timesheets:rates:view" },
  { verb: "get", path: `/timesheets/audit`, key: "timesheets:audit:view" },
  { verb: "get", path: `/timesheets/audit/verify`, key: "timesheets:audit:view" },
  { verb: "get", path: `/timesheets/exceptions`, key: "timesheets:exceptions:view" },
  { verb: "get", path: `/timesheets/exceptions/summary`, key: "timesheets:exceptions:view" },
  { verb: "get", path: `/timesheets/timer/active`, key: "timesheets:entries:view" },
  { verb: "get", path: `/timesheets/budgets`, key: "timesheets:budgets:view" },
];

const POST_ROUTES: readonly GatedRoute[] = [
  { verb: "post", path: `/timesheets/entries`, key: "timesheets:entries:create" },
  { verb: "post", path: `/timesheets/entries/from-attendance`, key: "timesheets:entries:create" },
  { verb: "post", path: `/timesheets/entries/${ID}/void`, key: "timesheets:entries:void" },
  { verb: "post", path: `/timesheets/periods/${ID}/lock`, key: "timesheets:approvals:manage" },
  { verb: "post", path: `/timesheets/periods/${ID}/recall`, key: "timesheets:entries:create" },
  { verb: "post", path: `/timesheets/periods/${ID}/reopen`, key: "timesheets:approvals:manage" },
  { verb: "post", path: `/timesheets/periods/${ID}/submit`, key: "timesheets:entries:create" },
  { verb: "post", path: `/timesheets/periods/${ID}/unlock`, key: "timesheets:approvals:manage" },
  { verb: "post", path: `/timesheets/approvals/bulk-approve`, key: "timesheets:approvals:manage" },
  { verb: "post", path: `/timesheets/approvals/bulk-reject`, key: "timesheets:approvals:manage" },
  { verb: "post", path: `/timesheets/approvals/${ID}/approve`, key: "timesheets:approvals:manage" },
  { verb: "post", path: `/timesheets/approvals/${ID}/reject`, key: "timesheets:approvals:manage" },
  { verb: "post", path: `/timesheets/billing/export`, key: "timesheets:billing:export" },
  { verb: "post", path: `/timesheets/billing/create-invoice-draft`, key: "timesheets:billing:invoice" },
  { verb: "post", path: `/timesheets/billing/release-draft`, key: "timesheets:billing:invoice" },
  { verb: "post", path: `/timesheets/rates`, key: "timesheets:rates:manage" },
  { verb: "post", path: `/timesheets/exceptions/${ID}/resolve`, key: "timesheets:exceptions:manage" },
  { verb: "post", path: `/timesheets/exceptions/${ID}/dismiss`, key: "timesheets:exceptions:manage" },
  { verb: "post", path: `/timesheets/exceptions/run-detection`, key: "timesheets:exceptions:manage" },
  { verb: "post", path: `/timesheets/timer/start`, key: "timesheets:entries:create" },
  { verb: "post", path: `/timesheets/timer/${ID}/pause`, key: "timesheets:entries:create" },
  { verb: "post", path: `/timesheets/timer/${ID}/resume`, key: "timesheets:entries:create" },
  { verb: "post", path: `/timesheets/timer/${ID}/stop`, key: "timesheets:entries:create" },
  { verb: "post", path: `/timesheets/timer/${ID}/discard`, key: "timesheets:entries:create" },
  { verb: "post", path: `/timesheets/timer/${ID}/convert`, key: "timesheets:entries:create" },
  { verb: "post", path: `/timesheets/budgets`, key: "timesheets:budgets:manage" },
];

const PUT_ROUTES: readonly GatedRoute[] = [
];

const PATCH_ROUTES: readonly GatedRoute[] = [
  { verb: "patch", path: `/timesheets/entries/${ID}`, key: "timesheets:entries:update" },
  { verb: "patch", path: `/timesheets/settings`, key: "timesheets:settings:manage" },
  { verb: "patch", path: `/timesheets/rates/${ID}`, key: "timesheets:rates:manage" },
  { verb: "patch", path: `/timesheets/budgets/${ID}`, key: "timesheets:budgets:manage" },
];

const DELETE_ROUTES: readonly GatedRoute[] = [
  { verb: "delete", path: `/timesheets/rates/${ID}`, key: "timesheets:rates:manage" },
  { verb: "delete", path: `/timesheets/budgets/${ID}`, key: "timesheets:budgets:manage" },
];

const ALL_ROUTES: readonly GatedRoute[] = [
  ...GET_ROUTES,
  ...MULTI_KEY_GET_ROUTES,
  ...POST_ROUTES,
  ...PUT_ROUTES,
  ...PATCH_ROUTES,
  ...DELETE_ROUTES,
];

describe("timesheets — authorization deny", () => {
  let harness: AuthzHarness;

  beforeAll(async () => {
    harness = await createAuthzHarness(
      [
        EntriesController,
        TimesheetCalendarController,
        TimesheetPeriodsController,
        TimesheetApprovalsController,
        TeamController,
        TimesheetReportsController,
        TimesheetBillingController,
        TimesheetSettingsController,
        RatesController,
        TimesheetAuditController,
        TimesheetExceptionsController,
        TimerController,
        TimesheetBudgetsController,
      ],
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
    expect(
      [...ALL_ROUTES.map((r) => r.key), ...PERIOD_DETAIL_KEYS].filter((k) => !catalogued.has(k)),
    ).toEqual([]);
  });

  it("covers the whole gated surface of these controllers", () => {
    // 59 = every @RequirePermission route on the thirteen controllers mounted
    // above. Adding a gated timesheets route without a row here fails this.
    expect(ALL_ROUTES.length).toBe(59);
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

  describe("a period detail opens to any of three standings", () => {
    it.each(PERIOD_DETAIL_KEYS)(
      "is NOT refused when only %s is withdrawn, because the other two still admit",
      async (withdrawn) => {
        harness.denyOnly(withdrawn);
        const res = await request(harness.server()).get(PERIOD_DETAIL_PATH);
        expect(res.status).not.toBe(403);
        expect(harness.keysAsked()).toContain(withdrawn);
      },
    );

    it("is 403 once all three are withdrawn, so the route is still gated", async () => {
      harness.denyAll();
      const res = await request(harness.server()).get(PERIOD_DETAIL_PATH);
      expect(res.status).toBe(403);
      for (const key of PERIOD_DETAIL_KEYS) expect(harness.keysAsked()).toContain(key);
    });

    it("asks about all three keys, so none is declared and then ignored", async () => {
      harness.allowAll();
      const res = await request(harness.server()).get(PERIOD_DETAIL_PATH);
      expect(res.status).not.toBe(403);
      for (const key of PERIOD_DETAIL_KEYS) expect(harness.keysAsked()).toContain(key);
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
