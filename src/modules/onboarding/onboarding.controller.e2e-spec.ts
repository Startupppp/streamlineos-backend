import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("Onboarding auth/RBAC (e2e)", () => {
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

  type Method = "get" | "post" | "patch";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "patch":
        return agent.patch(path);
    }
  }

  const authedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/onboarding"],
    ["post", "/onboarding"],
    ["get", "/onboarding/templates"],
    ["post", "/onboarding/templates"],
    ["patch", "/onboarding/personal-details"],
    ["patch", "/onboarding/bank-details"],
    ["post", "/onboarding/submit"],
    ["get", "/onboarding/user_1"],
  ];

  it.each(authedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  const abilityGatedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/onboarding"],
    ["post", "/onboarding"],
    ["get", "/onboarding/templates"],
    ["post", "/onboarding/templates"],
  ];

  it.each(abilityGatedRoutes)(
    "403 on %s %s without settings:onboarding manage",
    async (method, path) => {
      const token = await signToken({ permissions: [], enabledModules: [] });
      const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: "RBAC_DENIED",
        verb: "manage",
        subject: "settings:onboarding",
      });
    },
  );

  const authOnlyRoutes: ReadonlyArray<[Method, string]> = [
    ["patch", "/onboarding/personal-details"],
    ["patch", "/onboarding/bank-details"],
    ["post", "/onboarding/submit"],
    ["get", "/onboarding/user_1"],
  ];

  it.each(authOnlyRoutes)(
    "does NOT require an ability on %s %s (auth-only)",
    async (method, path) => {
      const token = await signToken({ permissions: [], enabledModules: [] });
      const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    },
  );
});
