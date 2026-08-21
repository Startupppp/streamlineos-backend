import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";

describe("Org auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
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

  const authedRoutes: ReadonlyArray<[Method, string]> = [["get", "/org/members"]];

  it.each(authedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on GET /org/members without directory:people:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await callRoute("get", "/org/members").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("passes the permission gate on GET /org/members with directory:people:view", async () => {
    const token = await signToken({ permissions: ["directory:people:view"], enabledModules: ALL_MODULES });
    const res = await callRoute("get", "/org/members").set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
