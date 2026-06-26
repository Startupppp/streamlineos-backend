import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("Projects auth/RBAC (e2e)", () => {
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
    ["get", "/projects"],
    ["post", "/projects"],
    ["post", "/projects/from-deal"],
    ["get", "/projects/labels"],
    ["post", "/projects/labels"],
    ["get", "/projects/resource-allocation"],
    ["get", "/projects/1"],
    ["patch", "/projects/1"],
    ["delete", "/projects/1"],
    ["get", "/projects/1/members"],
    ["post", "/projects/1/members"],
    ["delete", "/projects/1/members"],
    ["get", "/projects/1/custom-states"],
    ["post", "/projects/1/custom-states"],
    ["get", "/projects/1/labels"],
    ["post", "/projects/1/labels"],
    ["get", "/projects/1/tickets"],
    ["post", "/projects/1/tickets"],
    ["post", "/projects/1/tickets/bulk"],
    ["patch", "/projects/1/tickets/reorder"],
    ["get", "/projects/1/tickets/2"],
    ["patch", "/projects/1/tickets/2"],
    ["delete", "/projects/1/tickets/2"],
    ["get", "/projects/1/tickets/2/activity"],
    ["post", "/projects/1/tickets/2/comments"],
    ["get", "/projects/1/tickets/2/subtasks"],
    ["get", "/projects/1/tickets/2/relations"],
    ["post", "/projects/1/tickets/2/relations"],
    ["delete", "/projects/1/tickets/2/relations"],
    ["get", "/projects/1/tickets/2/watchers"],
    ["post", "/projects/1/tickets/2/watchers"],
    ["delete", "/projects/1/tickets/2/watchers"],
    ["post", "/projects/1/tickets/2/labels"],
    ["delete", "/projects/1/tickets/2/labels/3"],
    ["post", "/projects/1/tickets/2/attachments"],
    ["get", "/projects/1/tickets/2/git-links"],
    ["get", "/projects/1/analytics"],
    ["get", "/projects/1/reports/burnup"],
    ["get", "/projects/1/reports/cfd"],
    ["get", "/projects/1/reports/critical-path"],
    ["get", "/projects/1/reports/velocity"],
    ["post", "/projects/1/reports/snapshot"],
    ["get", "/projects/1/budget"],
    ["patch", "/projects/1/budget"],
    ["get", "/projects/templates"],
    ["post", "/projects/templates"],
    ["delete", "/projects/templates/1"],
    ["post", "/projects/templates/1/apply"],
    ["get", "/projects/roadmap"],
    ["post", "/projects/roadmap"],
    ["get", "/projects/roadmap/1"],
    ["patch", "/projects/roadmap/1"],
    ["delete", "/projects/roadmap/1"],
    ["get", "/projects/feedback"],
    ["post", "/projects/feedback"],
    ["get", "/projects/feedback/1"],
    ["patch", "/projects/feedback/1"],
    ["delete", "/projects/feedback/1"],
    ["get", "/projects/changelog"],
    ["post", "/projects/changelog"],
    ["get", "/projects/changelog/1"],
    ["patch", "/projects/changelog/1"],
    ["delete", "/projects/changelog/1"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on POST /projects without projects create ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "x" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "create", subject: "projects" });
  });

  it("403 on GET /projects/roadmap without projects:roadmap view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/roadmap")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "projects:roadmap" });
  });

  it("403 on POST /projects/changelog without projects:roadmap manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/changelog")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "x" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "projects:roadmap" });
  });

  it("does NOT enforce an ability gate on GET /projects (auth-only)", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer()).get("/projects").set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
