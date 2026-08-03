import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { signToken } from "../../../../test/helpers/sign-token";

describe("ProjectsPortfolios/Programs auth/RBAC (e2e)", () => {
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
    ["get", "/projects/portfolios"],
    ["get", "/projects/portfolios/1"],
    ["post", "/projects/portfolios"],
    ["patch", "/projects/portfolios/1"],
    ["delete", "/projects/portfolios/1"],
    ["post", "/projects/portfolios/1/projects"],
    ["delete", "/projects/portfolios/1/projects/2"],
    ["get", "/projects/programs"],
    ["get", "/projects/programs/1"],
    ["post", "/projects/programs"],
    ["patch", "/projects/programs/1"],
    ["delete", "/projects/programs/1"],
    ["post", "/projects/programs/1/projects"],
    ["delete", "/projects/programs/1/projects/2"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on GET /projects/portfolios without projects:portfolios:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/portfolios")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "build:portfolios" });
  });

  it("403 on POST /projects/portfolios without projects:portfolios:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/portfolios")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Q3 Portfolio" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:portfolios" });
  });

  it("403 on POST /projects/portfolios/1/projects without projects:portfolios:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/portfolios/1/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ projectId: 5 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:portfolios" });
  });

  it("403 on GET /projects/programs without projects:programs:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/programs")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "build:programs" });
  });

  it("403 on POST /projects/programs without projects:programs:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/programs")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Alpha Program" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:programs" });
  });

  it("403 on POST /projects/programs/1/projects without projects:programs:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/programs/1/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ projectId: 7 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:programs" });
  });

  it("does NOT enforce manage gate on GET /projects/portfolios with view ability", async () => {
    const token = await signToken({
      permissions: ["build:portfolios:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/projects/portfolios")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
