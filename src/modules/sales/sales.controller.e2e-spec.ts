import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";

describe("Sales auth (e2e)", () => {
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
  const routes: ReadonlyArray<[Method, string]> = [
    ["get", "/sales/commission-rules"],
    ["post", "/sales/commission-rules"],
    ["get", "/sales/commissions"],
    ["patch", "/sales/commissions/1"],
    ["get", "/sales/quotas"],
    ["post", "/sales/quotas"],
    ["get", "/sales/playbook"],
    ["post", "/sales/playbook"],
    ["patch", "/sales/playbook/1"],
    ["delete", "/sales/playbook/1"],
    ["get", "/sales/dashboard/kpis"],
    ["get", "/sales/dashboard/funnel"],
    ["get", "/sales/dashboard/leaderboard"],
    ["get", "/sales/dashboard/revenue-vs-goal"],
    ["get", "/sales/dashboard/velocity"],
    ["get", "/sales/dashboard/aging"],
    ["get", "/sales/dashboard/cohort"],
    ["get", "/sales/dashboard/cycle-length"],
    ["get", "/sales/dashboard/lost-analysis"],
    ["get", "/sales/dashboard/rep-comparison"],
  ];

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

  it.each(routes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });
});
