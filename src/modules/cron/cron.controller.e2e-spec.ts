import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";

describe("Cron auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    process.env.CRON_SECRET ??= "test-cron-secret";
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post";
  const routes: ReadonlyArray<[Method, string]> = [
    ["get", "/cron/auto-checkout"],
    ["post", "/cron/auto-checkout"],
    ["get", "/cron/monthly-leave-reset"],
    ["post", "/cron/monthly-leave-reset"],
    ["get", "/cron/daily-notifications"],
    ["post", "/cron/daily-notifications"],
    ["get", "/cron/holiday-notifications"],
    ["post", "/cron/holiday-notifications"],
    ["get", "/cron/offer-deadline-reminders"],
    ["post", "/cron/offer-deadline-reminders"],
    ["get", "/cron/interview-no-shows"],
    ["post", "/cron/interview-no-shows"],
    ["get", "/cron/support-sla-escalations"],
    ["post", "/cron/support-sla-escalations"],
  ];

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    return method === "get" ? agent.get(path) : agent.post(path);
  }

  it.each(routes)("401 on %s %s without the cron secret", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it.each(routes)("401 on %s %s with a wrong cron secret", async (method, path) => {
    const res = await callRoute(method, path).set("Authorization", "Bearer wrong-secret");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });
});
