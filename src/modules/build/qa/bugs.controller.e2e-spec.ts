import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { signToken } from "../../../../test/helpers/sign-token";

describe("ProjectsQA bugs auth/RBAC (e2e)", () => {
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
    ["get", "/projects/1/bugs"],
    ["get", "/projects/1/bugs/2"],
    ["post", "/projects/1/bugs"],
    ["patch", "/projects/1/bugs/2"],
    ["delete", "/projects/1/bugs/2"],
    ["get", "/projects/1/test-suites"],
    ["post", "/projects/1/test-suites"],
    ["patch", "/projects/1/test-suites/2"],
    ["delete", "/projects/1/test-suites/2"],
    ["get", "/projects/1/test-cases"],
    ["get", "/projects/1/test-cases/2"],
    ["post", "/projects/1/test-cases"],
    ["patch", "/projects/1/test-cases/2"],
    ["delete", "/projects/1/test-cases/2"],
    ["get", "/projects/1/test-runs"],
    ["get", "/projects/1/test-runs/2"],
    ["post", "/projects/1/test-runs"],
    ["patch", "/projects/1/test-runs/2"],
    ["delete", "/projects/1/test-runs/2"],
    ["patch", "/projects/1/test-runs/2/results/3"],
    ["post", "/projects/1/test-runs/2/results/3/bug"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on GET /projects/1/bugs without projects:bugs:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/1/bugs")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "build:bugs" });
  });

  it("403 on GET /projects/1/bugs/2 without projects:bugs:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/1/bugs/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "build:bugs" });
  });

  it("403 on POST /projects/1/bugs without projects:bugs:create ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/bugs")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Login button crash" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "create", subject: "build:bugs" });
  });

  it("403 on PATCH /projects/1/bugs/2 without projects:bugs:update ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .patch("/projects/1/bugs/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "fixed" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "update", subject: "build:bugs" });
  });

  it("403 on DELETE /projects/1/bugs/2 without projects:bugs:delete ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .delete("/projects/1/bugs/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "delete", subject: "build:bugs" });
  });

  it("403 on GET /projects/1/test-suites without projects:qa:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/1/test-suites")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "build:qa" });
  });

  it("403 on POST /projects/1/test-suites without projects:qa:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/test-suites")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Smoke Tests" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:qa" });
  });

  it("403 on GET /projects/1/test-cases without projects:qa:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/1/test-cases")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "build:qa" });
  });

  it("403 on POST /projects/1/test-cases without projects:qa:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/test-cases")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Verify login flow" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:qa" });
  });

  it("403 on POST /projects/1/test-runs without projects:qa:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/test-runs")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Sprint 1 Run", caseIds: [] });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:qa" });
  });

  it("403 on PATCH /projects/1/test-runs/2/results/3 without projects:qa:execute ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .patch("/projects/1/test-runs/2/results/3")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "passed" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "execute", subject: "build:qa" });
  });

  it("does NOT enforce a gate on GET /projects/1/bugs with projects:bugs:view ability", async () => {
    const token = await signToken({
      permissions: ["build:bugs:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/projects/1/bugs")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("does NOT enforce a gate on GET /projects/1/test-suites with projects:qa:view ability", async () => {
    const token = await signToken({
      permissions: ["build:qa:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/projects/1/test-suites")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
