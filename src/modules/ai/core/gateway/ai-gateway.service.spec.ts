import { ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { Test, type TestingModule } from "@nestjs/testing";
import { z } from "zod";
import { AiGatewayService } from "./ai-gateway.service";
import { AI_CREDIT_LEDGER } from "./credit-ledger.interface";
import type { AiCreditLedger } from "./credit-ledger.interface";
import { LlmService } from "../providers/llm.service";
import { AiUsageService } from "../services/ai-usage.service";
import { AuditService } from "../../../../common/audit/audit.service";

const GreetingSchema = z.object({ message: z.string() });

const ACTOR = { orgId: "org_1", userId: "user_1" };
const PROMPT = { system: "You are helpful.", user: "Say hello" };
const FEATURE = "test.feature";

function makeLlm(overrides: Partial<{
  invokeTextWithUsage: jest.Mock;
  invokeStructuredWithUsage: jest.Mock;
}> = {}) {
  return {
    isConfigured: jest.fn().mockReturnValue(true),
    invokeTextWithUsage: overrides.invokeTextWithUsage ?? jest.fn().mockResolvedValue({
      text: "Hello!",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: "gpt-4o-mini",
    }),
    invokeStructuredWithUsage: overrides.invokeStructuredWithUsage ?? jest.fn().mockResolvedValue({
      data: { message: "Hello!" },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: "gpt-4o-mini",
    }),
  };
}

function makeLedger(overrides: Partial<AiCreditLedger> = {}): jest.Mocked<AiCreditLedger> {
  return {
    reserve: overrides.reserve ?? jest.fn().mockResolvedValue({ reservationId: 42 }),
    settle: overrides.settle ?? jest.fn().mockResolvedValue(undefined),
    release: overrides.release ?? jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<AiCreditLedger>;
}

async function buildModule(llmOverride?: ReturnType<typeof makeLlm>, ledgerOverride?: jest.Mocked<AiCreditLedger>) {
  const mockUsage = { track: jest.fn().mockResolvedValue(undefined) };
  const mockAudit = { log: jest.fn() };
  const llm = llmOverride ?? makeLlm();
  const ledger = ledgerOverride ?? makeLedger();

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AiGatewayService,
      { provide: LlmService, useValue: llm },
      { provide: AiUsageService, useValue: mockUsage },
      { provide: AuditService, useValue: mockAudit },
      { provide: AI_CREDIT_LEDGER, useValue: ledger },
    ],
  }).compile();

  return {
    svc: module.get(AiGatewayService),
    llm,
    ledger,
    mockUsage,
    mockAudit,
  };
}

describe("AiGatewayService", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("invokeText — success", () => {
    it("returns ok=true with text and usage", async () => {
      const { svc } = await buildModule();
      const result = await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBe("Hello!");
      expect(result.model).toBe("gpt-4o-mini");
      expect(result.usage.promptTokens).toBe(10);
      expect(result.usage.completionTokens).toBe(5);
      expect(result.usage.totalTokens).toBe(15);
      expect(result.correlationId).toBeDefined();
    });

    it("tracks usage and audits on success", async () => {
      const { svc, mockUsage, mockAudit } = await buildModule();
      await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });

      await new Promise((r) => setTimeout(r, 10));
      expect(mockUsage.track).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org_1", feature: FEATURE }));
      expect(mockAudit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "ai.invoke", orgId: "org_1" }));
    });
  });

  describe("invokeStructured — success", () => {
    it("returns ok=true with typed data", async () => {
      const { svc } = await buildModule();
      const result = await svc.invokeStructured({ actor: ACTOR, feature: FEATURE, prompt: PROMPT, schema: GreetingSchema });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual({ message: "Hello!" });
    });

    it("settles the ledger on success when charge is provided", async () => {
      const ledger = makeLedger();
      const { svc } = await buildModule(undefined, ledger);
      await svc.invokeStructured({
        actor: ACTOR,
        feature: FEATURE,
        prompt: PROMPT,
        schema: GreetingSchema,
        charge: true,
      });

      expect(ledger.reserve).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org_1", credits: 1000 }));
      await new Promise((r) => setTimeout(r, 10));
      expect(ledger.settle).toHaveBeenCalledWith(42, expect.objectContaining({ actualMilli: expect.any(Number) }));
    });
  });

  describe("provider failure", () => {
    it("returns provider_unavailable and releases ledger reservation", async () => {
      const llm = makeLlm({
        invokeTextWithUsage: jest.fn().mockRejectedValue(new ServiceUnavailableException("AI provider is temporarily unavailable")),
      });
      const ledger = makeLedger();
      const { svc } = await buildModule(llm, ledger);

      const result = await svc.invokeText({
        actor: ACTOR,
        feature: FEATURE,
        prompt: PROMPT,
        charge: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("provider_unavailable");
      expect(ledger.release).toHaveBeenCalledWith(42, "provider_error", "org_1");
    });

    it("returns not_configured when provider error message contains 'not configured'", async () => {
      const llm = makeLlm({
        invokeTextWithUsage: jest.fn().mockRejectedValue(new ServiceUnavailableException("AI provider is not configured correctly")),
      });
      const { svc } = await buildModule(llm);

      const result = await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("not_configured");
    });
  });

  describe("quota_exceeded", () => {
    it("returns quota_exceeded when ledger.reserve throws InsufficientAiCreditsException", async () => {
      const ledger = makeLedger({
        reserve: jest.fn().mockRejectedValue(new InsufficientAiCreditsException()),
      });
      const llm = makeLlm();
      const { svc } = await buildModule(llm, ledger);

      const result = await svc.invokeText({
        actor: ACTOR,
        feature: FEATURE,
        prompt: PROMPT,
        charge: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("quota_exceeded");
      expect(llm.invokeTextWithUsage).not.toHaveBeenCalled();
    });
  });

  describe("redaction", () => {
    it("redacts PII from prompt before passing to LlmService when redact=true (default)", async () => {
      const llm = makeLlm();
      const { svc } = await buildModule(llm);

      await svc.invokeText({
        actor: ACTOR,
        feature: FEATURE,
        prompt: { system: "System", user: "Email is test@example.com, SSN 123-45-6789" },
        redact: true,
      });

      const callArg = (llm.invokeTextWithUsage as jest.Mock).mock.calls[0][0] as { user: string };
      expect(callArg.user).not.toContain("test@example.com");
      expect(callArg.user).not.toContain("123-45-6789");
      expect(callArg.user).toContain("[REDACTED");
    });

    it("does not redact when redact=false", async () => {
      const llm = makeLlm();
      const { svc } = await buildModule(llm);

      await svc.invokeText({
        actor: ACTOR,
        feature: FEATURE,
        prompt: { system: "System", user: "Email is test@example.com" },
        redact: false,
      });

      const callArg = (llm.invokeTextWithUsage as jest.Mock).mock.calls[0][0] as { user: string };
      expect(callArg.user).toContain("test@example.com");
    });
  });

  describe("dedupe", () => {
    it("shares in-flight promise for identical dedupe calls", async () => {
      let resolveCall!: (v: string) => void;
      const blockedPromise = new Promise<string>((r) => { resolveCall = r; });
      const llm = makeLlm({
        invokeTextWithUsage: jest.fn().mockReturnValueOnce(
          blockedPromise.then((text) => ({ text, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: "gpt-4o-mini" })),
        ),
      });
      const { svc } = await buildModule(llm);

      const opts = { actor: ACTOR, feature: FEATURE, prompt: PROMPT, dedupe: true };
      const p1 = svc.invokeText(opts);
      const p2 = svc.invokeText(opts);

      resolveCall("Hello!");
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(llm.invokeTextWithUsage).toHaveBeenCalledTimes(1);
      expect(r1).toBe(r2);
    });
  });

  describe("reservationId=0 (noop ledger)", () => {
    it("skips settle and release when reservationId is 0", async () => {
      const ledger = makeLedger({
        reserve: jest.fn().mockResolvedValue({ reservationId: 0 }),
      });
      const { svc } = await buildModule(undefined, ledger);

      await svc.invokeText({
        actor: ACTOR,
        feature: FEATURE,
        prompt: PROMPT,
        charge: true,
      });

      expect(ledger.settle).not.toHaveBeenCalled();
      expect(ledger.release).not.toHaveBeenCalled();
    });
  });
});
