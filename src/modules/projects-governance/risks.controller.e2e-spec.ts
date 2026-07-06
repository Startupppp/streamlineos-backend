import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("ProjectsGovernance risks+decisions auth/RBAC (e2e)", () => {
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
    ["get", "/projects/1/risks"],
    ["get", "/projects/1/risks/2"],
    ["post", "/projects/1/risks"],
    ["patch", "/projects/1/risks/2"],
    ["delete", "/projects/1/risks/2"],
    ["get", "/projects/1/decisions"],
    ["get", "/projects/1/decisions/2"],
    ["post", "/projects/1/decisions"],
    ["patch", "/projects/1/decisions/2"],
    ["delete", "/projects/1/decisions/2"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on GET /projects/1/risks without projects:risks:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/1/risks")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "projects:risks" });
  });

  it("403 on GET /projects/1/risks/2 without projects:risks:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/1/risks/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "projects:risks" });
  });

  it("403 on POST /projects/1/risks without projects:risks:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/risks")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "DB failure risk" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "projects:risks" });
  });

  it("403 on PATCH /projects/1/risks/2 without projects:risks:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .patch("/projects/1/risks/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "mitigated" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "projects:risks" });
  });

  it("403 on DELETE /projects/1/risks/2 without projects:risks:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .delete("/projects/1/risks/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "projects:risks" });
  });

  it("403 on GET /projects/1/decisions without projects:decisions:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/1/decisions")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "projects:decisions" });
  });

  it("403 on GET /projects/1/decisions/2 without projects:decisions:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/1/decisions/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "projects:decisions" });
  });

  it("403 on POST /projects/1/decisions without projects:decisions:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/decisions")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Use PostgreSQL over MySQL" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "projects:decisions" });
  });

  it("403 on PATCH /projects/1/decisions/2 without projects:decisions:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .patch("/projects/1/decisions/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "accepted" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "projects:decisions" });
  });

  it("403 on DELETE /projects/1/decisions/2 without projects:decisions:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .delete("/projects/1/decisions/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "projects:decisions" });
  });

  it("does NOT enforce a gate on GET /projects/1/risks with projects:risks:view ability", async () => {
    const token = await signToken({
      permissions: ["projects:risks:view"],
      enabledModules: ["projects"],
    });
    const res = await request(app.getHttpServer())
      .get("/projects/1/risks")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("does NOT enforce a gate on GET /projects/1/decisions with projects:decisions:view ability", async () => {
    const token = await signToken({
      permissions: ["projects:decisions:view"],
      enabledModules: ["projects"],
    });
    const res = await request(app.getHttpServer())
      .get("/projects/1/decisions")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
