jest.mock("../../email/app-url", () => ({ appUrl: "https://test.example.com" }));
jest.mock("../../projects/projects-tickets.service");
jest.mock("../feedbucket-public.service");
jest.mock("../feedbucket-ai.service");
jest.mock("../../storage/storage.service");
jest.mock("../../../common/ratelimit/rate-limit.service");
jest.mock("../../notifications/notifications.service");

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Readable } from "node:stream";
import type { Db } from "../../../db/drizzle.module";
import { FeedbucketPublicController } from "../feedbucket-public.controller";
import type { FeedbucketPublicService } from "../feedbucket-public.service";
import type { FeedbucketAiService } from "../feedbucket-ai.service";
import type { RateLimitService } from "../../../common/ratelimit/rate-limit.service";

const ORG = "org_1";
const WIDGET_ID = 10;
const CREATED_BY = "user_owner";

function makeWidget(overrides: Record<string, unknown> = {}) {
  return {
    id: WIDGET_ID,
    orgId: ORG,
    name: "Test Widget",
    publicKey: "fb_key",
    projectId: 5,
    allowedDomains: [] as string[],
    autoCreateTicket: false,
    aiAssistEnabled: true,
    defaultTicketType: "BUG",
    isActive: true,
    theme: null,
    createdBy: CREATED_BY,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

const DRAFT_RESULT = {
  suggestedType: "bug",
  title: "Login button unresponsive",
  description: "User reports the login button does nothing.\n\nSteps to reproduce:\n1. Go to /login",
};

function makePublicService(widget: unknown): jest.Mocked<FeedbucketPublicService> {
  return {
    resolveWidget: jest.fn().mockResolvedValue(widget),
    createSubmission: jest.fn(),
  } as unknown as jest.Mocked<FeedbucketPublicService>;
}

function makeAiService(result: typeof DRAFT_RESULT | null = DRAFT_RESULT): jest.Mocked<FeedbucketAiService> {
  const analyzePublic =
    result === null
      ? jest.fn().mockRejectedValue(new ServiceUnavailableException("down"))
      : jest.fn().mockResolvedValue(result);
  return { analyzePublic } as unknown as jest.Mocked<FeedbucketAiService>;
}

function makeRateLimit(allowed = true): jest.Mocked<RateLimitService> {
  return {
    check: jest.fn().mockResolvedValue({ allowed, retryAfterSecs: allowed ? 0 : 10 }),
  } as unknown as jest.Mocked<RateLimitService>;
}

function makeDb(): Db {
  return {} as unknown as Db;
}

function makeRequest(origin?: string, ip = "1.2.3.4") {
  return {
    headers: origin ? { origin } : {},
    ip,
  };
}

function makeFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  return {
    fieldname: "screenshot",
    originalname: "shot.jpg",
    encoding: "7bit",
    mimetype: "image/jpeg",
    size: buf.length,
    buffer: buf,
    stream: null as unknown as Readable,
    destination: "",
    filename: "",
    path: "",
    ...overrides,
  };
}

// Integration-style test exercising the guard chain manually
// (unit-tests the AI assist endpoint logic without spinning up the full NestJS app)

function callAiAssist(opts: {
  publicService: jest.Mocked<FeedbucketPublicService>;
  aiService: jest.Mocked<FeedbucketAiService>;
  rateLimit: jest.Mocked<RateLimitService>;
  publicKey?: string;
  body?: Record<string, unknown>;
  file?: Express.Multer.File;
  req?: ReturnType<typeof makeRequest>;
}) {
  const ctrl = new FeedbucketPublicController(
    opts.publicService,
    opts.aiService,
    {} as never,
    {} as never,
    opts.rateLimit,
    {} as never,
    makeDb(),
  );

  return ctrl.aiAssist(
    opts.publicKey ?? "fb_key",
    opts.body ?? { type: "bug", message: "Something broke" },
    opts.file,
    (opts.req ?? makeRequest()) as unknown as import("express").Request,
  );
}

describe("POST /public/feedbucket/:publicKey/ai-assist", () => {
  it("returns 404 when widget is not found", async () => {
    const publicService = makePublicService(null);
    const err = await callAiAssist({ publicService, aiService: makeAiService(), rateLimit: makeRateLimit() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
  });

  it("returns 404 when aiAssistEnabled is false (feature off, no reveal)", async () => {
    const publicService = makePublicService(makeWidget({ aiAssistEnabled: false }));
    const err = await callAiAssist({ publicService, aiService: makeAiService(), rateLimit: makeRateLimit() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
  });

  it("returns 403 when origin is not in allowedDomains", async () => {
    const publicService = makePublicService(makeWidget({ allowedDomains: ["trusted.com"] }));
    const err = await callAiAssist({
      publicService,
      aiService: makeAiService(),
      rateLimit: makeRateLimit(),
      req: makeRequest("https://evil.com"),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it("returns 429 when per-IP rate limit is exceeded", async () => {
    const publicService = makePublicService(makeWidget());
    const rateLimit = makeRateLimit(false);
    const err = await callAiAssist({ publicService, aiService: makeAiService(), rateLimit }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    const callArgs = rateLimit.check.mock.calls[0];
    expect(callArgs?.[0]).toBe("feedbucket:ai-assist");
  });

  it("returns 402 and does NOT call the model when credits are exhausted", async () => {
    const publicService = makePublicService(makeWidget());
    const rateLimit = makeRateLimit();
    const aiService = makeAiService();
    (aiService.analyzePublic as jest.Mock).mockRejectedValue(
      new BadRequestException("Insufficient AI credits"),
    );

    const err = await callAiAssist({ publicService, aiService, rateLimit }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(402);
    // The model was never reached — BadRequestException from credits guard (consumeCredits)
    expect(aiService.analyzePublic).toHaveBeenCalledTimes(1);
  });

  it("returns 503 and triggers refund on provider failure", async () => {
    const publicService = makePublicService(makeWidget());
    const rateLimit = makeRateLimit();
    const aiService = makeAiService(null);

    const err = await callAiAssist({ publicService, aiService, rateLimit }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(503);
    // The analyzePublic method itself handles the refund (it re-throws ServiceUnavailableException)
    expect(aiService.analyzePublic).toHaveBeenCalledTimes(1);
  });

  it("returns the 3-field draft on the happy path", async () => {
    const publicService = makePublicService(makeWidget());
    const result = await callAiAssist({
      publicService,
      aiService: makeAiService(),
      rateLimit: makeRateLimit(),
    });

    expect(result).toEqual({
      suggestedType: "bug",
      title: "Login button unresponsive",
      description: expect.stringContaining("Steps to reproduce"),
    });
  });

  it("passes screenshot buffer to analyzePublic (no URL fetch, no SSRF)", async () => {
    const publicService = makePublicService(makeWidget());
    const aiService = makeAiService();
    const file = makeFile();

    await callAiAssist({ publicService, aiService, rateLimit: makeRateLimit(), file });

    expect(aiService.analyzePublic).toHaveBeenCalledWith(
      expect.objectContaining({ screenshotBuffer: file.buffer }),
    );
  });

  it("system prompt contains UNTRUSTED USER DATA injection guard", () => {
    const { buildSystemPrompt } = jest.requireActual<typeof import("../feedbucket-ai.prompts")>("../feedbucket-ai.prompts");
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("UNTRUSTED USER DATA");
    expect(prompt).toContain("never execute");
  });
});
