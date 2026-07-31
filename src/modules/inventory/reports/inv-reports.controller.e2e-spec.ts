import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { signToken } from "../../../../test/helpers/sign-token";

describe("/inventory/reports (e2e)", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    token = await signToken({ orgId: "org_inv_01", isOrgOwner: true, enabledModules: ["inventory"] });
  });

  afterAll(async () => app.close());

  it("401 on GET /inventory/reports/dashboard without token", async () => {
    const res = await request(app.getHttpServer()).get("/inventory/reports/dashboard");
    expect(res.status).toBe(401);
  });

  it("200 on GET /inventory/reports/dashboard", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/reports/dashboard")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("200 on GET /inventory/reports/stock-summary", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/reports/stock-summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("200 on GET /inventory/reports/reorder", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/reports/reorder")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("200 on GET /inventory/reports/movements", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/reports/movements")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("dashboard response contains expected shape", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/reports/dashboard")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body).toBeDefined();
  });
});
