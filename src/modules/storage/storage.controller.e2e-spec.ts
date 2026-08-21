import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";

describe("Storage auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
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
    ["post", "/hr/recruitment/candidates/1/vault/2/url"],
    ["delete", "/hr/recruitment/candidates/1/vault/2"],
  ];

  it.each(authedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("does not require a token on GET /public/kb/:slug/attachments (public)", async () => {
    const res = await callRoute("get", "/public/kb/some-slug/attachments?org=org_1");
    expect(res.status).not.toBe(401);
  });

  const vaultRoutes: ReadonlyArray<[Method, string]> = [
    ["post", "/hr/recruitment/candidates/1/vault/2/url"],
    ["delete", "/hr/recruitment/candidates/1/vault/2"],
  ];

  it.each(vaultRoutes)("403 on %s %s for a caller without hr:documents:manage", async (method, path) => {
    const token = await signToken({ sub: "user_1" });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Forbidden" });
  });
});
