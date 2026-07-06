import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("ProjectsApprovals auth/RBAC (e2e)", () => {
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
    ["get", "/projects/approvals/inbox"],
    ["get", "/projects/1/approvals"],
    ["get", "/projects/1/approvals/2"],
    ["post", "/projects/1/approvals"],
    ["patch", "/projects/1/approvals/2/decide"],
    ["patch", "/projects/1/approvals/2"],
    ["delete", "/projects/1/approvals/2"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on GET /projects/approvals/inbox without projects:approvals:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/approvals/inbox")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "projects:approvals" });
  });

  it("403 on GET /projects/1/approvals without projects:approvals:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/projects/1/approvals")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "view", subject: "projects:approvals" });
  });

  it("403 on POST /projects/1/approvals without projects:approvals:request ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/projects/1/approvals")
      .set("Authorization", `Bearer ${token}`)
      .send({ entityType: "ticket", entityId: 1, title: "Review", approverId: "user-2" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "request", subject: "projects:approvals" });
  });

  it("403 on PATCH /projects/1/approvals/2/decide without projects:approvals:decide ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .patch("/projects/1/approvals/2/decide")
      .set("Authorization", `Bearer ${token}`)
      .send({ decision: "approved" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "decide", subject: "projects:approvals" });
  });

  it("403 on PATCH /projects/1/approvals/2 without projects:approvals:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .patch("/projects/1/approvals/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "escalated" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "projects:approvals" });
  });

  it("403 on DELETE /projects/1/approvals/2 without projects:approvals:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .delete("/projects/1/approvals/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "projects:approvals" });
  });

  it("does NOT enforce a gate on GET /projects/1/approvals with projects:approvals:view ability", async () => {
    const token = await signToken({
      permissions: ["projects:approvals:view"],
      enabledModules: ["projects"],
    });
    const res = await request(app.getHttpServer())
      .get("/projects/1/approvals")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("does NOT enforce a gate on POST /projects/1/approvals with projects:approvals:request ability", async () => {
    const token = await signToken({
      permissions: ["projects:approvals:request"],
      enabledModules: ["projects"],
    });
    const res = await request(app.getHttpServer())
      .post("/projects/1/approvals")
      .set("Authorization", `Bearer ${token}`)
      .send({ entityType: "ticket", entityId: 1, title: "Review", approverId: "user-2" });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
