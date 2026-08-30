import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { AgentTokensService } from "./agent-tokens.service";

const stubAgentTokens = {
  create: jest.fn().mockResolvedValue({ id: 1, token: "slos_secret" }),
  list: jest.fn().mockResolvedValue([]),
  revoke: jest.fn().mockResolvedValue(undefined),
};

describe("Agent Tokens controller auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: AgentTokensService, useValue: stubAgentTokens }],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const protectedRoutes: ReadonlyArray<["get" | "post" | "delete", string]> = [
    ["post", "/agent-tokens"],
    ["get", "/agent-tokens"],
    ["delete", "/agent-tokens/1"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const agent = request(app.getHttpServer());
    const res = await (method === "get" ? agent.get(path) : method === "post" ? agent.post(path) : agent.delete(path));
    expect(res.status).toBe(401);
  });

  it("403 on GET /agent-tokens without settings:api-tokens:read", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/agent-tokens")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on POST /agent-tokens without settings:api-tokens:write", async () => {
    const token = await signToken({
      permissions: ["settings:api-tokens:read"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/agent-tokens")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "CI bot", scopes: ["build:view"] });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on DELETE /agent-tokens/1 without settings:api-tokens:write", async () => {
    const token = await signToken({
      permissions: ["settings:api-tokens:read"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .delete("/agent-tokens/1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("200 on GET /agent-tokens with settings:api-tokens:read", async () => {
    const token = await signToken({
      permissions: ["settings:api-tokens:read"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/agent-tokens")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(stubAgentTokens.list).toHaveBeenCalledWith("user_1", "org_1");
  });

  it("cross-tenant: revoke with another org token id returns 404 not 403", async () => {
    const token = await signToken({
      permissions: ["settings:api-tokens:write"],
      enabledModules: ALL_MODULES,
    });
    stubAgentTokens.revoke.mockRejectedValueOnce(
      Object.assign(new Error("Not found"), { status: 404 }),
    );
    const res = await request(app.getHttpServer())
      .delete("/agent-tokens/9999")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(403);
  });

  it("400 on POST /agent-tokens with invalid body", async () => {
    const token = await signToken({
      permissions: ["settings:api-tokens:write"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/agent-tokens")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
