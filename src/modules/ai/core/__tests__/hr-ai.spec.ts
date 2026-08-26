import "reflect-metadata";
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  INestApplication,
} from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { HrAiController } from "../controllers/hr-ai.controller";
import { HrAiService } from "../services/hr-ai.service";
import { LlmService } from "../providers/llm.service";
import { PlanLimitsService } from "../../../billing/core/plan-limits.service";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

const USER_CTX: CurrentUserContext = {
  userId: "user1",
  orgId: "org1",
  role: "ADMIN",
  isOrgOwner: false,
  sessionId: "sess1",
  tokenScopes: null,
};

class PassAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ user?: CurrentUserContext }>();
    req.user = USER_CTX;
    return true;
  }
}

class DenyPermissionGuard implements CanActivate {
  canActivate(): never {
    throw new ForbiddenException();
  }
}

class PassGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

const makeMockHrAiService = () => ({
  analyzeAttritionRisk: jest.fn(),
  generateReview: jest.fn(),
  generateJd: jest.fn(),
  scoreCandidate: jest.fn(),
  suggestHelpdeskReply: jest.fn(),
  policyQa: jest.fn(),
  generateInterviewKit: jest.fn(),
  draftLetter: jest.fn(),
  summarizeInterviewNotes: jest.fn(),
  acceptCandidateScore: jest.fn(),
});

const mockLlmService = {
  isConfigured: jest.fn().mockReturnValue(true),
};

async function buildApp(options: {
  denyPermission?: boolean;
}): Promise<{ app: INestApplication; hrService: ReturnType<typeof makeMockHrAiService> }> {
  const hrService = makeMockHrAiService();

  const moduleRef: TestingModule = await Test.createTestingModule({
    controllers: [HrAiController],
    providers: [
      { provide: HrAiService, useValue: hrService },
      { provide: LlmService, useValue: mockLlmService },
      { provide: PlanLimitsService, useValue: { assertFeature: jest.fn().mockResolvedValue(undefined) } },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useClass(PassAuthGuard)
    .overrideGuard(PermissionGuard)
    .useClass(options.denyPermission ? DenyPermissionGuard : PassGuard)
    .overrideGuard(RateLimitGuard)
    .useClass(PassGuard)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, hrService };
}

describe("HrAiController — policy-qa", () => {
  let app: INestApplication;
  let hrService: ReturnType<typeof makeMockHrAiService>;

  beforeAll(async () => {
    ({ app, hrService } = await buildApp({}));
  });

  afterAll(() => app.close());

  beforeEach(() => jest.clearAllMocks());

  it("returns answer with citations when policy found", async () => {
    hrService.policyQa.mockResolvedValue({
      answer: "You get 12 days annual leave",
      confidence: "high",
      citations: [{ policyType: "LEAVE", policyId: 1, snippet: "Annual leave: 12 days" }],
      shouldEscalate: false,
      suggestTicket: false,
    });

    const res = await request(app.getHttpServer())
      .post("/ai/hr/policy-qa")
      .send({ question: "How many leave days do I get?" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("answer", "You get 12 days annual leave");
    expect(Array.isArray(res.body.citations)).toBe(true);
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.suggestTicket).toBe(false);
  });

  it("escalates and suggests ticket when no policy found", async () => {
    hrService.policyQa.mockResolvedValue({
      answer: "I couldn't find a policy on this",
      confidence: "not_found",
      citations: [],
      shouldEscalate: true,
      escalationReason: "No matching policy found",
      suggestTicket: true,
    });

    const res = await request(app.getHttpServer())
      .post("/ai/hr/policy-qa")
      .send({ question: "What is the stock option vesting?" });

    expect(res.status).toBe(201);
    expect(res.body.shouldEscalate).toBe(true);
    expect(res.body.suggestTicket).toBe(true);
  });

  it("passes question to hr.policyQa (integration contract)", async () => {
    hrService.policyQa.mockResolvedValue({
      answer: "Test answer",
      confidence: "high",
      citations: [],
      shouldEscalate: false,
      suggestTicket: false,
    });

    const question = "Do we have a remote work policy?";
    await request(app.getHttpServer())
      .post("/ai/hr/policy-qa")
      .send({ question });

    expect(hrService.policyQa).toHaveBeenCalled();
    const callArgs: unknown[] = hrService.policyQa.mock.calls[0] as unknown[];
    expect(callArgs).toContain(question);
  });
});

describe("HrAiController — score-candidate (advisory-only, D1 change)", () => {
  let app: INestApplication;
  let hrService: ReturnType<typeof makeMockHrAiService>;

  beforeAll(async () => {
    ({ app, hrService } = await buildApp({}));
  });

  afterAll(() => app.close());

  beforeEach(() => jest.clearAllMocks());

  it("returns advisory=true with disclaimer and does NOT auto-call acceptCandidateScore", async () => {
    hrService.scoreCandidate.mockResolvedValue({
      score: 82,
      fitLevel: "good",
      reasoning: "Strong match",
      strengths: ["Python"],
      concerns: [],
      suggestedQuestions: ["Q1"],
    });

    const res = await request(app.getHttpServer())
      .post("/ai/score-candidate")
      .send({ candidateId: 1, jobId: 1 });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("advisory", true);
    expect(res.body).toHaveProperty("disclaimer");
    expect(typeof res.body.disclaimer).toBe("string");
    expect(res.body.score).toBe(82);
    expect(hrService.acceptCandidateScore).not.toHaveBeenCalled();
  });
});

describe("HrAiController — accept-candidate-score", () => {
  let app: INestApplication;
  let hrService: ReturnType<typeof makeMockHrAiService>;

  beforeAll(async () => {
    ({ app, hrService } = await buildApp({}));
  });

  afterAll(() => app.close());

  beforeEach(() => jest.clearAllMocks());

  it("explicit accept calls hr.acceptCandidateScore and returns accepted=true", async () => {
    hrService.acceptCandidateScore.mockResolvedValue({ accepted: true });

    const res = await request(app.getHttpServer())
      .post("/ai/hr/accept-candidate-score")
      .send({ candidateId: 1, aiScore: 82 });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("accepted", true);
    expect(hrService.acceptCandidateScore).toHaveBeenCalledWith(
      USER_CTX.orgId,
      1,
      82,
    );
  });
});

describe("HrAiController — interview-kit", () => {
  let app: INestApplication;
  let hrService: ReturnType<typeof makeMockHrAiService>;

  beforeAll(async () => {
    ({ app, hrService } = await buildApp({}));
  });

  afterAll(() => app.close());

  beforeEach(() => jest.clearAllMocks());

  it("returns draft-only with advisory=true, disclaimer, and roundKits array", async () => {
    hrService.generateInterviewKit.mockResolvedValue({
      roundKits: [
        {
          round: "Technical",
          questions: [{ question: "Q1", category: "Coding", expectedAnswer: "A1", redFlags: [] }],
          rubric: [],
        },
      ],
    });

    const res = await request(app.getHttpServer())
      .post("/ai/hr/interview-kit")
      .send({ jobPostingId: 1 });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("advisory", true);
    expect(res.body).toHaveProperty("disclaimer");
    expect(typeof res.body.disclaimer).toBe("string");
    expect(Array.isArray(res.body.roundKits)).toBe(true);
    expect(res.body.roundKits).toHaveLength(1);
  });
});

describe("HrAiController — interview-notes-summary", () => {
  let app: INestApplication;
  let hrService: ReturnType<typeof makeMockHrAiService>;

  beforeAll(async () => {
    ({ app, hrService } = await buildApp({}));
  });

  afterAll(() => app.close());

  beforeEach(() => jest.clearAllMocks());

  it("returns structured brief with advisory=true and overallRecommendation", async () => {
    hrService.summarizeInterviewNotes.mockResolvedValue({
      overallRecommendation: "Strong hire",
      confidence: "high",
      strengthsSummary: "Excellent communicator",
      concernsSummary: "No concerns",
      roundSummaries: [],
      suggestedNextStep: "Extend offer",
    });

    const res = await request(app.getHttpServer())
      .post("/ai/hr/interview-notes-summary")
      .send({ candidateId: 1 });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("advisory", true);
    expect(res.body).toHaveProperty("overallRecommendation", "Strong hire");
  });
});

describe("HrAiController — permission gating", () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await buildApp({ denyPermission: true }));
  });

  afterAll(() => app.close());

  it("POST /ai/hr/policy-qa returns 403 when permission denied", async () => {
    const res = await request(app.getHttpServer())
      .post("/ai/hr/policy-qa")
      .send({ question: "test" });
    expect(res.status).toBe(403);
  });
});
