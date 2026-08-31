import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../../../test/helpers/sign-token";

describe("Onboarding auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "patch":
        return agent.patch(path);
    }
  }

  const authedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/onboarding"],
    ["post", "/onboarding"],
    ["get", "/onboarding/templates"],
    ["post", "/onboarding/templates"],
    ["patch", "/onboarding/personal-details"],
    ["get", "/onboarding/personal-details"],
    ["patch", "/onboarding/bank-details"],
    ["get", "/onboarding/bank-details"],
    ["post", "/onboarding/submit"],
    ["get", "/onboarding/user_1"],
  ];

  it.each(authedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  const abilityGatedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/onboarding"],
    ["post", "/onboarding"],
    ["get", "/onboarding/templates"],
    ["post", "/onboarding/templates"],
  ];

  it.each(abilityGatedRoutes)(
    "403 on %s %s without settings:onboarding manage",
    async (method, path) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    },
  );

  const authOnlyRoutes: ReadonlyArray<[Method, string]> = [
    ["patch", "/onboarding/personal-details"],
    ["get", "/onboarding/personal-details"],
    ["patch", "/onboarding/bank-details"],
    ["get", "/onboarding/bank-details"],
    ["post", "/onboarding/submit"],
  ];

  it.each(authOnlyRoutes)(
    "does NOT require an ability on %s %s (auth-only)",
    async (method, path) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    },
  );

  it("403 on GET /onboarding/user_1 without hr:onboarding:tasks:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await callRoute("get", "/onboarding/user_1").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("passes the ability gate on GET /onboarding/user_1 with hr:onboarding:tasks:view", async () => {
    const token = await signToken({ permissions: ["hr:onboarding:tasks:view"], enabledModules: ALL_MODULES });
    const res = await callRoute("get", "/onboarding/user_1").set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  describe("HR module-checklist is HR-only (task: employees must never see HR admin setup)", () => {
    const hrGatedMutations: ReadonlyArray<[Method, string]> = [
      ["post", "/onboarding/module-checklists/HR/items/leave_policies/complete"],
      ["post", "/onboarding/module-checklists/HR/items/recruitment_setup/skip"],
      ["post", "/onboarding/module-checklists/HR/dismiss"],
      ["post", "/onboarding/module-checklists/HR/restart"],
    ];

    it("403s a plain employee (no hr:* permission) reading the HR checklist directly", async () => {
      const token = await signToken({
        role: "EMPLOYEE",
        permissions: ["onboarding:module-checklists:view"],
        enabledModules: ["HR", "ONBOARDING"],
      });
      const res = await callRoute("get", "/onboarding/module-checklists/HR").set(
        "Authorization",
        `Bearer ${token}`,
      );
      expect(res.status).toBe(403);
    });

    it.each(hrGatedMutations)(
      "403s a Sales/Restricted-shaped token (no hr:* permission) on %s %s",
      async (method, path) => {
        const token = await signToken({
          role: "SALES",
          permissions: ["onboarding:module-checklists:manage"],
          enabledModules: ["HR", "CRM", "ONBOARDING"],
        });
        const req = callRoute(method, path).set("Authorization", `Bearer ${token}`);
        const res = path.includes("/skip") ? await req.send({ reason: "test" }) : await req;
        expect(res.status).toBe(403);
      },
    );

    it("does not 403 an Owner with no explicit hr:* permission (owner bypass)", async () => {
      const token = await signToken({
        role: "OWNER",
        isOrgOwner: true,
        permissions: ["onboarding:module-checklists:view"],
        enabledModules: ["HR", "ONBOARDING"],
      });
      const res = await callRoute("get", "/onboarding/module-checklists/HR").set(
        "Authorization",
        `Bearer ${token}`,
      );
      expect(res.status).not.toBe(403);
    });
  });
});
