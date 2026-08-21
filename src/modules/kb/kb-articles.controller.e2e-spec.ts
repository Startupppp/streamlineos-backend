import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { KbIndexingService } from "../../modules/kb/kb-indexing.service";

describe("KB Articles auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: KbIndexingService, useValue: {} }],
    });
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch" | "delete";

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

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/articles"],
    ["post", "/kb/articles"],
    ["get", "/kb/articles/1"],
    ["patch", "/kb/articles/1"],
    ["delete", "/kb/articles/1"],
    ["post", "/kb/articles/1/publish"],
    ["post", "/kb/articles/1/unpublish"],
    ["post", "/kb/articles/1/verify"],
    ["post", "/kb/articles/1/vote"],
    ["post", "/kb/articles/1/view"],
    ["get", "/kb/articles/1/versions"],
    ["post", "/kb/articles/1/versions/1/restore"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  const abilities: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/articles"],
    ["post", "/kb/articles"],
    ["patch", "/kb/articles/1"],
    ["delete", "/kb/articles/1"],
    ["post", "/kb/articles/1/publish"],
  ];

  it.each(abilities)("402 on %s %s when the kb module is not enabled", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: "MODULE_NOT_ENABLED", details: { moduleKey: "kb" } });
  });

  it.each(abilities)("403 on %s %s without permission", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ["kb"] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});
