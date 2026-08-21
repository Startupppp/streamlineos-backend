import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { PaymentRequiredException } from "../../../common/http/api-exceptions";

const planLimitsStub = {
  assertFeature: async (_orgId: string, feature: string): Promise<void> => {
    if (feature === "ai.candidate-scoring") {
      throw new PaymentRequiredException({
        code: "FEATURE_NOT_AVAILABLE",
        message: "This feature is not available on your current plan.",
        details: { feature, requiredPlan: "PROFESSIONAL", upgradePath: "/settings/billing" },
      });
    }
  },
  assertWithinLimit: async (): Promise<void> => {},
};

describe("AI auth/RBAC (e2e)", () => {
  let app: INestApplication;
  let savedOpenAiKey: string | undefined;

  beforeAll(async () => {
    savedOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    app = await createE2eApp({
      overrides: [{ provide: PlanLimitsService, useValue: planLimitsStub }],
    });
  });

  afterAll(async () => {
    if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAiKey;
    await app.close();
  });

  type Method = "get" | "post";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    return method === "get" ? agent.get(path) : agent.post(path);
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["post", "/ai/score-lead"],
    ["post", "/ai/predict-deal"],
    ["post", "/ai/churn-risk"],
    ["post", "/ai/next-action"],
    ["post", "/ai/account-summary"],
    ["post", "/ai/meeting-prep"],
    ["post", "/ai/nl-search"],
    ["post", "/ai/enrich-lead"],
    ["post", "/ai/generate-email"],
    ["post", "/ai/objection-handler"],
    ["post", "/ai/sentiment-analysis"],
    ["post", "/ai/summarize"],
    ["post", "/ai/report-narrator"],
    ["post", "/ai/attrition-risk"],
    ["post", "/ai/generate-review"],
    ["post", "/ai/generate-jd"],
    ["post", "/ai/score-candidate"],
    ["post", "/ai/helpdesk-reply"],
    ["get", "/ai/prioritize-tasks"],
    ["get", "/ai/suggestions"],
    ["post", "/chat"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("does NOT require auth on POST /public/kb/ask (public route)", async () => {
    const res = await request(app.getHttpServer()).post("/public/kb/ask").send({ org: "org_1", question: "hello there" });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "AI assistant is not available" });
  });

  it("403 on POST /ai/attrition-risk without hr:employees:manage", async () => {
    const token = await signToken({ permissions: ["crm:leads:read"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/ai/attrition-risk")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: "user_2" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /ai/generate-review without hr:performance:manage", async () => {
    const token = await signToken({ permissions: ["crm:leads:read"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/ai/generate-review")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: "user_2", periodStart: "2026-01-01", periodEnd: "2026-03-31" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("402 on POST /ai/score-candidate when plan lacks the feature", async () => {
    const token = await signToken({ permissions: ["hr:interviews:manage"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/ai/score-candidate")
      .set("Authorization", `Bearer ${token}`)
      .send({ candidateId: 1 });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", details: { requiredPlan: "PROFESSIONAL" } });
  });
});
