import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../../test/helpers/sign-token";

describe("HR Performance auth/RBAC (e2e)", () => {
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
    ["get", "/hr/performance/goals"],
    ["post", "/hr/performance/goals"],
    ["patch", "/hr/performance/goals"],
    ["patch", "/hr/performance/goals/1"],
    ["delete", "/hr/performance/goals/1"],
    ["get", "/hr/performance/key-results"],
    ["post", "/hr/performance/key-results"],
    ["patch", "/hr/performance/key-results"],
    ["get", "/hr/performance/one-on-ones"],
    ["post", "/hr/performance/one-on-ones"],
    ["patch", "/hr/performance/one-on-ones/1"],
    ["delete", "/hr/performance/one-on-ones/1"],
    ["get", "/hr/performance/pip"],
    ["post", "/hr/performance/pip"],
    ["patch", "/hr/performance/pip/1"],
    ["get", "/hr/performance/reviews/1"],
    ["delete", "/hr/performance/reviews/1"],
    ["patch", "/hr/performance/reviews/1"],
    ["get", "/hr/performance/cycles/1"],
    ["patch", "/hr/performance/cycles/1"],
    ["delete", "/hr/performance/cycles/1"],
    ["get", "/hr/my-goals"],
    ["get", "/hr/feedback"],
    ["post", "/hr/feedback"],
    ["patch", "/hr/feedback/1"],
    ["get", "/hr/assessments"],
    ["post", "/hr/assessments"],
    ["get", "/hr/recognition"],
    ["post", "/hr/recognition"],
    ["get", "/hr/enps"],
    ["post", "/hr/enps"],
    ["get", "/hr/surveys"],
    ["post", "/hr/surveys"],
    ["patch", "/hr/surveys/1"],
    ["get", "/hr/documents"],
    ["post", "/hr/documents"],
    ["get", "/hr/documents/stats"],
    ["patch", "/hr/documents/1"],
    ["delete", "/hr/documents/1"],
    ["get", "/hr/document-expiry"],
    ["get", "/hr/compliance"],
    ["post", "/hr/compliance"],
    ["patch", "/hr/compliance"],
    ["get", "/hr/compliance/statutory"],
    ["get", "/hr/rich-documents"],
    ["post", "/hr/rich-documents"],
    ["get", "/hr/rich-documents/1"],
    ["patch", "/hr/rich-documents/1/publish"],
    ["patch", "/hr/rich-documents/1"],
    ["delete", "/hr/rich-documents/1"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on POST /hr/feedback without hr:feedback manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/hr/feedback")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /hr/compliance/statutory without hr:compliance manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/hr/compliance/statutory")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /hr/enps without hr:engagement:manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/hr/enps")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  const abilityGatedGetRoutes: ReadonlyArray<[string, string]> = [
    ["/hr/my-goals", "hr:performance:view"],
    ["/hr/feedback", "hr:feedback:view"],
    ["/hr/recognition", "hr:engagement:view"],
    ["/hr/surveys", "hr:engagement:view"],
    ["/hr/assessments", "hr:engagement:view"],
    ["/hr/rich-documents", "hr:documents:view"],
  ];

  it.each(abilityGatedGetRoutes)(
    "403 on GET %s without %s permission",
    async (path) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await request(app.getHttpServer())
        .get(path)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    },
  );

  it.each(abilityGatedGetRoutes)(
    "passes the ability gate on GET %s with %s permission",
    async (path, permission) => {
      const token = await signToken({ permissions: [permission], enabledModules: ALL_MODULES });
      const res = await request(app.getHttpServer())
        .get(path)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    },
  );
});
