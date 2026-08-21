import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { RateLimitService } from "../../../common/ratelimit/rate-limit.service";

describe("Invitations auth/routing (e2e)", () => {
  let app: INestApplication;
  const rateLimitCheck = jest.fn().mockResolvedValue({
    allowed: true,
    retryAfterSecs: 0,
  });

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: RateLimitService, useValue: { check: rateLimitCheck } }],
    });
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
    ["get", "/users/invitations"],
    ["post", "/users/invite"],
    ["delete", "/users/invitations/invitation-id"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path).send({});
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("400 on POST /organization/invitations/accept when token field is missing", async () => {
    const res = await request(app.getHttpServer())
      .post("/organization/invitations/accept")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it(
    "429 on POST /organization/invitations/accept when the rate limit is exhausted",
    async () => {
      rateLimitCheck.mockResolvedValueOnce({
        allowed: false,
        retryAfterSecs: 60,
      });
      const ip = "10.0.2.11";
      const body = { token: "test-rate-limit-token" };
      const res = await request(app.getHttpServer())
        .post("/organization/invitations/accept")
        .set("X-Forwarded-For", ip)
        .send(body);
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({
        code: "AUTH_RATE_LIMITED",
        details: { retryAfterSeconds: expect.any(Number) },
      });
    },
    20_000,
  );

  it("POST /organization/invitations/accept reachable without JWT for new user path (no 401)", async () => {
    const res = await request(app.getHttpServer())
      .post("/organization/invitations/accept")
      .send({ token: "some-valid-looking-token", firstName: "Jane", lastName: "Doe" });
    expect(res.status).not.toBe(401);
  });
});
