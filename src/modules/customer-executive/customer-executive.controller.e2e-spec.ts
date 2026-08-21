import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";

describe("CustomerExecutive auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
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
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  const abilityGatedRoutes: ReadonlyArray<[Method, string]> = [
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
  ];

  it.each(abilityGatedRoutes)(
    "403 on %s %s without crm:clients permission",
    async (method, path) => {
      const token = await signToken({ permissions: [], enabledModules: ["crm"] });
      const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    },
  );

  it("does NOT require an ability on GET /customer-executive/sla (auth-only)", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await callRoute("get", "/customer-executive/sla").set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
