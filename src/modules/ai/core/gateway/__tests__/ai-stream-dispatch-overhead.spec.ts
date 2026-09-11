import { streamText } from "ai";
import { AiGatewayStreamHelper } from "../ai-gateway-stream.helper";
import { AiConcurrencyLimiter } from "../ai-concurrency-limiter";
import { AiUsageService } from "../../services/ai-usage.service";
import {
  AI_DISPATCH_IO_ALLOWANCE_MS,
  getAiStreamBudget,
} from "../../telemetry/ai-stream-budgets";
import type { AiCreditLedger } from "../credit-ledger.interface";

jest.mock("ai", () => ({
  streamText: jest.fn(),
  stepCountIs: jest.fn(),
}));

jest.mock("../../services/chat-assistant-model", () => ({
  resolveChatModel: () => "model-handle",
  resolveChatModelId: () => "gemini-1.5-pro-latest",
  CHAT_FEATURE: "chat.message",
}));

const SAMPLES = 50;
const BUDGET = getAiStreamBudget("ai.stream.dispatch.overhead");

/**
 * A real streamed prompt, not a two-word stub: redaction walks the whole string,
 * so measuring dispatch on `{ system: "sys", user: "user" }` would measure
 * nothing. 1 KB of system prompt and 4 KB of assembled context is the shape the
 * CRM account-summary and meeting-prep surfaces actually send.
 */
const PROMPT = {
  system: "You are an executive assistant preparing client briefing documents. ".repeat(16),
  user: `Client: Acme Capital, phone 9876543210, email ops@example.com.\n${"- [2026-01-01] call: discussed renewal terms and the upcoming tranche.\n".repeat(60)}`,
};

interface FinishHandler {
  onFinish?: (event: { usage?: { inputTokens?: number; outputTokens?: number } }) => Promise<void>;
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function makeLedger() {
  return {
    reserve: jest.fn().mockResolvedValue({ reservationId: 1 }),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AiCreditLedger>;
}

function makeUsage() {
  return { track: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AiUsageService>;
}

/**
 * Application overhead before provider dispatch, measured through the real
 * gateway path — breaker, redaction, concurrency slot, reservation, model
 * resolution — with only the provider itself stubbed. The two I/O legs a stub
 * makes free (the breaker's Redis read and the ledger's reservation write) are
 * added back from their own declared seam budgets rather than pretended away.
 */
describe("application overhead before provider dispatch stays inside its budget", () => {
  beforeEach(() => jest.clearAllMocks());

  it(`p95 of ${SAMPLES} dispatches plus the declared I/O allowance is within ${BUDGET.budgetMs} ms`, async () => {
    const dispatchedAt: bigint[] = [];
    const finishers: FinishHandler[] = [];
    jest.mocked(streamText).mockImplementation((config: unknown) => {
      dispatchedAt.push(process.hrtime.bigint());
      finishers.push(config as FinishHandler);
      return { finishReason: Promise.resolve("stop") } as unknown as ReturnType<typeof streamText>;
    });

    const helper = new AiGatewayStreamHelper(makeLedger(), makeUsage(), new AiConcurrencyLimiter());
    const samples: number[] = [];

    for (let i = 0; i < SAMPLES; i += 1) {
      const startedAt = process.hrtime.bigint();
      await helper.run({
        actor: { orgId: "org_bench", userId: "user_bench" },
        feature: "crm.account-summary",
        prompt: PROMPT,
        maxTokens: 1024,
      });
      const dispatched = dispatchedAt[i];
      expect(dispatched).toBeDefined();
      samples.push(Number((dispatched ?? startedAt) - startedAt) / 1e6);
      await finishers[i]?.onFinish?.({ usage: { inputTokens: 1200, outputTokens: 400 } });
    }

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    process.stdout.write(
      `ai.stream.dispatch.overhead n=${SAMPLES} p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms ` +
        `io_allowance=${AI_DISPATCH_IO_ALLOWANCE_MS}ms budget=${BUDGET.budgetMs}ms\n`,
    );

    expect(samples).toHaveLength(SAMPLES);
    expect(p95 + AI_DISPATCH_IO_ALLOWANCE_MS).toBeLessThanOrEqual(BUDGET.budgetMs);
  });

  it("(anti-vacuous) the measured window really brackets the gateway, not an empty call", async () => {
    const dispatchedAt: bigint[] = [];
    jest.mocked(streamText).mockImplementation((_config: unknown) => {
      dispatchedAt.push(process.hrtime.bigint());
      return { finishReason: Promise.resolve("stop") } as unknown as ReturnType<typeof streamText>;
    });

    const ledger = makeLedger();
    const helper = new AiGatewayStreamHelper(ledger, makeUsage(), new AiConcurrencyLimiter());

    await helper.run({
      actor: { orgId: "org_bench", userId: "user_bench" },
      feature: "crm.account-summary",
      prompt: PROMPT,
    });

    expect(dispatchedAt).toHaveLength(1);
    expect(ledger.reserve).toHaveBeenCalledTimes(1);
    expect(ledger.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(streamText).mock.invocationCallOrder[0] ?? Infinity,
    );
  });
});
