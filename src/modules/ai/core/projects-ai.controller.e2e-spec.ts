import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { signToken } from "../../../../test/helpers/sign-token";
import { ProjectsAiService } from "./services/projects-ai.service";
import { AccessService } from "../../access/access.service";

const RBAC_E2E_DATABASE_URL = process.env.RBAC_E2E_DATABASE_URL;
const describeWithDb = RBAC_E2E_DATABASE_URL ? describe : describe.skip;

describe("ProjectsAI auth (e2e, no DB required)", () => {
  let app: INestApplication;
  let savedOpenAiKey: string | undefined;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    savedOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
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
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("402 on POST /ai/projects/1/summary when plan lacks ai.project-manager (FREE plan)", async () => {
    const token = await signToken({ plan: "FREE", isOrgOwner: true });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ requiredPlan: "PROFESSIONAL" });
  });

  it("402 on POST /ai/projects/1/plan when plan lacks ai.project-manager", async () => {
    const token = await signToken({ plan: "STARTER", isOrgOwner: true });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/plan")
      .set("Authorization", `Bearer ${token}`)
      .send({ prompt: "Build a roadmap" });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ requiredPlan: "PROFESSIONAL" });
  });

  it("503 on POST /ai/projects/1/risks when OPENAI_API_KEY is not set (PROFESSIONAL plan)", async () => {
    const token = await signToken({ plan: "PROFESSIONAL", isOrgOwner: true });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/risks")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: expect.stringContaining("not configured") });
  });

  it("503 on POST /ai/projects/1/ask when OPENAI_API_KEY is not set", async () => {
    const token = await signToken({ plan: "PROFESSIONAL", isOrgOwner: true });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ question: "What is the status?" });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: expect.stringContaining("not configured") });
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
    summary: "Three-milestone plan",
    milestones: [],
    suggestions: true,
  }),
  extractTasks: jest.fn().mockResolvedValue({ tasks: [], suggestions: true }),
  ask: jest.fn().mockResolvedValue({
    answer: "All tasks are progressing well.",
    confidence: "high",
    evidence: { totalTasks: 10, done: 7, inProgress: 2, blocked: 0, overdue: 1 },
  }),
};

const mockAccessService = {
  resolveUserPermissions: jest.fn().mockResolvedValue(
    new Map<string, "all" | "own" | "team" | "none">([["build:ai:use", "all"]]),
  ),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
};

describeWithDb("ProjectsAI RBAC / mocked service (e2e)", () => {
  let app: INestApplication;
  let savedOpenAiKey: string | undefined;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= process.env.RBAC_E2E_DATABASE_URL ?? "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    savedOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";

    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ProjectsAiService)
      .useValue(mockProjectsAiService)
      .overrideProvider(AccessService)
      .useValue(mockAccessService)
      .compile();

    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAiKey;
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockAccessService.resolveUserPermissions.mockResolvedValue(
      new Map<string, "all" | "own" | "team" | "none">([["build:ai:use", "all"]]),
    );
    mockAccessService.isModuleEnabled.mockResolvedValue(true);
    mockProjectsAiService.summarize.mockResolvedValue({
      summary: "Project on track",
      highlights: ["70% tasks done"],
      atRisk: false,
      evidence: { totalTasks: 10, done: 7, inProgress: 2, blocked: 0, overdue: 1 },
    });
    mockProjectsAiService.ask.mockResolvedValue({
      answer: "All tasks are progressing well.",
      confidence: "high",
      evidence: { totalTasks: 10, done: 7, inProgress: 2, blocked: 0, overdue: 1 },
    });
  });

  it("403 on POST /ai/projects/1/summary when projects:ai:use is absent", async () => {
    mockAccessService.resolveUserPermissions.mockResolvedValue(new Map());
    const token = await signToken({ permissions: [], enabledModules: ["projects"], isOrgOwner: false });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on POST /ai/projects/1/ask when projects:ai:use is absent", async () => {
    mockAccessService.resolveUserPermissions.mockResolvedValue(new Map());
    const token = await signToken({ permissions: [], enabledModules: ["projects"], isOrgOwner: false });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ question: "Any blockers?" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("200 + delegates to service on POST /ai/projects/1/summary with projects:ai:use granted", async () => {
    const token = await signToken({
      permissions: ["build:ai:use"],
      enabledModules: ["projects"],
      isOrgOwner: false,
      plan: "PROFESSIONAL",
    });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(mockProjectsAiService.summarize).toHaveBeenCalledWith("org_1", 1, "user_1");
    expect(res.body).toMatchObject({
      summary: expect.any(String),
      highlights: expect.any(Array),
      atRisk: false,
    });
  });

  it("200 + delegates to service on POST /ai/projects/1/ask with projects:ai:use granted", async () => {
    const token = await signToken({
      permissions: ["build:ai:use"],
      enabledModules: ["projects"],
      isOrgOwner: false,
      plan: "PROFESSIONAL",
    });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ question: "What is the velocity?" });
    expect(res.status).toBe(200);
    expect(mockProjectsAiService.ask).toHaveBeenCalledWith("org_1", 1, "What is the velocity?", "user_1");
    expect(res.body).toMatchObject({ answer: expect.any(String), confidence: expect.any(String) });
  });

  it.todo("400 on non-numeric projectId (controller uses string param with no ParseIntPipe; NaN passes through to service; would need a pipe added to enforce this)");

  it("400 on POST /ai/projects/1/plan with empty prompt", async () => {
    const token = await signToken({
      permissions: ["build:ai:use"],
      enabledModules: ["projects"],
      isOrgOwner: false,
      plan: "PROFESSIONAL",
    });
    const res = await request(app.getHttpServer())
      .post("/ai/projects/1/plan")
      .set("Authorization", `Bearer ${token}`)
      .send({ prompt: "" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Validation failed") });
  });

  it.todo("402 on plan gate fires before service (orgOwner bypass not needed — plan check is in controller)");
  it.todo("503 on ensureLlm when LlmService.isConfigured() returns false (requires LlmService override)");
});
