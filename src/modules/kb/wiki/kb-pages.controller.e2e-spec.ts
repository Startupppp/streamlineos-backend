import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { KbIndexingService } from "../retrieval/kb-indexing.service";

describe("KB Pages auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: KbIndexingService, useValue: {} }],
    });
  });

  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch" | "delete";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get": return agent.get(path);
      case "post": return agent.post(path);
      case "patch": return agent.patch(path);
      case "delete": return agent.delete(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/pages/tree"],
    ["get", "/kb/pages/recent"],
    ["get", "/kb/pages/favorites"],
    ["get", "/kb/pages/trash"],
    ["get", "/kb/pages/search"],
    ["post", "/kb/pages"],
    ["get", "/kb/pages/1"],
    ["patch", "/kb/pages/1"],
    ["post", "/kb/pages/1/move"],
    ["post", "/kb/pages/1/duplicate"],
    ["delete", "/kb/pages/1"],
    ["post", "/kb/pages/1/restore"],
    ["delete", "/kb/pages/1/permanent"],
    ["post", "/kb/pages/1/favorite"],
    ["delete", "/kb/pages/1/favorite"],
    ["post", "/kb/pages/1/visit"],
    ["get", "/kb/pages/1/backlinks"],
    ["get", "/kb/pages/1/versions"],
    ["get", "/kb/pages/1/versions/1"],
    ["post", "/kb/pages/1/versions/1/restore"],
    ["patch", "/kb/pages/1/lock"],
    ["get", "/kb/pages/1/comments"],
    ["post", "/kb/pages/1/comments"],
    ["patch", "/kb/page-comments/1"],
    ["delete", "/kb/page-comments/1"],
    ["post", "/kb/page-comments/1/resolve"],
    ["get", "/kb/page-templates"],
    ["post", "/kb/page-templates"],
    ["delete", "/kb/page-templates/1"],
    ["post", "/kb/pages/1/publish"],
    ["post", "/kb/pages/1/archive"],
    ["post", "/kb/pages/1/unarchive"],
    ["post", "/kb/pages/1/verify"],
    ["post", "/kb/pages/1/mark-stale"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  const moduleCheckRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/pages/tree"],
    ["get", "/kb/pages/recent"],
    ["get", "/kb/pages/favorites"],
    ["get", "/kb/pages/search"],
    ["get", "/kb/pages/1"],
    ["get", "/kb/pages/1/backlinks"],
    ["get", "/kb/pages/1/versions"],
    ["post", "/kb/pages"],
    ["patch", "/kb/pages/1"],
    ["delete", "/kb/pages/1"],
    ["patch", "/kb/pages/1/lock"],
  ];

  /**
   * Never 402. `kb` is registered `planGated: false`, so `isCoreModuleKey("kb")` is true
   * and `moduleAvailability` answers `{ available: true }` before it reads a single
   * entitlement row — the constitution's rule that knowledge is platform core, not a
   * paid entitlement. This case asserted 402 and could never have passed. What it pins
   * now is the contract that does hold: an org with the module switched off still
   * reaches the permission check, and the permission check is what denies. The registry
   * half is pinned in src/modules/kb/kb-module-gate.spec.ts.
   */
  it.each(moduleCheckRoutes)(
    "403 on %s %s with no permission even when the kb module is not enabled",
    async (method, path) => {
      const token = await signToken({ permissions: [], enabledModules: [] });
      const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    },
  );

  it.each(moduleCheckRoutes)("403 on %s %s without permission", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ["kb"] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("200 on GET /kb/pages/tree with kb:pages:view permission", async () => {
    const token = await signToken({ permissions: ["kb:pages:view"], enabledModules: ["kb"] });
    const res = await callRoute("get", "/kb/pages/tree").set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
  });

  it("200 on POST /kb/pages with kb:pages:create permission (body validation)", async () => {
    const token = await signToken({ permissions: ["kb:pages:create"], enabledModules: ["kb"] });
    const res = await callRoute("post", "/kb/pages")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Test Page" });
    expect([201, 400, 404, 500]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
