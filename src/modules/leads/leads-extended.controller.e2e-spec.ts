import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";
import { stubMembershipState } from "../../../test/helpers/membership-state";

describe("Leads extended routes auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const ref = await stubMembershipState(
      Test.createTestingModule({ imports: [AppModule] }),
      { member_1: { role: "SALES" } },
    ).compile();
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
    ["get", "/leads/analytics"],
    ["get", "/leads/dashboard-metrics"],
    ["get", "/leads/source-report"],
    ["get", "/leads/sales-leaderboard"],
    ["get", "/leads/sales-team-capacity"],
    ["get", "/leads/sla-alerts"],
    ["get", "/leads/follow-ups"],
    ["get", "/leads/unverified"],
    ["get", "/leads/duplicates"],
    ["get", "/leads/check-duplicates"],
    ["get", "/leads/export"],
    ["get", "/leads/1/activities"],
    ["get", "/leads/1/timeline"],
    ["get", "/leads/1/score-explanation"],
    ["get", "/leads/import/1"],
    ["post", "/leads/1/activities"],
    ["patch", "/leads/1/custom-data"],
    ["patch", "/leads/1/status"],
    ["patch", "/leads/1/verify"],
    ["patch", "/leads/1/reject"],
    ["patch", "/leads/1/self-assign"],
    ["patch", "/leads/1/assign"],
    ["post", "/leads/1/merge"],
    ["patch", "/leads/bulk"],
    ["delete", "/leads/bulk"],
    ["post", "/leads/merge"],
    ["post", "/leads/import"],
    ["post", "/leads/distribute"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  const moduleGatedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/leads/analytics"],
    ["get", "/leads/dashboard-metrics"],
    ["get", "/leads/source-report"],
    ["get", "/leads/sales-leaderboard"],
    ["get", "/leads/sales-team-capacity"],
    ["get", "/leads/sla-alerts"],
    ["get", "/leads/follow-ups"],
    ["get", "/leads/unverified"],
    ["get", "/leads/duplicates"],
    ["get", "/leads/check-duplicates"],
    ["get", "/leads/export"],
    ["get", "/leads/1/activities"],
    ["get", "/leads/1/timeline"],
    ["get", "/leads/1/score-explanation"],
    ["get", "/leads/import/1"],
    ["post", "/leads/1/activities"],
    ["patch", "/leads/1/custom-data"],
    ["patch", "/leads/1/status"],
    ["patch", "/leads/1/verify"],
    ["patch", "/leads/1/reject"],
    ["patch", "/leads/1/self-assign"],
    ["patch", "/leads/1/assign"],
    ["post", "/leads/1/merge"],
    ["patch", "/leads/bulk"],
    ["delete", "/leads/bulk"],
    ["post", "/leads/import"],
  ];

  it.each(moduleGatedRoutes)(
    "403 on %s %s when the crm module is disabled (PermissionGuard wired)",
    async (method, path) => {
      const token = await signToken({ sub: "member_1" });
      const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Module not available on this plan" });
    },
  );

  it("403 on POST /leads/merge for a non-manager role (role-string gate)", async () => {
    const token = await signToken({ sub: "member_1" });
    const res = await request(app.getHttpServer())
      .post("/leads/merge")
      .set("Authorization", `Bearer ${token}`)
      .send({ winnerId: 1, loserId: 2 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden: Manager or Admin role required" });
  });

  it("403 on POST /leads/distribute without crm:leads:assign", async () => {
    const token = await signToken({ sub: "member_1" });
    const res = await request(app.getHttpServer())
      .post("/leads/distribute")
      .set("Authorization", `Bearer ${token}`)
      .send({ leadIds: [1] });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Permission denied" });
  });
});
