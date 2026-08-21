import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../test/helpers/sign-token";

describe("Goals auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch" | "delete";
  const routes: ReadonlyArray<[Method, string]> = [
    ["get", "/goals"],
    ["post", "/goals"],
    ["get", "/goals/stats"],
    ["get", "/goals/1"],
    ["patch", "/goals/1"],
    ["delete", "/goals/1"],
    ["post", "/goals/1/check-in"],
    ["get", "/goals/1/key-results"],
    ["post", "/goals/1/key-results"],
    ["get", "/goals/1/links"],
    ["post", "/goals/1/links"],
    ["delete", "/goals/1/links"],
    ["patch", "/goals/key-results/1"],
    ["delete", "/goals/key-results/1"],
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

  it("403 on GET /goals without projects:goals view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/goals")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /goals without projects:goals manage", async () => {
    const token = await signToken({ permissions: ["build:goals:view"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/goals")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});
