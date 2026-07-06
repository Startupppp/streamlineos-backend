import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

// The AiModule import (langchain/openai + embeddings clients) added in Phase 6 measurably
// increased per-request latency under --runInBand load; the default 5s timeout is too tight.
jest.setTimeout(20000);

describe("Support auth/RBAC (e2e)", () => {
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
    ["get", "/support"],
    ["post", "/support"],
    ["get", "/support/stats"],
    ["get", "/support/1"],
    ["patch", "/support/1"],
    ["get", "/support/1/messages"],
    ["post", "/support/1/messages"],
    ["get", "/support/1/activity"],
    ["get", "/support/macros"],
    ["post", "/support/macros"],
    ["patch", "/support/macros/1"],
    ["delete", "/support/macros/1"],
    ["get", "/support/macros/usage"],
    ["post", "/support/macros/1/preview"],
    ["post", "/support/macros/1/apply"],
    ["get", "/support/reports/csat"],
    ["get", "/support/routing-rules"],
    ["post", "/support/routing-rules"],
    ["patch", "/support/routing-rules/1"],
    ["delete", "/support/routing-rules/1"],
    ["get", "/support/kb/categories"],
    ["post", "/support/kb/categories"],
    ["patch", "/support/kb/categories/1"],
    ["delete", "/support/kb/categories/1"],
    ["get", "/support/kb/articles"],
    ["post", "/support/kb/articles"],
    ["get", "/support/kb/articles/1"],
    ["patch", "/support/kb/articles/1"],
    ["delete", "/support/kb/articles/1"],
    ["get", "/support/kb/articles/1/feedback"],
    ["get", "/support/kb/articles/1/comments"],
    ["post", "/support/kb/articles/1/comments"],
    ["delete", "/support/kb/articles/1/comments/1"],
    ["get", "/support/kb/articles/1/attachments"],
    ["post", "/support/kb/articles/1/attachments"],
    ["delete", "/support/kb/articles/1/attachments/1"],
    ["get", "/support/queues"],
    ["post", "/support/queues"],
    ["patch", "/support/queues/1"],
    ["delete", "/support/queues/1"],
    ["get", "/support/views"],
    ["post", "/support/views"],
    ["patch", "/support/views/1"],
    ["delete", "/support/views/1"],
    ["get", "/support/tags"],
    ["post", "/support/tags"],
    ["post", "/support/1/tags/1"],
    ["delete", "/support/1/tags/1"],
    ["get", "/support/1/watchers"],
    ["post", "/support/1/follow"],
    ["delete", "/support/1/follow"],
    ["get", "/support/1/links"],
    ["post", "/support/1/links"],
    ["post", "/support/1/merge"],
    ["get", "/support/ably-token"],
    ["get", "/support/business-hours"],
    ["post", "/support/business-hours"],
    ["patch", "/support/business-hours/1"],
    ["delete", "/support/business-hours/1"],
    ["get", "/support/sla-policies"],
    ["post", "/support/sla-policies"],
    ["patch", "/support/sla-policies/1"],
    ["delete", "/support/sla-policies/1"],
    ["post", "/support/sla/run-escalations"],
    ["get", "/support/1/risk"],
    ["get", "/support/channels"],
    ["post", "/support/channels"],
    ["patch", "/support/channels/1"],
    ["delete", "/support/channels/1"],
    ["get", "/support/portal/tickets"],
    ["post", "/support/portal/tickets"],
    ["get", "/support/portal/tickets/1"],
    ["post", "/support/portal/tickets/1/messages"],
    ["get", "/support/automations"],
    ["post", "/support/automations"],
    ["patch", "/support/automations/1"],
    ["delete", "/support/automations/1"],
    ["post", "/support/automations/1/test"],
    ["get", "/support/automation-runs"],
    ["get", "/support/1/ai/suggestions"],
    ["post", "/support/1/ai/analyze"],
    ["post", "/support/1/ai/find-duplicates"],
    ["post", "/support/1/ai/suggest-kb-articles"],
    ["post", "/support/1/ai/suggest-reply"],
    ["post", "/support/1/ai/suggest-macro"],
    ["post", "/support/ai-suggestions/1/resolve"],
    ["get", "/support/reports/overview"],
    ["get", "/support/reports/agent-performance"],
    ["get", "/support/reports/queue-performance"],
    ["get", "/support/reports/channel-performance"],
    ["get", "/support/reports/automation-performance"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on GET /support/macros without support:macros view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["support"] });
    const res = await request(app.getHttpServer())
      .get("/support/macros")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on POST /support/macros without support:macros manage", async () => {
    const token = await signToken({ permissions: ["support:macros:view"], enabledModules: ["support"] });
    const res = await request(app.getHttpServer())
      .post("/support/macros")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "x", body: "y" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on GET /support/kb/categories without support:kb view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["support"] });
    const res = await request(app.getHttpServer())
      .get("/support/kb/categories")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on POST /support/kb/articles without support:kb manage", async () => {
    const token = await signToken({ permissions: ["support:kb:view"], enabledModules: ["support"] });
    const res = await request(app.getHttpServer())
      .post("/support/kb/articles")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "x" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on GET /support/macros/usage without support:macros view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["support"] });
    const res = await request(app.getHttpServer())
      .get("/support/macros/usage")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on POST /support/macros/1/preview without support:macros view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["support"] });
    const res = await request(app.getHttpServer())
      .post("/support/macros/1/preview")
      .set("Authorization", `Bearer ${token}`)
      .send({ ticketId: 1 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on POST /support/macros/1/apply without support:tickets:reply", async () => {
    const token = await signToken({ permissions: ["support:macros:view"], enabledModules: ["support"] });
    const res = await request(app.getHttpServer())
      .post("/support/macros/1/apply")
      .set("Authorization", `Bearer ${token}`)
      .send({ ticketId: 1 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on GET /support/reports/csat without support:reports:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["support"] });
    const res = await request(app.getHttpServer())
      .get("/support/reports/csat")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("404 MODULE_DISABLED on GET /support/macros when support module is disabled", async () => {
    const token = await signToken({ permissions: ["support:macros:view"], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/support/macros")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "MODULE_DISABLED" });
  });

  const ticketPermissionCases: ReadonlyArray<{
    method: Method;
    path: string;
    permission: string;
    body?: Record<string, unknown>;
  }> = [
    { method: "get", path: "/support", permission: "support:tickets:view" },
    { method: "get", path: "/support/stats", permission: "support:tickets:view" },
    { method: "get", path: "/support/1", permission: "support:tickets:view" },
    { method: "get", path: "/support/1/messages", permission: "support:tickets:view" },
    { method: "get", path: "/support/1/activity", permission: "support:tickets:view" },
    {
      method: "post",
      path: "/support",
      permission: "support:tickets:create",
      body: { title: "x", description: "y" },
    },
    {
      method: "post",
      path: "/support/1/messages",
      permission: "support:tickets:reply",
      body: { body: "hello", isInternal: false },
    },
    { method: "get", path: "/support/queues", permission: "support:tickets:view" },
    { method: "get", path: "/support/views", permission: "support:tickets:view" },
    { method: "get", path: "/support/tags", permission: "support:tickets:view" },
    { method: "get", path: "/support/1/watchers", permission: "support:tickets:view" },
    { method: "post", path: "/support/1/follow", permission: "support:tickets:view" },
    { method: "get", path: "/support/1/links", permission: "support:tickets:view" },
    { method: "get", path: "/support/ably-token", permission: "support:tickets:view" },
    {
      method: "post",
      path: "/support/queues",
      permission: "support:queues:manage",
      body: { name: "Billing" },
    },
    {
      method: "post",
      path: "/support/tags",
      permission: "support:tags:manage",
      body: { name: "billing" },
    },
    {
      method: "post",
      path: "/support/1/links",
      permission: "support:tickets:manage",
      body: { linkedTicketId: 2, relation: "related" },
    },
    {
      method: "post",
      path: "/support/1/merge",
      permission: "support:tickets:manage",
      body: { intoTicketId: 2 },
    },
    { method: "get", path: "/support/business-hours", permission: "support:settings:manage" },
    {
      method: "post",
      path: "/support/business-hours",
      permission: "support:settings:manage",
      body: { name: "9-5 weekdays" },
    },
    { method: "get", path: "/support/sla-policies", permission: "support:settings:manage" },
    {
      method: "post",
      path: "/support/sla-policies",
      permission: "support:settings:manage",
      body: { name: "Default", firstResponseTargetMins: 60, resolutionTargetMins: 1440 },
    },
    { method: "post", path: "/support/sla/run-escalations", permission: "support:settings:manage" },
    { method: "get", path: "/support/1/risk", permission: "support:tickets:view" },
    { method: "get", path: "/support/channels", permission: "support:channels:manage" },
    {
      method: "post",
      path: "/support/channels",
      permission: "support:channels:manage",
      body: { type: "email", name: "Support inbox" },
    },
    { method: "get", path: "/support/portal/tickets", permission: "support:portal:tickets:view" },
    {
      method: "post",
      path: "/support/portal/tickets",
      permission: "support:portal:tickets:create",
      body: { title: "My printer is broken", description: "It won't turn on." },
    },
    { method: "get", path: "/support/portal/tickets/1", permission: "support:portal:tickets:view" },
    {
      method: "post",
      path: "/support/portal/tickets/1/messages",
      permission: "support:portal:tickets:reply",
      body: { body: "following up" },
    },
    { method: "get", path: "/support/automations", permission: "support:settings:manage" },
    {
      method: "post",
      path: "/support/automations",
      permission: "support:settings:manage",
      body: { name: "Auto-tag urgent", triggerEvent: "ticket.created", actions: [] },
    },
    { method: "post", path: "/support/automations/1/test", permission: "support:settings:manage" },
    { method: "get", path: "/support/automation-runs", permission: "support:settings:manage" },
    { method: "get", path: "/support/1/ai/suggestions", permission: "support:tickets:view" },
    { method: "post", path: "/support/1/ai/analyze", permission: "support:tickets:view" },
    { method: "post", path: "/support/1/ai/find-duplicates", permission: "support:tickets:view" },
    { method: "post", path: "/support/1/ai/suggest-kb-articles", permission: "support:tickets:view" },
    { method: "post", path: "/support/1/ai/suggest-reply", permission: "support:tickets:reply" },
    { method: "post", path: "/support/1/ai/suggest-macro", permission: "support:tickets:reply" },
    {
      method: "post",
      path: "/support/ai-suggestions/1/resolve",
      permission: "support:tickets:reply",
      body: { status: "accepted" },
    },
    { method: "get", path: "/support/reports/overview", permission: "support:reports:view" },
    { method: "get", path: "/support/reports/agent-performance", permission: "support:reports:view" },
    { method: "get", path: "/support/reports/queue-performance", permission: "support:reports:view" },
    { method: "get", path: "/support/reports/channel-performance", permission: "support:reports:view" },
    { method: "get", path: "/support/reports/automation-performance", permission: "support:reports:view" },
  ];

  it.each(ticketPermissionCases)(
    "403 on $method $path without $permission",
    async ({ method, path, body }) => {
      const token = await signToken({ permissions: [], enabledModules: ["support"] });
      const req = callRoute(method, path).set("Authorization", `Bearer ${token}`);
      const res = body ? await req.send(body) : await req;
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Permission denied" });
    },
  );

  it("403 on POST /support/1/messages with isInternal:true when granted only support:tickets:reply", async () => {
    const token = await signToken({
      permissions: ["support:tickets:reply"],
      enabledModules: ["support"],
    });
    const res = await request(app.getHttpServer())
      .post("/support/1/messages")
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "internal note attempt", isInternal: true });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("404 MODULE_DISABLED on GET /support when support module is disabled", async () => {
    const token = await signToken({ permissions: ["support:tickets:view"], enabledModules: [] });
    const res = await request(app.getHttpServer()).get("/support").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "MODULE_DISABLED" });
  });

  it("403 on POST /support/queues with only support:tickets:view (needs support:queues:manage)", async () => {
    const token = await signToken({ permissions: ["support:tickets:view"], enabledModules: ["support"] });
    const res = await request(app.getHttpServer())
      .post("/support/queues")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Billing" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  describe("POST /support/inbound/email/:orgId (webhook, no JWT)", () => {
    it("401 when the webhook secret is missing, even with no auth token at all", async () => {
      const res = await request(app.getHttpServer())
        .post("/support/inbound/email/org_1")
        .send({ messageId: "abc", fromEmail: "customer@example.com", bodyText: "help" });
      expect(res.status).toBe(401);
    });

    it("401 when the webhook secret is wrong", async () => {
      const res = await request(app.getHttpServer())
        .post("/support/inbound/email/org_1")
        .set("X-Webhook-Secret", "wrong-secret")
        .send({ messageId: "abc", fromEmail: "customer@example.com", bodyText: "help" });
      expect(res.status).toBe(401);
    });
  });

  describe("GET/POST /support/csat/:token (public, no JWT)", () => {
    it("404 on GET with an unknown token, no auth token required", async () => {
      const res = await request(app.getHttpServer()).get("/support/csat/not-a-real-token");
      expect(res.status).toBe(404);
    });

    it("404 on POST with an unknown token", async () => {
      const res = await request(app.getHttpServer())
        .post("/support/csat/not-a-real-token")
        .send({ score: 5 });
      expect(res.status).toBe(404);
    });
  });
});
