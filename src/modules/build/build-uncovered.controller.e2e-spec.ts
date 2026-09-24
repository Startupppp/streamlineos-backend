import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";

const PROJECT_ID = "1";
const TEAM_ID = "1";

describe("Build module uncovered controllers auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => {
    await app.close();
  });

  type Method = "get" | "post" | "patch" | "delete";

  function call(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get": return agent.get(path);
      case "post": return agent.post(path);
      case "patch": return agent.patch(path);
      case "delete": return agent.delete(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/build/teams"],
    ["post", "/build/teams"],
    [`get`, `/build/teams/${TEAM_ID}`],
    ["get", "/build/comment-drafts"],
    [`get`, `/build/${PROJECT_ID}/test-cases`],
    [`post`, `/build/${PROJECT_ID}/test-cases`],
    [`get`, `/build/${PROJECT_ID}/test-runs`],
    [`post`, `/build/${PROJECT_ID}/test-runs`],
    [`get`, `/build/${PROJECT_ID}/test-suites`],
    [`post`, `/build/${PROJECT_ID}/test-suites`],
    [`get`, `/build/${PROJECT_ID}/bugs`],
    [`post`, `/build/${PROJECT_ID}/bugs`],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await call(method, path);
    expect(res.status).toBe(401);
  });

  it.each(protectedRoutes)("403 on %s %s without required permission", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await call(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on POST /build/teams without build:teams:create", async () => {
    const token = await signToken({
      permissions: ["build:teams:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/build/teams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Dev Team" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on POST /build/:projectId/test-cases without build:qa:manage", async () => {
    const token = await signToken({
      permissions: ["build:qa:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post(`/build/${PROJECT_ID}/test-cases`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Login works" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on POST /build/:projectId/bugs without build:bugs:create", async () => {
    const token = await signToken({
      permissions: ["build:bugs:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post(`/build/${PROJECT_ID}/bugs`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Crash on login" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });
});
