import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("ProjectsMeetings / ActionItems auth/RBAC (e2e)", () => {
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

  type Method = "get" | "post" | "patch" | "delete" | "put";

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
      case "put":
        return agent.put(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/projects/1/meetings"],
    ["get", "/projects/1/meetings/2"],
    ["post", "/projects/1/meetings"],
    ["patch", "/projects/1/meetings/2"],
    ["delete", "/projects/1/meetings/2"],
    ["post", "/projects/1/meetings/2/attendees"],
    ["delete", "/projects/1/meetings/2/attendees/user-x"],
    ["put", "/projects/1/meetings/2/standup"],
    ["post", "/projects/1/meetings/2/action-items"],
    ["patch", "/projects/1/meetings/2/action-items/3"],
    ["delete", "/projects/1/meetings/2/action-items/3"],
    ["post", "/projects/1/meetings/2/action-items/3/convert-to-task"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on GET /projects/1/meetings without projects:meetings:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/1/meetings")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "build:meetings" });
  });

  it("403 on POST /projects/1/meetings without projects:meetings:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/meetings")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Sprint Review" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:meetings" });
  });

  it("403 on DELETE /projects/1/meetings/2 without projects:meetings:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .delete("/projects/1/meetings/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:meetings" });
  });

  it("403 on POST /projects/1/meetings/2/attendees without projects:meetings:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/meetings/2/attendees")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: "user-3" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:meetings" });
  });

  it("403 on PUT /projects/1/meetings/2/standup without projects:meetings:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .put("/projects/1/meetings/2/standup")
      .set("Authorization", `Bearer ${token}`)
      .send({ today: "finishing tests" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "build:meetings" });
  });

  it("403 on POST /projects/1/meetings/2/action-items without projects:meetings:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/meetings/2/action-items")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Write docs" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:meetings" });
  });

  it("403 on POST convert-to-task without projects:meetings:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/meetings/2/action-items/3/convert-to-task")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "build:meetings" });
  });

  it("does NOT 401/403 on GET /projects/1/meetings with projects:meetings:view ability", async () => {
    const token = await signToken({
      permissions: ["build:meetings:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/projects/1/meetings")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("does NOT 401/403 on POST /projects/1/meetings with projects:meetings:manage ability", async () => {
    const token = await signToken({
      permissions: ["build:meetings:manage"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .post("/projects/1/meetings")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Sprint Review" });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
