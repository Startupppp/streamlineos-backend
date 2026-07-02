import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("Auth controller (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    process.env.INTERNAL_API_SECRET ??= "e2e-test-internal-secret";
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  const publicPostRoutes: ReadonlyArray<string> = [
    "/auth/register",
    "/auth/login",
    "/auth/forgot-password",
    "/auth/reset-password",
    "/auth/verify-email",
    "/auth/resend-verification",
    "/auth/magic-link",
    "/auth/magic-link/verify",
  ];

  it.each(publicPostRoutes)("POST %s is reachable without a JWT (not 401)", async (path) => {
    const res = await request(app.getHttpServer()).post(path).send({});
    expect(res.status).not.toBe(401);
  });

  const protectedPostRoutes: ReadonlyArray<string> = ["/auth/force-change-password", "/auth/logout"];

  it.each(protectedPostRoutes)("401 on POST %s without a token", async (path) => {
    const res = await request(app.getHttpServer()).post(path).send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("401 on GET /auth/audit/analytics without a token", async () => {
    const res = await request(app.getHttpServer()).get("/auth/audit/analytics");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on GET /auth/audit/analytics with valid JWT but no settings:manage permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/auth/audit/analytics")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("400 on POST /auth/register when password is shorter than 8 characters", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ firstName: "A", email: "test@example.com", password: "Aa1!", companyName: "Co" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Validation failed") });
  });

  it("400 on POST /auth/register when password has no uppercase letter", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ firstName: "A", email: "test@example.com", password: "test@1234", companyName: "Co" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Validation failed") });
  });

  it("400 on POST /auth/register when password has no special character", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ firstName: "A", email: "test@example.com", password: "TestAbcd1", companyName: "Co" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Validation failed") });
  });

  it("400 on POST /auth/register with an invalid email address", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ firstName: "A", email: "not-an-email", password: "Test@1234", companyName: "Co" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Validation failed") });
  });

  it("400 on POST /auth/register when companyName is missing", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ firstName: "A", email: "test@example.com", password: "Test@1234" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Validation failed") });
  });

  it("400 on POST /auth/register when password has no number", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ firstName: "A", email: "test@example.com", password: "Test@abcd", companyName: "Co" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Validation failed") });
  });

  it("403 on GET /auth/session-data/:userId when x-internal-secret header is absent", async () => {
    const res = await request(app.getHttpServer()).get("/auth/session-data/user-abc");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("403 on GET /auth/session-data/:userId when x-internal-secret header is wrong", async () => {
    const res = await request(app.getHttpServer())
      .get("/auth/session-data/user-abc")
      .set("x-internal-secret", "completely-wrong-value");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("GET /auth/session-data/:userId with correct x-internal-secret is not 403", async () => {
    const correctSecret = process.env.INTERNAL_API_SECRET ?? "e2e-test-internal-secret";
    const res = await request(app.getHttpServer())
      .get("/auth/session-data/nonexistent-user")
      .set("x-internal-secret", correctSecret);
    expect(res.status).not.toBe(403);
  });

  it("429 on POST /auth/register after exhausting the 3-per-minute rate limit", async () => {
    const ip = "10.0.1.11";
    const body = {
      firstName: "R",
      email: "rl-register@example.com",
      password: "Test@1234!",
      companyName: "Co",
    };
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post("/auth/register")
        .set("X-Forwarded-For", ip)
        .send(body);
    }
    const res = await request(app.getHttpServer())
      .post("/auth/register")
      .set("X-Forwarded-For", ip)
      .send(body);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      code: "AUTH_RATE_LIMITED",
      details: { retryAfterSeconds: expect.any(Number) },
    });
  });

  it("429 on POST /auth/login after exhausting the 5-per-minute rate limit", async () => {
    const ip = "10.0.1.12";
    const body = { email: "rl-login@example.com", password: "anyPassword" };
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post("/auth/login")
        .set("X-Forwarded-For", ip)
        .send(body);
    }
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", ip)
      .send(body);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      code: "AUTH_RATE_LIMITED",
      details: { retryAfterSeconds: expect.any(Number) },
    });
  });

  it("429 on POST /auth/magic-link after exhausting the 3-per-minute rate limit", async () => {
    const ip = "10.0.1.13";
    const body = { email: "rl-magic@example.com" };
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post("/auth/magic-link")
        .set("X-Forwarded-For", ip)
        .send(body);
    }
    const res = await request(app.getHttpServer())
      .post("/auth/magic-link")
      .set("X-Forwarded-For", ip)
      .send(body);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      code: "AUTH_RATE_LIMITED",
      details: { retryAfterSeconds: expect.any(Number) },
    });
  });

  it("POST /auth/google without x-internal-secret returns 403", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/google")
      .send({ email: "g@example.com", googleId: "gid123" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("POST /auth/google with wrong x-internal-secret returns 403", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/google")
      .set("x-internal-secret", "wrong")
      .send({ email: "g@example.com", googleId: "gid123" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });
});
