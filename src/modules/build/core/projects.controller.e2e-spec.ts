import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "../../../../test/helpers/sign-token";

describe("Projects auth/RBAC (e2e)", () => {
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
    ["get", "/build"],
    ["post", "/build"],
    ["post", "/build/from-deal"],
    ["get", "/build/labels"],
    ["post", "/build/labels"],
    ["get", "/build/resource-allocation"],
    ["get", "/build/1"],
    ["patch", "/build/1"],
    ["delete", "/build/1"],
    ["get", "/build/1/members"],
    ["post", "/build/1/members"],
    ["delete", "/build/1/members"],
    ["get", "/build/1/custom-states"],
    ["post", "/build/1/custom-states"],
    ["get", "/build/1/labels"],
    ["post", "/build/1/labels"],
    ["get", "/build/1/tickets"],
    ["post", "/build/1/tickets"],
    ["post", "/build/1/tickets/bulk"],
    ["patch", "/build/1/tickets/2/rank"],
    ["get", "/build/1/tickets/2"],
    ["patch", "/build/1/tickets/2"],
    ["delete", "/build/1/tickets/2"],
    ["get", "/build/1/tickets/2/activity"],
    ["post", "/build/1/tickets/2/comments"],
    ["get", "/build/1/tickets/2/subtasks"],
    ["get", "/build/1/tickets/2/relations"],
    ["post", "/build/1/tickets/2/relations"],
    ["delete", "/build/1/tickets/2/relations"],
    ["get", "/build/1/tickets/2/watchers"],
    ["post", "/build/1/tickets/2/watchers"],
    ["delete", "/build/1/tickets/2/watchers"],
    ["post", "/build/1/tickets/2/labels"],
    ["delete", "/build/1/tickets/2/labels/3"],
    ["post", "/build/1/tickets/2/attachments"],
    ["get", "/build/1/tickets/2/git-links"],
    ["get", "/build/1/analytics"],
    ["get", "/build/1/reports/burnup"],
    ["get", "/build/1/reports/cfd"],
    ["get", "/build/1/reports/critical-path"],
    ["get", "/build/1/reports/velocity"],
    ["post", "/build/1/reports/snapshot"],
    ["get", "/build/1/budget"],
    ["patch", "/build/1/budget"],
    ["get", "/build/templates"],
    ["post", "/build/templates"],
    ["delete", "/build/templates/1"],
    ["post", "/build/templates/1/apply"],
    ["get", "/build/roadmap"],
    ["post", "/build/roadmap"],
    ["get", "/build/roadmap/1"],
    ["patch", "/build/roadmap/1"],
    ["delete", "/build/roadmap/1"],
    ["get", "/build/feedback"],
    ["post", "/build/feedback"],
    ["get", "/build/feedback/1"],
    ["patch", "/build/feedback/1"],
    ["delete", "/build/feedback/1"],
    ["get", "/build/changelog"],
    ["post", "/build/changelog"],
    ["get", "/build/changelog/1"],
    ["patch", "/build/changelog/1"],
    ["delete", "/build/changelog/1"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on POST /projects without projects create ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/build")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "x" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/roadmap without projects:roadmap view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/build/roadmap")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/changelog without projects:roadmap manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/build/changelog")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "x" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("does NOT enforce an ability gate on GET /projects (auth-only)", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer()).get("/build").set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
