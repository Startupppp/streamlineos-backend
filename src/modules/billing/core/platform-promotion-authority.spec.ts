import { Test, type TestingModule } from "@nestjs/testing";
import { type INestApplication } from "@nestjs/common";
import request from "supertest";
import { PlatformPromotionsController } from "./platform-promotions.controller";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { APP_CONFIG } from "../../../config/config.module";

const VALID_SECRET = "test-internal-secret";

const stubDb = {
  select: jest.fn(() => ({ from: jest.fn(() => ({ where: jest.fn(async () => []), orderBy: jest.fn(() => ({ limit: jest.fn(async () => []) })) })) })),
  insert: jest.fn(() => ({ values: jest.fn(() => ({ returning: jest.fn(async () => [{ id: 1, code: "TEST10", type: "PERCENTAGE", value: "10", minPurchase: null, maxUses: null, usedCount: 0, isActive: true, applicablePlans: null, expiresAt: null, orgId: null, createdAt: new Date(), updatedAt: new Date() }]) })) })),
  update: jest.fn(() => ({ set: jest.fn(() => ({ where: jest.fn(() => ({ returning: jest.fn(async () => [{ id: 1 }]) })) })) })),
  leftJoin: jest.fn(),
  groupBy: jest.fn(),
  orderBy: jest.fn(() => ({ limit: jest.fn(async () => []) })),
};

async function buildApp(): Promise<INestApplication> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    controllers: [PlatformPromotionsController],
    providers: [
      { provide: DRIZZLE, useValue: stubDb },
      { provide: APP_CONFIG, useValue: { INTERNAL_API_SECRET: VALID_SECRET } },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe("PlatformPromotionsController — authority (AB-04)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /platform/promotions — missing or wrong secret is rejected", () => {
    it("returns 401 with no secret header", async () => {
      const res = await request(app.getHttpServer()).get("/platform/promotions");
      expect(res.status).toBe(401);
    });

    it("returns 401 with a wrong secret", async () => {
      const res = await request(app.getHttpServer())
        .get("/platform/promotions")
        .set("x-internal-secret", "wrong-secret");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /platform/promotions — mutation blocked without secret", () => {
    it("returns 401 with no secret", async () => {
      const res = await request(app.getHttpServer())
        .post("/platform/promotions")
        .send({ code: "TEST10", type: "PERCENTAGE", value: 10 });
      expect(res.status).toBe(401);
    });

    it("returns 401 with wrong secret", async () => {
      const res = await request(app.getHttpServer())
        .post("/platform/promotions")
        .set("x-internal-secret", "not-valid")
        .send({ code: "TEST10", type: "PERCENTAGE", value: 10 });
      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /platform/promotions/:id — mutation blocked without secret", () => {
    it("returns 401 with no secret", async () => {
      const res = await request(app.getHttpServer())
        .patch("/platform/promotions/1")
        .send({ isActive: false });
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /platform/promotions/:id — mutation blocked without secret", () => {
    it("returns 401 with no secret", async () => {
      const res = await request(app.getHttpServer())
        .delete("/platform/promotions/1");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /platform/promotions/legacy-tenant-coupons — blocked without secret", () => {
    it("returns 401 with no secret", async () => {
      const res = await request(app.getHttpServer())
        .get("/platform/promotions/legacy-tenant-coupons");
      expect(res.status).toBe(401);
    });
  });
});

describe("PlatformPromotionsController — platform promotion writes never have org_id (AB-04)", () => {
  let insertValues: Array<Record<string, unknown>> = [];
  let updateWheres: unknown[] = [];
  let app: INestApplication;

  beforeAll(async () => {
    insertValues = [];
    updateWheres = [];
    const capturingDb = {
      select: jest.fn(() => ({ from: jest.fn(() => ({ where: jest.fn(async () => []), orderBy: jest.fn(() => ({ limit: jest.fn(async () => []) })) })) })),
      insert: jest.fn(() => ({
        values: jest.fn((v: Record<string, unknown>) => {
          insertValues.push(v);
          return { returning: jest.fn(async () => [{ id: 1, ...v, minPurchase: null, usedCount: 0, createdAt: new Date(), updatedAt: new Date() }]) };
        }),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn((w: unknown) => {
            updateWheres.push(w);
            return { returning: jest.fn(async () => [{ id: 2 }]) };
          }),
        })),
      })),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [PlatformPromotionsController],
      providers: [
        { provide: DRIZZLE, useValue: capturingDb },
        { provide: APP_CONFIG, useValue: { INTERNAL_API_SECRET: VALID_SECRET } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST writes a promotion with no orgId (org_id IS NULL)", async () => {
    await request(app.getHttpServer())
      .post("/platform/promotions")
      .set("x-internal-secret", VALID_SECRET)
      .send({ code: "PLATFORM10", type: "PERCENTAGE", value: 10 });

    expect(insertValues.length).toBeGreaterThan(0);
    expect(insertValues[0]?.orgId).toBeUndefined();
  });
});
