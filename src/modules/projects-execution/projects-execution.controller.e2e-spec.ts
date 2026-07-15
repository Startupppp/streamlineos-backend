import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("ProjectsExecution auth/RBAC (e2e)", () => {
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
    ["get", "/projects/1/sprints"],
    ["post", "/projects/1/sprints"],
    ["get", "/projects/1/sprints/1"],
    ["patch", "/projects/1/sprints/1"],
    ["get", "/projects/1/cycles"],
    ["post", "/projects/1/cycles"],
    ["patch", "/projects/1/cycles/1"],
    ["delete", "/projects/1/cycles/1"],
    ["get", "/projects/1/modules"],
    ["post", "/projects/1/modules"],
    ["patch", "/projects/1/modules/1"],
    ["delete", "/projects/1/modules/1"],
    ["get", "/projects/1/epics"],
    ["post", "/projects/1/epics"],
    ["get", "/projects/1/milestones"],
    ["post", "/projects/1/milestones"],
    ["patch", "/projects/1/milestones/1"],
    ["delete", "/projects/1/milestones/1"],
    ["get", "/projects/1/intake"],
    ["post", "/projects/1/intake"],
    ["patch", "/projects/1/intake/1"],
    ["get", "/projects/1/views"],
    ["post", "/projects/1/views"],
    ["patch", "/projects/1/views/1"],
    ["delete", "/projects/1/views/1"],
    ["get", "/projects/1/whiteboards"],
    ["post", "/projects/1/whiteboards"],
    ["get", "/projects/1/whiteboards/1"],
    ["patch", "/projects/1/whiteboards/1"],
    ["delete", "/projects/1/whiteboards/1"],
    ["get", "/projects/1/pages"],
    ["post", "/projects/1/pages"],
    ["patch", "/projects/1/pages/1"],
    ["delete", "/projects/1/pages/1"],
    ["get", "/projects/time-entries"],
    ["get", "/projects/time-entries/team"],
    ["patch", "/projects/time-entries/1"],
    ["delete", "/projects/time-entries/1"],
    ["patch", "/projects/time-entries/1/approve"],
    ["patch", "/projects/time-entries/1/reject"],
    ["get", "/projects/billing-summary"],
    ["get", "/projects/1/tickets/1/time-entries"],
    ["post", "/projects/1/tickets/1/time-entries"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("404 MODULE_DISABLED on POST /projects/1/sprints when projects module is off", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/sprints")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "MODULE_DISABLED", module: "projects" });
  });

  it("403 on POST /projects/1/sprints without projects:sprints manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["projects"] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/sprints")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "projects:sprints" });
  });

  it("403 on GET /projects/time-entries/team without projects:timesheets manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/time-entries/team")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only admins can view team timesheets" });
  });

  it("403 on PATCH /projects/time-entries/1/approve without projects:timesheets manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .patch("/projects/time-entries/1/approve")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only admins can approve timesheets" });
  });
});
