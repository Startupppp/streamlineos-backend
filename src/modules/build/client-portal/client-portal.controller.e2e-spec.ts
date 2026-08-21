import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../../test/helpers/sign-token";

describe("Client Portal / Change Requests / Client Visibility auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
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
    ["get", "/build/portal/projects"],
    ["get", "/build/portal/projects/1/overview"],
    ["get", "/build/portal/projects/1/change-requests"],
    ["post", "/build/portal/projects/1/change-requests"],
    ["get", "/build/1/change-requests"],
    ["get", "/build/1/change-requests/2"],
    ["post", "/build/1/change-requests"],
    ["patch", "/build/1/change-requests/2"],
    ["delete", "/build/1/change-requests/2"],
    ["get", "/build/1/client-visibility"],
    ["patch", "/build/1/client-visibility/tickets/2"],
    ["patch", "/build/1/client-visibility/milestones/2"],
    ["patch", "/build/1/client-visibility/comments/2"],
    ["patch", "/build/1/client-visibility/attachments/2"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on GET /projects/portal/projects without projects:portal:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/build/portal/projects")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/portal/projects/1/overview without projects:portal:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/build/portal/projects/1/overview")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/1/change-requests without projects:changerequests:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/build/1/change-requests")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/1/change-requests without projects:changerequests:create ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/build/1/change-requests")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Add OAuth" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /projects/1/change-requests/2 without projects:changerequests:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .patch("/build/1/change-requests/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "approved" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on DELETE /projects/1/change-requests/2 without projects:changerequests:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .delete("/build/1/change-requests/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/1/client-visibility without projects:clientvisibility:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/build/1/client-visibility")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /projects/1/client-visibility/tickets/2 without projects:clientvisibility:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .patch("/build/1/client-visibility/tickets/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientVisible: true });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("does NOT 401/403 on GET /projects/portal/projects with projects:portal:view ability", async () => {
    const token = await signToken({
      permissions: ["build:portal:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/build/portal/projects")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("does NOT 401/403 on POST /projects/1/change-requests with projects:changerequests:create ability", async () => {
    const token = await signToken({
      permissions: ["build:changerequests:create"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .post("/build/1/change-requests")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Add OAuth" });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("does NOT 401/403 on GET /projects/1/client-visibility with projects:clientvisibility:manage ability", async () => {
    const token = await signToken({
      permissions: ["build:clientvisibility:manage"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/client-visibility")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
