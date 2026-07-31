import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { signToken } from "../../../../test/helpers/sign-token";

describe("ProjectsIncidents auth/RBAC (e2e)", () => {
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
    ["get", "/projects/1/incidents"],
    ["get", "/projects/1/incidents/2"],
    ["post", "/projects/1/incidents"],
    ["patch", "/projects/1/incidents/2"],
    ["delete", "/projects/1/incidents/2"],
    ["post", "/projects/1/incidents/2/updates"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on GET /projects/1/incidents without projects:incidents:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/1/incidents")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "build:incidents" });
  });

  it("403 on GET /projects/1/incidents/2 without projects:incidents:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/1/incidents/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "build:incidents" });
  });

  it("403 on POST /projects/1/incidents without projects:incidents:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/incidents")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "DB replication lag" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:incidents" });
  });

  it("403 on PATCH /projects/1/incidents/2 without projects:incidents:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .patch("/projects/1/incidents/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "investigating" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:incidents" });
  });

  it("403 on DELETE /projects/1/incidents/2 without projects:incidents:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .delete("/projects/1/incidents/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:incidents" });
  });

  it("403 on POST /projects/1/incidents/2/updates without projects:incidents:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/incidents/2/updates")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Investigated root cause" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:incidents" });
  });

  it("does NOT 401/403 on GET /projects/1/incidents with projects:incidents:view ability", async () => {
    const token = await signToken({
      permissions: ["build:incidents:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/projects/1/incidents")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("does NOT 401/403 on POST /projects/1/incidents with projects:incidents:manage ability", async () => {
    const token = await signToken({
      permissions: ["build:incidents:manage"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .post("/projects/1/incidents")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "DB replication lag" });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
