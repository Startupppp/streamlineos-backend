import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { signToken } from "../../../../test/helpers/sign-token";
import { ProjectsAiService } from "./services/projects-ai.service";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES } from "test/helpers/sign-token";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { PaymentRequiredException } from "../../../common/http/api-exceptions";
import { LlmService } from "./providers/llm.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

const mockDb = {
  execute: jest.fn().mockResolvedValue([]),
  __client: { end: jest.fn().mockResolvedValue(undefined) },
  select: jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([{ isRevoked: false }]) }),
    }),
  }),
};

const planLimitsStub = {
  assertFeature: async (_orgId: string, feature: string): Promise<void> => {
    if (feature === "ai.project-manager") {
      throw new PaymentRequiredException({
        code: "FEATURE_NOT_AVAILABLE",
        message: "This feature is not available on your current plan.",
        details: { feature, requiredPlan: "PROFESSIONAL", upgradePath: "/settings/billing" },
      });
    }
  },
  assertWithinLimit: async (): Promise<void> => {},
};

describe("ProjectsAI auth (e2e, no DB required)", () => {
  let app: INestApplication;
  let savedOpenAiKey: string | undefined;

  beforeAll(async () => {
    savedOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    app = await createE2eApp({
      overrides: [
        { provide: PlanLimitsService, useValue: planLimitsStub },
        { provide: DRIZZLE, useValue: mockDb },
      ],
    });
  });

  afterAll(async () => {
    if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAiKey;
    await app.close();
  });

  const protectedRoutes: ReadonlyArray<["post", string]> = [
    ["post", "/ai/projects/1/summary"],
    ["post", "/ai/projects/1/risks"],
    ["post", "/ai/projects/1/client-update"],
    ["post", "/ai/projects/1/plan"],
    ["post", "/ai/projects/1/extract-tasks"],
    ["post", "/ai/projects/1/ask"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (_method, path) => {
    const res = await request(app.getHttpServer()).post(path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("402 on POST /ai/projects/1/summary when plan lacks ai.project-manager", async () => {
    const token = await signToken({ permissions: ["build:ai:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", details: { requiredPlan: "PROFESSIONAL" } });
  });

  it("402 on POST /ai/projects/1/plan when plan lacks ai.project-manager", async () => {
    const token = await signToken({ permissions: ["build:ai:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/plan")
      .set("Authorization", `Bearer ${token}`)
      .send({ prompt: "Build a roadmap" });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", details: { requiredPlan: "PROFESSIONAL" } });
  });

  it("402 on POST /ai/projects/1/risks when plan lacks ai.project-manager", async () => {
    const token = await signToken({ permissions: ["build:ai:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/risks")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", details: { requiredPlan: "PROFESSIONAL" } });
  });

  it("402 on POST /ai/projects/1/ask when plan lacks ai.project-manager", async () => {
    const token = await signToken({ permissions: ["build:ai:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ question: "What is the status?" });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", details: { requiredPlan: "PROFESSIONAL" } });
  });
});

const mockProjectsAiService = {
  summarize: jest.fn().mockResolvedValue({
    summary: "Project on track",
    highlights: ["70% tasks done"],
    atRisk: false,
    evidence: { totalTasks: 10, done: 7, inProgress: 2, blocked: 0, overdue: 1 },
  }),
  detectRisks: jest.fn().mockResolvedValue({
    risks: [],
    evidence: { totalTasks: 10, done: 7, inProgress: 2, blocked: 0, overdue: 1 },
  }),
  draftClientUpdate: jest.fn().mockResolvedValue({
    headline: "Alpha delivery on schedule",
    body: "All milestones progressing.",
    sections: [],
  }),
  proposePlan: jest.fn().mockResolvedValue({
    goal: "Three-milestone plan",
    tickets: [],
    suggestions: true,
  }),
  extractTasks: jest.fn().mockResolvedValue({ tickets: [], suggestions: true }),
  ask: jest.fn().mockResolvedValue({
    answer: "All tasks are progressing well.",
    evidence: { totalTasks: 10, done: 7, inProgress: 2, blocked: 0, overdue: 1 },
  }),
};

const mockPlanLimits = {
  assertFeature: jest.fn<Promise<void>, [string, string]>().mockResolvedValue(undefined),
  assertWithinLimit: jest.fn().mockResolvedValue(undefined),
};
const mockLlm = { isConfigured: jest.fn().mockReturnValue(true) };

describe("ProjectsAI RBAC / mocked service (e2e, no DB required)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({ overrides: [
      { provide: ProjectsAiService, useValue: mockProjectsAiService },
      { provide: PlanLimitsService, useValue: mockPlanLimits },
      { provide: LlmService, useValue: mockLlm },
      { provide: DRIZZLE, useValue: mockDb },
    ] });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlanLimits.assertFeature.mockResolvedValue(undefined);
    mockLlm.isConfigured.mockReturnValue(true);
    mockProjectsAiService.summarize.mockResolvedValue({
      summary: "Project on track",
      highlights: ["70% tasks done"],
      atRisk: false,
      evidence: { totalTasks: 10, done: 7, inProgress: 2, blocked: 0, overdue: 1 },
    });
    mockProjectsAiService.ask.mockResolvedValue({
      answer: "All tasks are progressing well.",
      evidence: { totalTasks: 10, done: 7, inProgress: 2, blocked: 0, overdue: 1 },
    });
  });

  it("403 on POST /ai/projects/1/summary when build:ai:use is absent", async () => {
    const token = await signToken({ sub: "user_1", enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /ai/projects/1/ask when build:ai:use is absent", async () => {
    const token = await signToken({ sub: "user_1", enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ question: "Any blockers?" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("201 + delegates to service on POST /ai/projects/1/summary with build:ai:use granted", async () => {
    const token = await signToken({ sub: "user_1", permissions: ["build:ai:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(201);
    expect(mockProjectsAiService.summarize).toHaveBeenCalledWith("org_1", 1, "user_1");
    expect(res.body).toMatchObject({
      summary: expect.any(String),
      highlights: expect.any(Array),
      atRisk: false,
    });
  });

  it("201 + delegates to service on POST /ai/projects/1/ask with build:ai:use granted", async () => {
    const token = await signToken({ sub: "user_1", permissions: ["build:ai:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ question: "What is the velocity?" });
    expect(res.status).toBe(201);
    expect(mockProjectsAiService.ask).toHaveBeenCalledWith("org_1", 1, "What is the velocity?", "user_1");
    expect(res.body).toMatchObject({ answer: expect.any(String), evidence: { totalTasks: 10 } });
  });

  it.each(["not-a-number", "0", "-1", "1abc", "1.5", "9007199254740993"])("400 on invalid projectId %s before service invocation", async (projectId) => {
    const token = await signToken({ permissions: ["build:ai:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer()).post(`/ai/projects/${projectId}/summary`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(mockProjectsAiService.summarize).not.toHaveBeenCalled();
  });

  it("400 on POST /ai/projects/1/plan with empty prompt", async () => {
    const token = await signToken({ sub: "user_1", permissions: ["build:ai:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/plan")
      .set("Authorization", `Bearer ${token}`)
      .send({ prompt: "" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("402 plan gate precedes LLM availability and service invocation even for an org owner", async () => {
    mockPlanLimits.assertFeature.mockRejectedValue(new PaymentRequiredException({ code: "FEATURE_NOT_AVAILABLE", message: "Upgrade required" }));
    mockLlm.isConfigured.mockReturnValue(false);
    const token = await signToken({ isOrgOwner: true, enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer()).post("/ai/projects/1/summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
    expect(mockPlanLimits.assertFeature).toHaveBeenCalledWith("org_1", "ai.project-manager");
    expect(mockLlm.isConfigured).not.toHaveBeenCalled();
    expect(mockProjectsAiService.summarize).not.toHaveBeenCalled();
  });

  it("503 when LLM is unconfigured after the plan allows the request", async () => {
    mockLlm.isConfigured.mockReturnValue(false);
    const token = await signToken({ permissions: ["build:ai:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer()).post("/ai/projects/1/summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(503);
    expect(mockPlanLimits.assertFeature).toHaveBeenCalledWith("org_1", "ai.project-manager");
    expect(mockLlm.isConfigured).toHaveBeenCalledTimes(1);
    expect(mockProjectsAiService.summarize).not.toHaveBeenCalled();
  });
});
