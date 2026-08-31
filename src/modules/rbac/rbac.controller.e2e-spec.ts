import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";

describe("Rbac auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch" | "put" | "delete";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "patch":
        return agent.patch(path);
      case "put":
        return agent.put(path);
      case "delete":
        return agent.delete(path);
    }
  }

  const authedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/rbac/permissions"],
    ["post", "/rbac/role-permissions"],
    ["delete", "/rbac/role-permissions"],
    ["get", "/roles"],
    ["get", "/roles/analytics"],
    ["get", "/roles/templates"],
    ["get", "/roles/1"],
    ["patch", "/roles/1"],
    ["delete", "/roles/1"],
    ["get", "/roles/1/permissions"],
    ["put", "/roles/1/permissions"],
    ["get", "/roles/1/members"],
    ["post", "/roles/1/members"],
    ["delete", "/roles/1/members"],
  ];

  it.each(authedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on GET /rbac/permissions without settings:rbac:manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["settings"] });
    const res = await callRoute("get", "/rbac/permissions").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("returns the static permission catalog on GET /rbac/permissions with settings:rbac:manage", async () => {
    const token = await signToken({ permissions: ["settings:rbac:manage"], enabledModules: ["settings"] });
    const res = await callRoute("get", "/rbac/permissions").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("returns the static role templates on GET /roles/templates (auth-only, DB-free)", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await callRoute("get", "/roles/templates").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });
});
