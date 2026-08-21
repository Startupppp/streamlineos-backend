import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../../test/helpers/sign-token";

describe("HR Config auth/RBAC (e2e)", () => {
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

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/hr/departments"],
    ["post", "/hr/departments"],
    ["get", "/hr/holidays/calendar"],
    ["patch", "/hr/holidays/1"],
    ["delete", "/hr/holidays/1"],
    ["get", "/hr/leaves/blackout"],
    ["post", "/hr/leaves/blackout"],
    ["delete", "/hr/leaves/blackout/1"],
    ["get", "/hr/document-types"],
    ["post", "/hr/document-types"],
    ["get", "/hr/document-types/1"],
    ["patch", "/hr/document-types/1"],
    ["delete", "/hr/document-types/1"],
    ["get", "/hr/documents/templates"],
    ["post", "/hr/documents/templates"],
    ["get", "/hr/documents/templates/1"],
    ["get", "/hr/documents/templates/1/preview"],
    ["get", "/hr/documents/templates/1/versions"],
    ["patch", "/hr/documents/templates/1"],
    ["put", "/hr/documents/templates/1"],
    ["delete", "/hr/documents/templates/1"],
    ["get", "/hr/email-templates"],
    ["post", "/hr/email-templates"],
    ["patch", "/hr/email-templates/1"],
    ["delete", "/hr/email-templates/1"],
    ["get", "/hr/expenses/categories"],
    ["post", "/hr/expenses/categories"],
    ["get", "/hr/salary-structures"],
    ["post", "/hr/salary-structures"],
    ["get", "/hr/interview-questions"],
    ["post", "/hr/interview-questions"],
    ["patch", "/hr/interview-questions/1"],
    ["delete", "/hr/interview-questions/1"],
    ["get", "/hr/handbook"],
    ["post", "/hr/handbook"],
    ["patch", "/hr/handbook/1"],
    ["delete", "/hr/handbook/1"],
    ["get", "/hr/notification-preferences"],
    ["patch", "/hr/notification-preferences"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  const abilityGatedRoutes: ReadonlyArray<[Method, string]> = [
    ["post", "/hr/departments"],
    ["patch", "/hr/holidays/1"],
    ["delete", "/hr/holidays/1"],
    ["get", "/hr/leaves/blackout"],
    ["post", "/hr/leaves/blackout"],
    ["delete", "/hr/leaves/blackout/1"],
    ["post", "/hr/document-types"],
    ["patch", "/hr/document-types/1"],
    ["delete", "/hr/document-types/1"],
    ["post", "/hr/documents/templates"],
    ["patch", "/hr/documents/templates/1"],
    ["put", "/hr/documents/templates/1"],
    ["delete", "/hr/documents/templates/1"],
    ["get", "/hr/email-templates"],
    ["post", "/hr/email-templates"],
    ["patch", "/hr/email-templates/1"],
    ["delete", "/hr/email-templates/1"],
    ["post", "/hr/expenses/categories"],
    ["post", "/hr/salary-structures"],
    ["post", "/hr/interview-questions"],
    ["patch", "/hr/interview-questions/1"],
    ["delete", "/hr/interview-questions/1"],
    ["post", "/hr/handbook"],
    ["patch", "/hr/handbook/1"],
    ["delete", "/hr/handbook/1"],
  ];

  it.each(abilityGatedRoutes)(
    "403 on %s %s when authed without the required ability",
    async (method, path) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    },
  );
});
