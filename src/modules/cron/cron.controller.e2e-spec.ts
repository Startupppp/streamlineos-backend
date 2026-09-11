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
    /**
     * The silence loop and the repair loop, which had the same problem as the
     * renewal one: a detector and an action that had never been introduced.
     * `listAwaitingReply` says in its own docstring that it is the detector a
     * sweep runs, and no sweep existed to run it.
     */
    ["get", "/cron/crm-silence-sweep"],
    ["post", "/cron/crm-silence-sweep"],
    ["get", "/cron/crm-nurture-steps"],
    ["post", "/cron/crm-nurture-steps"],
    ["get", "/cron/crm-field-repairs"],
    ["post", "/cron/crm-field-repairs"],
    /**
     * The report timetable. Listed here for the reason the block above gives:
     * this table is what proves the route resolves at boot, which is the one
     * failure mode a scheduled feature has that `tsc` cannot see — an
     * unregistered sweep compiles green and simply never runs.
     */
    ["get", "/cron/crm-report-schedules"],
    ["post", "/cron/crm-report-schedules"],
    ["get", "/cron/operator-grant-expiry"],
    ["post", "/cron/operator-grant-expiry"],
    ["get", "/cron/trial-expiry"],
    ["post", "/cron/trial-expiry"],
    ["get", "/cron/monthly-plan-grants"],
    ["post", "/cron/monthly-plan-grants"],
    ["get", "/cron/ai-reservations-sweep"],
    ["post", "/cron/ai-reservations-sweep"],
    ["get", "/cron/auto-topup-flush"],
    ["post", "/cron/auto-topup-flush"],
    ["get", "/cron/provider-webhook-redrive"],
    ["post", "/cron/provider-webhook-redrive"],
    ["get", "/cron/ai-jobs-flush"],
    ["post", "/cron/ai-jobs-flush"],
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
