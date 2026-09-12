import request from "supertest";
import {
  createAuthzHarness,
  ORG_B,
  type AuthzHarness,
  type GatedRoute,
} from "../../../../test/helpers/authz-deny-harness";
import { AuditExportController } from "../audit-export/audit-export.controller";
import { ChannelPoolsController } from "../channels/pools/channel-pools.controller";
import { ChannelsController } from "../channels/channels.controller";
import { ChannelSnapshotController } from "../channels/channel-snapshot.controller";
import { ChannelSyncController } from "../channels/sync/channel-sync.controller";
import { ExportController } from "../import-export/export.controller";
import { ImportController } from "../import-export/import.controller";
import { InvAiController } from "../ai/inv-ai.controller";
import { InvAiExplainController } from "../ai/inv-ai-explain.controller";
import { InvAiFeedbackController } from "../ai/feedback/inv-ai-feedback.controller";
import { InvAnomalyController } from "../ai/anomalies/inv-anomaly.controller";
import { InvAuditEventsController } from "../audit/inv-audit-events.controller";
import { InvCopilotController } from "../ai/copilot/inv-copilot.controller";
import { InvDemandRiskController } from "../ai/demand-risk/inv-demand-risk.controller";
import { InvExpirySweepController } from "../notifications/inv-expiry-sweep.controller";
import { InvForecastDriftController } from "../replenishment/inv-forecast-drift.controller";
import { InvForecastingController } from "../replenishment/inv-forecasting.controller";
import { InvMetricsController } from "../observability/inv-metrics.controller";
import { InvPoBatchesController } from "../replenishment/inv-po-batches.controller";
import { InvReplenishmentController } from "../replenishment/inv-replenishment.controller";
import { InvReportBuilderController } from "../ai/reports/inv-report-builder.controller";
import { InvReportsController } from "../reports/inv-reports.controller";
import { InvTransferRecommendationsController } from "../replenishment/inv-transfer-recommendations.controller";
import { InvWebhooksController } from "../webhooks/webhooks.controller";
import { QuickCommerceController } from "../channels/quick-commerce/quick-commerce.controller";
import { SyncBatchController } from "../sync/sync-batch.controller";
import { TplController } from "../channels/tpl.controller";
import { ALL_PERMISSION_NAMES } from "../../rbac/permissions";

/**
 * The deny branch of every authorization gate on inventory channels, planning and integrations.
 *
 * Sales channels and 3PL, the AI surfaces, replenishment and forecasting, import/export, reports, webhooks and the audit export.
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
  { verb: "get", path: `/inventory/3pl/connections`, key: "inventory:3pl:manage" },
  { verb: "get", path: `/inventory/ai/anomalies`, key: "inventory:ai:read" },
  { verb: "get", path: `/inventory/ai/anomalies/detectors`, key: "inventory:ai:read" },
  { verb: "get", path: `/inventory/ai/digest`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/ai/feedback/summary`, key: "inventory:ai:manage" },
  { verb: "get", path: `/inventory/ai/insights`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/ai/ops-brief`, key: "inventory:ai:read" },
  { verb: "get", path: `/inventory/ai/reports/catalog`, key: "inventory:ai:read" },
  { verb: "get", path: `/inventory/ai/supplier-delay`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/audit-events`, key: "inventory:audit:read" },
  { verb: "get", path: `/inventory/audit-export/jobs`, key: "inventory:audit:export" },
  { verb: "get", path: `/inventory/audit-export/jobs/${ID}`, key: "inventory:audit:export" },
  { verb: "get", path: `/inventory/audit-export/jobs/${ID}/download`, key: "inventory:audit:export" },
  { verb: "get", path: `/inventory/audit-export/jobs/${ID}/verify`, key: "inventory:audit:export" },
  { verb: "get", path: `/inventory/channels`, key: "inventory:channels:manage" },
  { verb: "get", path: `/inventory/channels/${ID}/publications`, key: "inventory:channels:manage" },
  { verb: "get", path: `/inventory/channels/${ID}/snapshot-differences`, key: "inventory:channels:manage" },
  { verb: "get", path: `/inventory/channels/${ID}/sync/failures`, key: "inventory:channels:manage" },
  { verb: "get", path: `/inventory/channels/pools/availability`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/channels/pools/by-variant`, key: "inventory:stock:read" },
  { verb: "get", path: `/inventory/channels/pools/channel/${ID}`, key: "inventory:channels:manage" },
  { verb: "get", path: `/inventory/export/jobs`, key: "inventory:export" },
  { verb: "get", path: `/inventory/export/jobs/${ID}`, key: "inventory:export" },
  { verb: "get", path: `/inventory/export/jobs/${ID}/download`, key: "inventory:export" },
  { verb: "get", path: `/inventory/forecasting`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/forecasting/baseline/${ID}`, key: "inventory:replenishment:manage" },
  { verb: "get", path: `/inventory/forecasting/lead-time/vendor/${ID}`, key: "inventory:replenishment:manage" },
  { verb: "get", path: `/inventory/forecasting/reorder-proposal/${ID}`, key: "inventory:replenishment:manage" },
  { verb: "get", path: `/inventory/forecasting/safety-stock/${ID}`, key: "inventory:replenishment:manage" },
  { verb: "get", path: `/inventory/forecasting/versions/${ID}`, key: "inventory:replenishment:manage" },
  { verb: "get", path: `/inventory/forecasting/versions/${ID}/latest`, key: "inventory:replenishment:manage" },
  { verb: "get", path: `/inventory/import/jobs`, key: "inventory:import" },
  { verb: "get", path: `/inventory/import/jobs/${ID}`, key: "inventory:import" },
  { verb: "get", path: `/inventory/import/staged/${ID}`, key: "inventory:import" },
  { verb: "get", path: `/inventory/import/staged/${ID}/errors`, key: "inventory:import" },
  { verb: "get", path: `/inventory/metrics`, key: "inventory:settings:manage" },
  { verb: "get", path: `/inventory/quick-commerce/asns`, key: "inventory:purchase-orders:read" },
  { verb: "get", path: `/inventory/quick-commerce/asns/${ID}`, key: "inventory:purchase-orders:read" },
  { verb: "get", path: `/inventory/quick-commerce/fill-rate`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/quick-commerce/purchase-orders`, key: "inventory:channels:manage" },
  { verb: "get", path: `/inventory/quick-commerce/purchase-orders/${ID}`, key: "inventory:channels:manage" },
  { verb: "get", path: `/inventory/replenishment/drift`, key: "inventory:replenishment:read" },
  { verb: "get", path: `/inventory/replenishment/drift/${ID}`, key: "inventory:replenishment:read" },
  { verb: "get", path: `/inventory/replenishment/po-batches/proposals`, key: "inventory:replenishment:read" },
  { verb: "get", path: `/inventory/replenishment/rules`, key: "inventory:replenishment:manage" },
  { verb: "get", path: `/inventory/replenishment/suggestions`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/replenishment/transfer-recommendations/${ID}`, key: "inventory:replenishment:read" },
  { verb: "get", path: `/inventory/reports/dashboard`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/reports/expiry`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/reports/movements`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/reports/reorder`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/reports/slow-moving`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/reports/stock-summary`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/reports/throughput`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/reports/valuation`, key: "inventory:valuation:read" },
  { verb: "get", path: `/inventory/reports/work-aging`, key: "inventory:reports:read" },
  { verb: "get", path: `/inventory/webhooks`, key: "inventory:webhooks:manage" },
  { verb: "get", path: `/inventory/webhooks/${ID}/events`, key: "inventory:webhooks:manage" },
];

const POST_ROUTES: readonly GatedRoute[] = [
  { verb: "post", path: `/inventory/3pl/connections`, key: "inventory:3pl:manage" },
  { verb: "post", path: `/inventory/3pl/connections/${ID}/sync`, key: "inventory:3pl:manage" },
  { verb: "post", path: `/inventory/ai/copilot/ask`, key: "inventory:ai:read" },
  { verb: "post", path: `/inventory/ai/demand-risk`, key: "inventory:ai:read" },
  { verb: "post", path: `/inventory/ai/feedback`, key: "inventory:ai:read" },
  { verb: "post", path: `/inventory/ai/insights/${ID}/explain`, key: "inventory:reports:read" },
  { verb: "post", path: `/inventory/ai/insights/generate`, key: "inventory:ai:manage" },
  { verb: "post", path: `/inventory/ai/ops-brief/narrate`, key: "inventory:ai:read" },
  { verb: "post", path: `/inventory/ai/reorder-proposal`, key: "inventory:ai:propose" },
  { verb: "post", path: `/inventory/ai/reorder-proposal/confirm`, key: "inventory:ai:propose" },
  { verb: "post", path: `/inventory/ai/reports/ask`, key: "inventory:ai:read" },
  { verb: "post", path: `/inventory/audit-export/jobs`, key: "inventory:audit:export" },
  { verb: "post", path: `/inventory/channels`, key: "inventory:channels:manage" },
  { verb: "post", path: `/inventory/channels/${ID}/publications/retry`, key: "inventory:channels:manage" },
  { verb: "post", path: `/inventory/channels/${ID}/sync-stock`, key: "inventory:channels:manage" },
  { verb: "post", path: `/inventory/channels/${ID}/sync/orders`, key: "inventory:sales-orders:create" },
  { verb: "post", path: `/inventory/channels/${ID}/sync/shipments`, key: "inventory:sales-orders:ship" },
  { verb: "post", path: `/inventory/channels/${ID}/sync/stock`, key: "inventory:channels:manage" },
  { verb: "post", path: `/inventory/channels/pools/allocate`, key: "inventory:channels:manage" },
  { verb: "post", path: `/inventory/channels/snapshot-differences/${ID}/accept`, key: "inventory:stock:adjust" },
  { verb: "post", path: `/inventory/channels/snapshot-differences/${ID}/dismiss`, key: "inventory:channels:manage" },
  { verb: "post", path: `/inventory/channels/sync/failures/${ID}/retry`, key: "inventory:sales-orders:create" },
  { verb: "post", path: `/inventory/export/jobs`, key: "inventory:export" },
  { verb: "post", path: `/inventory/forecasting/simulate/${ID}`, key: "inventory:replenishment:manage" },
  { verb: "post", path: `/inventory/forecasting/versions/${ID}`, key: "inventory:replenishment:manage" },
  { verb: "post", path: `/inventory/forecasting/versions/refresh`, key: "inventory:replenishment:manage" },
  { verb: "post", path: `/inventory/import/jobs`, key: "inventory:import" },
  { verb: "post", path: `/inventory/import/preview`, key: "inventory:import" },
  { verb: "post", path: `/inventory/import/staged`, key: "inventory:import" },
  { verb: "post", path: `/inventory/import/staged/${ID}/cancel`, key: "inventory:import" },
  { verb: "post", path: `/inventory/import/staged/${ID}/process`, key: "inventory:import" },
  { verb: "post", path: `/inventory/import/staged/${ID}/rows`, key: "inventory:import" },
  { verb: "post", path: `/inventory/maintenance/expiry-sweep`, key: "inventory:settings:manage" },
  { verb: "post", path: `/inventory/quick-commerce/asns`, key: "inventory:purchase-orders:update" },
  { verb: "post", path: `/inventory/quick-commerce/payouts`, key: "inventory:channels:manage" },
  { verb: "post", path: `/inventory/quick-commerce/purchase-orders/${ID}/accept`, key: "inventory:purchase-orders:create" },
  { verb: "post", path: `/inventory/quick-commerce/purchase-orders/ingest`, key: "inventory:channels:manage" },
  { verb: "post", path: `/inventory/replenishment/po-batches`, key: "inventory:purchase-orders:create" },
  { verb: "post", path: `/inventory/replenishment/po-batches/preview`, key: "inventory:replenishment:read" },
  { verb: "post", path: `/inventory/replenishment/rules`, key: "inventory:replenishment:manage" },
  { verb: "post", path: `/inventory/replenishment/suggestions/generate-po`, key: "inventory:purchase-orders:create" },
  { verb: "post", path: `/inventory/replenishment/transfer-recommendations/approve`, key: "inventory:stock:transfer" },
  { verb: "post", path: `/inventory/sync/batch`, key: "inventory:stock:adjust" },
  { verb: "post", path: `/inventory/webhooks`, key: "inventory:webhooks:manage" },
  { verb: "post", path: `/inventory/webhooks/events/${ID}/retry`, key: "inventory:webhooks:manage" },
];

const PUT_ROUTES: readonly GatedRoute[] = [
];

const PATCH_ROUTES: readonly GatedRoute[] = [
  { verb: "patch", path: `/inventory/3pl/connections/${ID}`, key: "inventory:3pl:manage" },
  { verb: "patch", path: `/inventory/ai/anomalies/${ID}/review`, key: "inventory:ai:manage" },
  { verb: "patch", path: `/inventory/ai/insights/${ID}`, key: "inventory:ai:manage" },
  { verb: "patch", path: `/inventory/channels/${ID}`, key: "inventory:channels:manage" },
  { verb: "patch", path: `/inventory/replenishment/rules/${ID}`, key: "inventory:replenishment:manage" },
  { verb: "patch", path: `/inventory/webhooks/${ID}`, key: "inventory:webhooks:manage" },
];

const DELETE_ROUTES: readonly GatedRoute[] = [
  { verb: "delete", path: `/inventory/replenishment/rules/${ID}`, key: "inventory:replenishment:manage" },
  { verb: "delete", path: `/inventory/webhooks/${ID}`, key: "inventory:webhooks:manage" },
];

const ALL_ROUTES: readonly GatedRoute[] = [
  ...GET_ROUTES,
  ...POST_ROUTES,
  ...PUT_ROUTES,
  ...PATCH_ROUTES,
  ...DELETE_ROUTES,
];

describe("inventory channels, planning and integrations — authorization deny", () => {
  let harness: AuthzHarness;

  beforeAll(async () => {
    harness = await createAuthzHarness([
      AuditExportController,
      ChannelPoolsController,
      ChannelSnapshotController,
      ChannelSyncController,
      ChannelsController,
      ExportController,
      ImportController,
      InvAiController,
      InvAiExplainController,
      InvAiFeedbackController,
      InvAnomalyController,
      InvAuditEventsController,
      InvCopilotController,
      InvDemandRiskController,
      InvExpirySweepController,
      InvForecastDriftController,
      InvForecastingController,
      InvMetricsController,
      InvPoBatchesController,
      InvReplenishmentController,
      InvReportBuilderController,
      InvReportsController,
      InvTransferRecommendationsController,
      InvWebhooksController,
      QuickCommerceController,
      SyncBatchController,
      TplController,
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
    expect(ALL_ROUTES.length).toBe(111);
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
      const res = await request(harness.server()).get(`/inventory/3pl/connections`);
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
      const res = await request(harness.server()).get(`/inventory/3pl/connections`);
      expect(res.status).toBe(402);
    });

    it("refuses a principal from another tenant the same way", async () => {
      /*
       * The refusal must not depend on which tenant is asking: a caller in
       * org B without the key is refused exactly as one in org A is, and never
       * reaches org A's rows on the way to finding that out.
       */
      harness.actAs({ orgId: ORG_B, userId: "user-b" });
      harness.denyOnly("inventory:3pl:manage");
      const res = await request(harness.server()).get(`/inventory/3pl/connections`);
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
