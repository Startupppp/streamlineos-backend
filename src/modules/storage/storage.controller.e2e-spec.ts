import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("Storage auth/RBAC (e2e)", () => {
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

  type Method = "get" | "post" | "delete";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "delete":
        return agent.delete(path);
    }
  }

  const authedRoutes: ReadonlyArray<[Method, string]> = [
    ["post", "/storage/upload"],
    ["get", "/storage/download?key=uploads/1-a.png"],
    ["get", "/storage/image?key=uploads/1-a.png"],
    ["post", "/onboarding/documents"],
    ["get", "/hr/recruitment/candidates/1/vault/2"],
    ["delete", "/hr/recruitment/candidates/1/vault/2"],
  ];

  it.each(authedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("does not require a token on GET /public/kb/:slug/attachments (public)", async () => {
    const res = await callRoute("get", "/public/kb/some-slug/attachments?org=org_1");
    expect(res.status).not.toBe(401);
  });

  const vaultRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/hr/recruitment/candidates/1/vault/2"],
    ["delete", "/hr/recruitment/candidates/1/vault/2"],
  ];

  it.each(vaultRoutes)("403 on %s %s for a non-privileged role", async (method, path) => {
    const token = await signToken({ role: "SALES", isOrgOwner: false, isPlatformAdmin: false });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });
});
