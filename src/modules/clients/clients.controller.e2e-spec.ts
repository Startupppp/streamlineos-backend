import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("Clients auth/RBAC (e2e)", () => {
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

  type Method = "get" | "post" | "put" | "patch" | "delete";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "put":
        return agent.put(path);
      case "patch":
        return agent.patch(path);
      case "delete":
        return agent.delete(path);
    }
  }

  const authedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/clients"],
    ["get", "/clients/list"],
    ["get", "/clients/health"],
    ["get", "/clients/churn-alerts"],
    ["get", "/clients/assign-crm"],
    ["post", "/clients/assign-crm"],
    ["get", "/clients/renewals"],
    ["patch", "/clients/renewals/1"],
    ["get", "/clients/opportunities"],
    ["post", "/clients/opportunities"],
    ["patch", "/clients/opportunities/1"],
    ["delete", "/clients/opportunities/1"],
    ["get", "/clients/onboarding/items"],
    ["post", "/clients/onboarding/items"],
    ["patch", "/clients/onboarding/items/1"],
    ["delete", "/clients/onboarding/items/1"],
    ["get", "/clients/onboarding/templates"],
    ["post", "/clients/onboarding/templates"],
    ["get", "/clients/1"],
    ["get", "/clients/1/activities"],
    ["post", "/clients/1/activities"],
    ["get", "/clients/1/timeline"],
  ];

  it.each(authedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  const authOnlyGetRoutes: ReadonlyArray<string> = [
    "/clients/list",
    "/clients/health",
    "/clients/churn-alerts",
    "/clients/assign-crm",
    "/clients/renewals",
    "/clients/opportunities",
    "/clients/onboarding/items",
    "/clients/onboarding/templates",
  ];

  it.each(authOnlyGetRoutes)(
    "does NOT enforce an ability gate on GET %s (auth-only)",
    async (path) => {
      const token = await signToken({ permissions: [], enabledModules: [] });
      const res = await callRoute("get", path).set("Authorization", `Bearer ${token}`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    },
  );
});
