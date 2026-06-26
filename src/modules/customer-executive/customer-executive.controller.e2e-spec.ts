import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("CustomerExecutive auth/RBAC (e2e)", () => {
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
    ["get", "/customer-executive/health"],
    ["get", "/customer-executive/health/config"],
    ["put", "/customer-executive/health/config"],
    ["post", "/customer-executive/health/recompute"],
    ["get", "/customer-executive/nps"],
    ["post", "/customer-executive/nps"],
    ["get", "/customer-executive/nps/stats"],
    ["get", "/customer-executive/nps/1"],
    ["patch", "/customer-executive/nps/1"],
    ["delete", "/customer-executive/nps/1"],
    ["get", "/customer-executive/sla"],
  ];

  it.each(authedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  const abilityGatedRoutes: ReadonlyArray<[Method, string, string]> = [
    ["get", "/customer-executive/health", "read"],
    ["get", "/customer-executive/health/config", "read"],
    ["put", "/customer-executive/health/config", "update"],
    ["post", "/customer-executive/health/recompute", "update"],
    ["get", "/customer-executive/nps", "read"],
    ["post", "/customer-executive/nps", "manage"],
    ["get", "/customer-executive/nps/stats", "read"],
    ["get", "/customer-executive/nps/1", "read"],
    ["patch", "/customer-executive/nps/1", "manage"],
    ["delete", "/customer-executive/nps/1", "manage"],
  ];

  it.each(abilityGatedRoutes)(
    "403 on %s %s without crm:clients %s",
    async (method, path, verb) => {
      const token = await signToken({ permissions: [], enabledModules: [] });
      const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb, subject: "crm:clients" });
    },
  );

  it("does NOT require an ability on GET /customer-executive/sla (auth-only)", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await callRoute("get", "/customer-executive/sla").set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
