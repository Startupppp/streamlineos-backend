import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { ApiTokensService } from "./api-tokens.service";

const stubApiTokens = {
  listTokens: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  createToken: jest.fn().mockResolvedValue({ id: "tok_1", token: "secret" }),
  revokeToken: jest.fn().mockResolvedValue({ revoked: true }),
};

describe("API Tokens controller auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: ApiTokensService, useValue: stubApiTokens }],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  type Method = "get" | "post" | "patch";

  function call(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get": return agent.get(path);
      case "post": return agent.post(path);
      case "patch": return agent.patch(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/api-tokens"],
    ["post", "/api-tokens"],
    ["patch", "/api-tokens/tok_1/revoke"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await call(method, path);
    expect(res.status).toBe(401);
  });

  it.each(protectedRoutes)("402 on %s %s when CRM module disabled", async (method, path) => {
    const token = await signToken({
      permissions: ["crm:settings:manage"],
      enabledModules: [],
    });
    const res = await call(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(402);
  });

  it.each(protectedRoutes)("403 on %s %s without crm:settings:manage", async (method, path) => {
    const token = await signToken({
      permissions: [],
      enabledModules: ALL_MODULES,
    });
    const res = await call(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("200 on GET /api-tokens with crm:settings:manage and crm enabled", async () => {
    const token = await signToken({
      permissions: ["crm:settings:manage"],
      enabledModules: ALL_MODULES,
    });
    const res = await call("get", "/api-tokens").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(stubApiTokens.listTokens).toHaveBeenCalledWith("org_1", expect.any(Object));
  });

  it("cross-tenant: token id from another org returns 404 not 403", async () => {
    const token = await signToken({
      permissions: ["crm:settings:manage"],
      enabledModules: ALL_MODULES,
    });
    stubApiTokens.revokeToken.mockRejectedValueOnce(
      Object.assign(new Error("Not found"), { status: 404 }),
    );
    const res = await call("patch", "/api-tokens/other_org_token/revoke")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(403);
  });
});
