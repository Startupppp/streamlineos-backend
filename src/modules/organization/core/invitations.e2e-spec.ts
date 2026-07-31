import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { signToken } from "../../../../test/helpers/sign-token";

describe("Invitations auth/routing (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  it("400 on GET /organization/invitations/validate when token query param is absent", async () => {
    const res = await request(app.getHttpServer()).get("/organization/invitations/validate");
    expect(res.status).toBe(400);
  });

  it("GET /organization/invitations/validate with a token is reachable without a JWT (not 401)", async () => {
    const res = await request(app.getHttpServer())
      .get("/organization/invitations/validate")
      .query({ token: "some-token-value" });
    expect(res.status).not.toBe(401);
  });

  it("POST /organization/invitations/accept with a valid body is reachable without a JWT (not 401)", async () => {
    const res = await request(app.getHttpServer())
      .post("/organization/invitations/accept")
      .send({ token: "some-token-value" });
    expect(res.status).not.toBe(401);
  });

  type Method = "get" | "post" | "delete";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "delete":
        return agent.delete(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/organization/invitations"],
    ["post", "/organization/members"],
    ["delete", "/organization/invitations"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path).send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on GET /organization/invitations without settings:manage permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/organization/invitations")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("400 on POST /organization/invitations/accept when token field is missing", async () => {
    const res = await request(app.getHttpServer())
      .post("/organization/invitations/accept")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Validation failed") });
  });

  it("429 on POST /organization/invitations/accept after exhausting the 10-per-minute rate limit", async () => {
    const ip = "10.0.2.11";
    const body = { token: "test-rate-limit-token" };
    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer())
        .post("/organization/invitations/accept")
        .set("X-Forwarded-For", ip)
        .send(body);
    }
    const res = await request(app.getHttpServer())
      .post("/organization/invitations/accept")
      .set("X-Forwarded-For", ip)
      .send(body);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      code: "AUTH_RATE_LIMITED",
      details: { retryAfterSeconds: expect.any(Number) },
    });
  });

  it("POST /organization/invitations/accept reachable without JWT for new user path (no 401)", async () => {
    const res = await request(app.getHttpServer())
      .post("/organization/invitations/accept")
      .send({ token: "some-valid-looking-token", firstName: "Jane", lastName: "Doe" });
    expect(res.status).not.toBe(401);
  });
});
