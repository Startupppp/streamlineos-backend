import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "src/app.module";
import { AllExceptionsFilter } from "src/common/http/all-exceptions.filter";
import { signToken } from "./helpers/sign-token";
import { AccessService } from "src/modules/access/access.service";
import { InvReportsExtendedService } from "src/modules/inv-reports/inv-reports-extended.service";
import { InvReportsService } from "src/modules/inv-reports/inv-reports.service";

/**
 * Wave C1 E2E — tests the extended inv-reports endpoints that ARE registered in AppModule.
 *
 * NEW modules (InvTraceabilityModule, InvValuationModule, InvReplenishmentModule, InvAiModule)
 * must be added to src/app.module.ts before their 401/403/200 suites below can run.
 * Those suites use describe.skip until then.
 */

const mockExtendedService = {
  getDashboardExtras: jest.fn().mockResolvedValue({
    stockValue: 50000,
    expiringLotsCount: 2,
    qualityHoldQty: 10,
    activeReservationsCount: 3,
    openShipmentsCount: 1,
    failedChannelSyncsCount: 0,
    openInspectionsCount: 4,
    recentInsights: [],
  }),
  getValuationReport: jest.fn().mockResolvedValue({
    items: [
      {
        productVariantId: 1,
        variantSku: "SKU-001",
        variantName: "Var A",
        productId: 1,
        productName: "Prod A",
        costingMethod: "WAVG",
        onHand: 100,
        value: 5000,
        averageCost: 50,
      },
    ],
    total: 1,
    page: 1,
    totalPages: 1,
    totalValue: 5000,
  }),
  getSlowMovingReport: jest.fn().mockResolvedValue({
    items: [{ productVariantId: 2, variantSku: "SKU-002", onHand: 50, daysSinceLastMovement: 120 }],
    total: 1,
    page: 1,
    totalPages: 1,
  }),
  getExpiryReport: jest.fn().mockResolvedValue({
    items: [{ lotId: 1, lotNumber: "LOT-001", expiryDate: "2026-07-20", onHand: 10, variantSku: "SKU-003" }],
    total: 1,
    page: 1,
    totalPages: 1,
  }),
  getReorderReportUpgraded: jest.fn().mockResolvedValue([
    { productVariantId: 3, variantSku: "SKU-003", onHand: 2, reorderPoint: 5, suggestedQty: 20 },
  ]),
};

const mockReportsService = {
  getDashboard: jest.fn().mockResolvedValue({
    stockSummary: { totalSkus: 10, totalOnHand: 500, totalCommitted: 50, totalOnOrder: 30 },
    lowStockCount: 2,
    draftPoCount: 1,
    openSoCount: 3,
    recentMovements: [],
    stockValue: 50000,
    expiringLotsCount: 2,
    qualityHoldQty: 10,
    activeReservationsCount: 3,
    openShipmentsCount: 1,
    failedChannelSyncsCount: 0,
    openInspectionsCount: 4,
    recentInsights: [],
  }),
  getStockSummary: jest.fn().mockResolvedValue([]),
  getReorderReport: jest.fn().mockResolvedValue([]),
  getMovementsReport: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 }),
};

const mockAccessServiceAllPerms = {
  resolveUserPermissions: jest.fn().mockResolvedValue(
    new Map([
      ["inventory:reports:read", "all"],
      ["inventory:valuation:read", "all"],
      ["inventory:stock:read", "all"],
    ]),
  ),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
};

const mockAccessServiceNoPerms = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
};

describe("Inv Reports C1 — extended endpoints (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);

    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(InvReportsService)
      .useValue(mockReportsService)
      .overrideProvider(InvReportsExtendedService)
      .useValue(mockExtendedService)
      .overrideProvider(AccessService)
      .useValue(mockAccessServiceAllPerms)
      .compile();

    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => jest.clearAllMocks());

  describe("401 without auth token", () => {
    it("GET /inventory/reports/valuation → 401", async () => {
      const res = await request(app.getHttpServer()).get("/inventory/reports/valuation");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Unauthorized" });
    });

    it("GET /inventory/reports/slow-moving → 401", async () => {
      const res = await request(app.getHttpServer()).get("/inventory/reports/slow-moving");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Unauthorized" });
    });

    it("GET /inventory/reports/expiry → 401", async () => {
      const res = await request(app.getHttpServer()).get("/inventory/reports/expiry");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Unauthorized" });
    });
  });

  describe("404 when inventory module is disabled", () => {
    let noModuleApp: INestApplication;

    beforeAll(async () => {
      const ref = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(InvReportsService)
        .useValue(mockReportsService)
        .overrideProvider(InvReportsExtendedService)
        .useValue(mockExtendedService)
        .overrideProvider(AccessService)
        .useValue({
          resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
          isModuleEnabled: jest.fn().mockResolvedValue(false),
        })
        .compile();
      noModuleApp = ref.createNestApplication();
      noModuleApp.useGlobalFilters(new AllExceptionsFilter());
      await noModuleApp.init();
    });

    afterAll(async () => noModuleApp.close());

    it("GET /inventory/reports/valuation → 404 when module disabled", async () => {
      const token = await signToken({ permissions: [], enabledModules: [] });
      const res = await request(noModuleApp.getHttpServer())
        .get("/inventory/reports/valuation")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "MODULE_DISABLED", module: "inventory" });
    });
  });

  describe("403 without required permission", () => {
    let noPermApp: INestApplication;

    beforeAll(async () => {
      const ref = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(InvReportsService)
        .useValue(mockReportsService)
        .overrideProvider(InvReportsExtendedService)
        .useValue(mockExtendedService)
        .overrideProvider(AccessService)
        .useValue(mockAccessServiceNoPerms)
        .compile();
      noPermApp = ref.createNestApplication();
      noPermApp.useGlobalFilters(new AllExceptionsFilter());
      await noPermApp.init();
    });

    afterAll(async () => noPermApp.close());

    it("GET /inventory/reports/valuation → 403 without inventory:valuation:read", async () => {
      const token = await signToken({ permissions: [], enabledModules: ["inventory"] });
      const res = await request(noPermApp.getHttpServer())
        .get("/inventory/reports/valuation")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Permission denied" });
    });

    it("GET /inventory/reports/slow-moving → 403 without inventory:reports:read", async () => {
      const token = await signToken({ permissions: [], enabledModules: ["inventory"] });
      const res = await request(noPermApp.getHttpServer())
        .get("/inventory/reports/slow-moving")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Permission denied" });
    });

    it("GET /inventory/reports/expiry → 403 without inventory:reports:read", async () => {
      const token = await signToken({ permissions: [], enabledModules: ["inventory"] });
      const res = await request(noPermApp.getHttpServer())
        .get("/inventory/reports/expiry")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Permission denied" });
    });
  });

  describe("200 with correct permissions and response shape", () => {
    it("GET /inventory/reports/valuation → 200 with correct shape", async () => {
      const token = await signToken({
        permissions: ["inventory:valuation:read"],
        enabledModules: ["inventory"],
      });
      mockAccessServiceAllPerms.resolveUserPermissions.mockResolvedValue(
        new Map([["inventory:valuation:read", "all"]]),
      );
      const res = await request(app.getHttpServer())
        .get("/inventory/reports/valuation")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        items: expect.any(Array),
        total: expect.any(Number),
        page: expect.any(Number),
        totalPages: expect.any(Number),
        totalValue: expect.any(Number),
      });
      expect(res.body.items[0]).toMatchObject({
        productVariantId: expect.any(Number),
        variantSku: expect.any(String),
        costingMethod: expect.any(String),
        onHand: expect.any(Number),
        value: expect.any(Number),
      });
    });

    it("GET /inventory/reports/slow-moving → 200 with correct shape", async () => {
      const token = await signToken({
        permissions: ["inventory:reports:read"],
        enabledModules: ["inventory"],
      });
      mockAccessServiceAllPerms.resolveUserPermissions.mockResolvedValue(
        new Map([["inventory:reports:read", "all"]]),
      );
      const res = await request(app.getHttpServer())
        .get("/inventory/reports/slow-moving")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        items: expect.any(Array),
        total: expect.any(Number),
        page: expect.any(Number),
        totalPages: expect.any(Number),
      });
    });

    it("GET /inventory/reports/expiry → 200 with correct shape", async () => {
      const token = await signToken({
        permissions: ["inventory:reports:read"],
        enabledModules: ["inventory"],
      });
      mockAccessServiceAllPerms.resolveUserPermissions.mockResolvedValue(
        new Map([["inventory:reports:read", "all"]]),
      );
      const res = await request(app.getHttpServer())
        .get("/inventory/reports/expiry")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        items: expect.any(Array),
        total: expect.any(Number),
        page: expect.any(Number),
        totalPages: expect.any(Number),
      });
    });

    it("GET /inventory/reports/dashboard includes extended keys", async () => {
      const token = await signToken({
        permissions: ["inventory:reports:read"],
        enabledModules: ["inventory"],
      });
      mockAccessServiceAllPerms.resolveUserPermissions.mockResolvedValue(
        new Map([["inventory:reports:read", "all"]]),
      );
      const res = await request(app.getHttpServer())
        .get("/inventory/reports/dashboard")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        stockValue: expect.any(Number),
        expiringLotsCount: expect.any(Number),
        qualityHoldQty: expect.any(Number),
        activeReservationsCount: expect.any(Number),
        openShipmentsCount: expect.any(Number),
        failedChannelSyncsCount: expect.any(Number),
        openInspectionsCount: expect.any(Number),
        recentInsights: expect.any(Array),
      });
    });
  });
});

/**
 * These suites will be enabled once the following modules are added to src/app.module.ts:
 *   InvTraceabilityModule, InvValuationModule, InvReplenishmentModule, InvAiModule
 */
describe.skip("Inv Traceability — lots/serials/expiry (e2e) [register InvTraceabilityModule first]", () => {
  it.todo("GET /inventory/lots → 401 without auth");
  it.todo("GET /inventory/lots → 404 when module disabled");
  it.todo("GET /inventory/lots → 403 without inventory:stock:read");
  it.todo("GET /inventory/lots → 200 with items + total + page shape");
  it.todo("GET /inventory/serials → 200 with correct shape");
  it.todo("GET /inventory/expiry → 200 with expiryDate and onHand fields");
  it.todo("GET /inventory/traceability?lotId=1 → 200 with origin/receipts/currentStock");
  it.todo("PATCH /inventory/lots/1/status → 403 without inventory:stock:adjust");
});

describe.skip("Inv Replenishment — rules CRUD (e2e) [register InvReplenishmentModule first]", () => {
  it.todo("GET /inventory/replenishment/rules → 401 without auth");
  it.todo("POST /inventory/replenishment/rules → 201 creates rule");
  it.todo("PATCH /inventory/replenishment/rules/1 → 200 updates rule");
  it.todo("DELETE /inventory/replenishment/rules/1 → 200 soft-deletes rule");
  it.todo("GET /inventory/replenishment/suggestions → 200 with suggestedQty and reason");
  it.todo("POST /inventory/replenishment/suggestions/generate-po → 201 creates PO draft");
  it.todo("GET /inventory/forecasting → 200 with avgWeeklyDemand and projectedWeeks[4]");
});

describe.skip("Inv AI Insights — generate + list (e2e) [register InvAiModule first]", () => {
  it.todo("GET /inventory/ai/insights → 401 without auth");
  it.todo("GET /inventory/ai/insights → 403 without inventory:reports:read");
  it.todo("POST /inventory/ai/insights/generate → 200 with generated count");
  it.todo("GET /inventory/ai/insights → 200 with items + total + page");
  it.todo("PATCH /inventory/ai/insights/1 → 200 updates status to ACKNOWLEDGED");
  it.todo("PATCH /inventory/ai/insights/1 → 403 without inventory:reports:read");
});

describe.skip("Inv Valuation — summary and layers (e2e) [register InvValuationModule first]", () => {
  it.todo("GET /inventory/valuation → 401 without auth");
  it.todo("GET /inventory/valuation → 403 without inventory:valuation:read");
  it.todo("GET /inventory/valuation → 200 with items, totalValue, costingMethod per item");
  it.todo("GET /inventory/valuation/layers?variantId=1 → 200 with paginated layer history");
});
