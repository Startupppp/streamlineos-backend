import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../../../app.module";
import { AllExceptionsFilter } from "../../../../common/http/all-exceptions.filter";
import { signToken } from "../../../../../test/helpers/sign-token";
import { stubMembershipState } from "../../../../../test/helpers/membership-state";

describe("/inventory/cycle-counts (e2e)", () => {
  let app: INestApplication;
  let ownerToken: string;
  let noPermToken: string;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const moduleRef = await stubMembershipState(
      Test.createTestingModule({ imports: [AppModule] }),
      {
        owner_1: { role: "OWNER", isOwner: true },
        member_1: { role: "MEMBER" },
      },
    ).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    ownerToken = await signToken({ sub: "owner_1", orgId: "org_inv_cc" });
    noPermToken = await signToken({ sub: "member_1", orgId: "org_inv_cc" });
  });

  afterAll(async () => app.close());

  it("401 without token", async () => {
    const res = await request(app.getHttpServer()).get("/inventory/cycle-counts");
    expect(res.status).toBe(401);
  });

  it("200 GET /inventory/cycle-counts returns paginated list", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/cycle-counts")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("total");
  });

  it("403 GET /inventory/cycle-counts without permission", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/cycle-counts")
      .set("Authorization", `Bearer ${noPermToken}`);
    expect(res.status).toBe(403);
  });

  it("200 GET /inventory/physical-audits returns paginated list", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/physical-audits")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("total");
  });

  it("400 POST /inventory/cycle-counts/:id/post without Idempotency-Key", async () => {
    const res = await request(app.getHttpServer())
      .post("/inventory/cycle-counts/1/post")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
  });

  it("400 POST /inventory/physical-audits/:id/post without Idempotency-Key", async () => {
    const res = await request(app.getHttpServer())
      .post("/inventory/physical-audits/1/post")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
  });

  it("404 GET /inventory/cycle-counts/:id for non-existent count", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/cycle-counts/999999")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it("404 GET /inventory/physical-audits/:id for non-existent audit", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/physical-audits/999999")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it("cycle count full lifecycle status progression (404 for non-existent resources)", async () => {
    const startRes = await request(app.getHttpServer())
      .post("/inventory/cycle-counts/999999/start")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(startRes.status).toBe(404);

    const reviewRes = await request(app.getHttpServer())
      .post("/inventory/cycle-counts/999999/review")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(reviewRes.status).toBe(404);
  });
});
