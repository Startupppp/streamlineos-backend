import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";

describe("HR lifecycle auth (e2e)", () => {
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
    ["get", "/hr/exit/analytics"],
    ["post", "/hr/exit/experience-letter"],
    ["get", "/hr/exit/1/letter"],
    ["get", "/hr/exit/1/progress"],
    ["patch", "/hr/exit/1/withdraw"],
    ["get", "/hr/termination"],
    ["post", "/hr/termination"],
    ["get", "/hr/termination/1"],
    ["get", "/hr/termination/1/letter"],
    ["patch", "/hr/termination/1/submit"],
    ["patch", "/hr/termination/1/ceo-review"],
    ["get", "/hr/alumni"],
    ["post", "/hr/alumni"],
    ["get", "/hr/analytics"],
    ["get", "/hr/analytics/attendance"],
    ["get", "/hr/analytics/attrition"],
    ["get", "/hr/dashboard/metrics"],
    ["get", "/hr/dashboard/diversity"],
    ["get", "/hr/dashboard/onboarding-status"],
    ["get", "/hr/dashboard/headcount-trends"],
    ["get", "/hr/dashboard/time-to-fill"],
    ["get", "/hr/dashboard/attendance-analytics"],
    ["get", "/hr/dashboard/compliance"],
    ["get", "/hr/dashboard/export"],
    ["get", "/hr/onboarding-docs/summary"],
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
