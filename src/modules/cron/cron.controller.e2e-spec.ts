import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("Cron auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.CRON_SECRET ??= "test-cron-secret";
    app = await createE2eApp();
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
    /**
     * The renewal sweep, which until now had no scheduled entry point at all.
     *
     * A 401 here is the assertion that matters twice over: the route is mounted
     * (an absent one answers 404, not 401), and `AppModule` booted with
     * `CronModule` holding `LifecycleTriggersModule` — a provider Nest cannot
     * resolve fails at boot, which `tsc` cannot see.
     */
    ["get", "/cron/crm-lifecycle-triggers-sweep"],
    ["post", "/cron/crm-lifecycle-triggers-sweep"],
  ];

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    return method === "get" ? agent.get(path) : agent.post(path);
  }

  it.each(routes)("401 on %s %s without the cron secret", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it.each(routes)("401 on %s %s with a wrong cron secret", async (method, path) => {
    const res = await callRoute(method, path).set("Authorization", "Bearer wrong-secret");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });
});
