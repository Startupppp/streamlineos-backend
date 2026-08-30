import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../test/helpers/sign-token";
import { effectiveRateLimit } from "../../common/ratelimit/rate-limit.service";

describe("Auth controller (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET ??= "e2e-test-internal-secret";
    app = await createE2eApp();
  });

  afterAll(async () => app.close());

  const publicPostRoutes: ReadonlyArray<string> = [
    "/auth/register",
    "/auth/verify-email",
    "/auth/resend-verification",
    "/auth/magic-link",
    "/auth/magic-link/verify",
    "/auth/email-otp",
    "/auth/email-otp/verify",
  ];

  it.each(publicPostRoutes)("POST %s is reachable without a JWT (not 401)", async (path) => {
    const res = await request(app.getHttpServer()).post(path).send({});
    expect(res.status).not.toBe(401);
  });

  const protectedPostRoutes: ReadonlyArray<string> = ["/auth/logout"];

  it.each(protectedPostRoutes)("401 on POST %s without a token", async (path) => {
    const res = await request(app.getHttpServer()).post(path).send({});
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("401 on GET /auth/audit/analytics without a token", async () => {
    const res = await request(app.getHttpServer()).get("/auth/audit/analytics");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on GET /auth/audit/analytics with valid JWT but no settings:manage permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: [...ALL_MODULES, "settings"] });
    const res = await request(app.getHttpServer())
      .get("/auth/audit/analytics")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("400 on POST /auth/register with an invalid email address", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ firstName: "A", email: "not-an-email", companyName: "Co" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_FAILED", message: "Validation failed." });
  });

  it("400 on POST /auth/register when companyName is missing", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ firstName: "A", email: "test@example.com" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_FAILED", message: "Validation failed." });
  });

  it("403 on GET /auth/session-data/:userId when x-internal-secret header is absent", async () => {
    const res = await request(app.getHttpServer()).get("/auth/session-data/user-abc");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Forbidden" });
  });

  it("403 on GET /auth/session-data/:userId when x-internal-secret header is wrong", async () => {
    const res = await request(app.getHttpServer())
      .get("/auth/session-data/user-abc")
      .set("x-internal-secret", "completely-wrong-value");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Forbidden" });
  });

  it("GET /auth/session-data/:userId with correct x-internal-secret is not 403", async () => {
    const correctSecret = process.env.INTERNAL_API_SECRET ?? "e2e-test-internal-secret";
    const res = await request(app.getHttpServer())
      .get("/auth/session-data/nonexistent-user")
      .set("x-internal-secret", correctSecret);
    expect(res.status).not.toBe(403);
  });

  it("429 on POST /auth/register after exhausting its rate limit", async () => {
    const ip = "10.0.1.11";
    const body = { firstName: "R", email: "rl-register@example.com", companyName: "Co" };
    for (let i = 0; i < effectiveRateLimit("auth:register"); i++) {
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

  it("429 on POST /auth/magic-link after exhausting its rate limit", async () => {
    const ip = "10.0.1.13";
    const body = { email: "rl-magic@example.com" };
    for (let i = 0; i < effectiveRateLimit("auth:magic-link"); i++) {
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
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Forbidden" });
  });

  it("POST /auth/google with wrong x-internal-secret returns 403", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/google")
      .set("x-internal-secret", "wrong")
      .send({ email: "g@example.com", googleId: "gid123" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Forbidden" });
  });
});
