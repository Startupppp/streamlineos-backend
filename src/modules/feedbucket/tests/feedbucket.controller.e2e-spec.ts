import { INestApplication, NotFoundException } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../../test/helpers/sign-token";
import { FeedbucketWidgetsService } from "../feedbucket-widgets.service";

const widgetsStub = {
  list: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockRejectedValue(new NotFoundException()),
  create: jest.fn().mockResolvedValue({}),
  update: jest.fn().mockResolvedValue({}),
  softDelete: jest.fn().mockResolvedValue({}),
  rotateKey: jest.fn().mockResolvedValue({}),
};

describe("Feedbucket auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: FeedbucketWidgetsService, useValue: widgetsStub }],
    });
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
    ["get", "/feedbucket/widgets"],
    ["post", "/feedbucket/widgets"],
    ["get", "/feedbucket/widgets/1"],
    ["patch", "/feedbucket/widgets/1"],
    ["delete", "/feedbucket/widgets/1"],
    ["post", "/feedbucket/widgets/1/rotate-key"],
    ["get", "/feedbucket/submissions"],
    ["get", "/feedbucket/submissions/1"],
    ["patch", "/feedbucket/submissions/1"],
    ["delete", "/feedbucket/submissions/1"],
    ["post", "/feedbucket/submissions/1/convert-to-ticket"],
    ["get", "/feedbucket/stats"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on GET /feedbucket/widgets without feedbucket:widgets:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/feedbucket/widgets")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("403 on POST /feedbucket/widgets without feedbucket:widgets:create", async () => {
    const token = await signToken({ permissions: ["feedbucket:widgets:view"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/feedbucket/widgets")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Test Widget" });
    expect(res.status).toBe(403);
  });

  it("403 on GET /feedbucket/submissions without feedbucket:submissions:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/feedbucket/submissions")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("403 on POST /feedbucket/submissions/1/convert-to-ticket without feedbucket:submissions:manage", async () => {
    const token = await signToken({
      permissions: ["feedbucket:submissions:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/feedbucket/submissions/1/convert-to-ticket")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("cross-tenant isolation: org A user cannot read org B widget", async () => {
    const tokenOrgA = await signToken({
      orgId: "org_a",
      permissions: ["feedbucket:widgets:view"],
      enabledModules: ["feedbucket"],
    });
    const res = await request(app.getHttpServer())
      .get("/feedbucket/widgets/9999")
      .set("Authorization", `Bearer ${tokenOrgA}`);
    expect([403, 404]).toContain(res.status);
  });

  it("404 on public submit with unknown publicKey", async () => {
    const res = await request(app.getHttpServer())
      .post("/public/feedbucket/nonexistent_key_abc123")
      .field("type", "bug")
      .field("message", "Test feedback");
    expect(res.status).toBe(404);
  });
});
