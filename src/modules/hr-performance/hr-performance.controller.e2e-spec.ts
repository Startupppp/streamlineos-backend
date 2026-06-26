import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("HR Performance auth/RBAC (e2e)", () => {
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
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on POST /hr/feedback without hr:feedback manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/hr/feedback")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "hr:feedback" });
  });

  it("403 on GET /hr/compliance/statutory without hr:compliance manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/hr/compliance/statutory")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "RBAC_DENIED",
      verb: "manage",
      subject: "hr:compliance",
    });
  });

  it("403 on GET /hr/enps without hr:performance manage (role-string gate)", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/hr/enps")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only admins can view eNPS scores." });
  });

  const authOnlyGetRoutes: ReadonlyArray<string> = [
    "/hr/my-goals",
    "/hr/feedback",
    "/hr/recognition",
    "/hr/surveys",
    "/hr/assessments",
    "/hr/rich-documents",
  ];

  it.each(authOnlyGetRoutes)(
    "does NOT enforce an ability gate on GET %s (auth-only)",
    async (path) => {
      const token = await signToken({ permissions: [], enabledModules: [] });
      const res = await request(app.getHttpServer())
        .get(path)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    },
  );
});
