import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("ProjectsWorkflow auth/RBAC (e2e)", () => {
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
    ["get", "/projects/1/workflow/transitions"],
    ["post", "/projects/1/workflow/transitions"],
    ["patch", "/projects/1/workflow/transitions/2"],
    ["delete", "/projects/1/workflow/transitions/2"],
    ["get", "/projects/1/workflow/allowed/3"],
    ["patch", "/projects/1/workflow/statuses/4/wip"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on GET /projects/1/workflow/transitions without projects:workflow:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/1/workflow/transitions")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "projects:workflow" });
  });

  it("403 on POST /projects/1/workflow/transitions without projects:workflow:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/workflow/transitions")
      .set("Authorization", `Bearer ${token}`)
      .send({ toStatusId: 2 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "projects:workflow" });
  });

  it("403 on PATCH /projects/1/workflow/transitions/2 without projects:workflow:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .patch("/projects/1/workflow/transitions/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Updated" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "projects:workflow" });
  });

  it("403 on GET /projects/1/workflow/allowed/3 without projects:workflow:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/1/workflow/allowed/3")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "projects:workflow" });
  });

  it("403 on PATCH /projects/1/workflow/statuses/4/wip without projects:workflow:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .patch("/projects/1/workflow/statuses/4/wip")
      .set("Authorization", `Bearer ${token}`)
      .send({ wipLimit: 3 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "projects:workflow" });
  });

  it("does NOT enforce manage gate on GET /projects/1/workflow/transitions with view ability", async () => {
    const token = await signToken({
      permissions: ["projects:workflow:view"],
      enabledModules: ["projects"],
    });
    const res = await request(app.getHttpServer())
      .get("/projects/1/workflow/transitions")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
