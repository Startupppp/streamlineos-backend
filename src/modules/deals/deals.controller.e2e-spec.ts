import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("Deals auth/RBAC (e2e)", () => {
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
    ["get", "/deals"],
    ["post", "/deals"],
    ["get", "/deals/stats"],
    ["get", "/deals/aging"],
    ["get", "/deals/forecast"],
    ["get", "/deals/win-loss"],
    ["get", "/deals/approval-rules"],
    ["post", "/deals/approval-rules"],
    ["get", "/deals/approvals"],
    ["post", "/deals/1/clone"],
    ["get", "/deals/1/activities"],
    ["post", "/deals/1/activities"],
    ["patch", "/deals/1/custom-data"],
    ["get", "/deals/1/meetings"],
    ["post", "/deals/1/meetings"],
    ["patch", "/deals/1/meetings/1"],
    ["delete", "/deals/1/meetings/1"],
    ["get", "/deals/1"],
    ["delete", "/deals/1"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on GET /deals without crm:deals read", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer()).get("/deals").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "read", subject: "crm:deals" });
  });

  it("403 on POST /deals without crm:deals create", async () => {
    const token = await signToken({ permissions: ["crm:deals:read"], enabledModules: [] });
    const res = await request(app.getHttpServer()).post("/deals").set("Authorization", `Bearer ${token}`).send({ name: "x" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "create", subject: "crm:deals" });
  });

  it("403 on DELETE /deals/1 without crm:deals delete", async () => {
    const token = await signToken({ permissions: ["crm:deals:read"], enabledModules: [] });
    const res = await request(app.getHttpServer()).delete("/deals/1").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "delete", subject: "crm:deals" });
  });

  const authOnlyGetRoutes: ReadonlyArray<string> = [
    "/deals/stats",
    "/deals/aging",
    "/deals/forecast",
    "/deals/win-loss",
    "/deals/approval-rules",
    "/deals/approvals",
  ];

  it.each(authOnlyGetRoutes)(
    "does NOT enforce an ability gate on GET %s (auth-only)",
    async (path) => {
      const token = await signToken({ permissions: [], enabledModules: [] });
      const res = await request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    },
  );
});
