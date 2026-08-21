import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DrizzleModule } from "../../../db/drizzle.module";
import { AiModule } from "./ai.module";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { ALL_MODULES, signToken } from "../../../../test/helpers/sign-token";

describe("AI auth/RBAC (e2e)", () => {
  let app: INestApplication;
  let savedOpenAiKey: string | undefined;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    savedOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const ref = await Test.createTestingModule({ imports: [DrizzleModule, AiModule] }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
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
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("does NOT require auth on POST /public/kb/ask (public route)", async () => {
    const res = await request(app.getHttpServer()).post("/public/kb/ask").send({ org: "org_1", question: "hello there" });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "AI assistant is not available" });
  });

  it("403 on POST /ai/attrition-risk without hr:employees manage", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const token = await signToken({ permissions: ["crm:leads:read"], enabledModules: ALL_MODULES });
      const res = await request(app.getHttpServer())
        .post("/ai/attrition-risk")
        .set("Authorization", `Bearer ${token}`)
        .send({ userId: "user_2" });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Only admins can analyze attrition risk" });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("403 on POST /ai/generate-review without hr:performance manage", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const token = await signToken({ permissions: ["crm:leads:read"], enabledModules: ALL_MODULES });
      const res = await request(app.getHttpServer())
        .post("/ai/generate-review")
        .set("Authorization", `Bearer ${token}`)
        .send({ userId: "user_2", periodStart: "2026-01-01", periodEnd: "2026-03-31" });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Only admins/managers can generate reviews" });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("402 on POST /ai/score-candidate when plan lacks the feature", async () => {
    const token = await signToken({ plan: "FREE" });
    const res = await request(app.getHttpServer())
      .post("/ai/score-candidate")
      .set("Authorization", `Bearer ${token}`)
      .send({ candidateId: 1 });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ requiredPlan: "PROFESSIONAL" });
  });
});
