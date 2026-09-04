import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { KbIndexingService } from "./kb-indexing.service";

describe("KB Search auth/RBAC (e2e)", () => {
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

  const protectedRoutes: ReadonlyArray<[Method, string]> = [["get", "/kb/search"]];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  const abilities: ReadonlyArray<[Method, string]> = [
    ["get", "/kb/search"],
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
  it.each(abilities)(
    "403 on %s %s with no permission even when the kb module is not enabled",
    async (method, path) => {
      const token = await signToken({ permissions: [], enabledModules: [] });
      const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    },
  );

  it.each(abilities)("403 on %s %s without permission", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ["kb"] });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});
