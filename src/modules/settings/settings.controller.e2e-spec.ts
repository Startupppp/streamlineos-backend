import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("Settings auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch" | "delete";
  const routes: ReadonlyArray<[Method, string]> = [
    ["get", "/settings/ai-usage"],
    ["get", "/settings/api-keys"],
    ["post", "/settings/api-keys"],
    ["delete", "/settings/api-keys/abc"],
    ["get", "/settings/automations"],
    ["post", "/settings/automations"],
    ["get", "/settings/automations/1"],
    ["patch", "/settings/automations/1"],
    ["delete", "/settings/automations/1"],
    ["get", "/settings/automations/1/runs"],
    ["get", "/settings/custom-fields"],
    ["post", "/settings/custom-fields"],
    ["patch", "/settings/custom-fields/1"],
    ["delete", "/settings/custom-fields/1"],
    ["get", "/settings/feature-flags"],
    ["patch", "/settings/feature-flags"],
    ["get", "/settings/integrations/git"],
    ["post", "/settings/integrations/git"],
    ["patch", "/settings/integrations/git/1"],
    ["delete", "/settings/integrations/git/1"],
    ["post", "/settings/users/u1/role"],
  ];

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "patch":
        return agent.patch(path);
      case "delete":
        return agent.delete(path);
    }
  }

  it.each(routes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });
});
