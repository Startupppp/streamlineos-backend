import { AiGatewayRunnerHelper } from "../ai-gateway-runner.helper";
import type { AiGatewayCreditHelper } from "../ai-gateway-credit.helper";
import type { LlmService } from "../../providers/llm.service";
import { z } from "zod";

const ACTOR = { orgId: "org_1", userId: "user_1" };

function makeCredit(): jest.Mocked<AiGatewayCreditHelper> {
  return {
    reserveCredits: jest.fn().mockResolvedValue({ reserved: true, reservationId: 7 }),
    settleAndTrack: jest.fn().mockResolvedValue(undefined),
    releaseReservation: jest.fn().mockResolvedValue(undefined),
    handleProviderError: jest
      .fn()
      .mockResolvedValue({ ok: false, kind: "provider_unavailable", message: "down", correlationId: "c" }),
  } as unknown as jest.Mocked<AiGatewayCreditHelper>;
}

const OK_TEXT = {
  text: "answer",
  model: "gpt-4o-mini",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
};

const OK_STRUCTURED = {
  data: { value: "x" },
  model: "gpt-4o-mini",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
};

function makeLlm(): jest.Mocked<LlmService> {
  return {
    invokeTextWithUsage: jest.fn().mockResolvedValue(OK_TEXT),
    invokeStructuredWithUsage: jest.fn().mockResolvedValue(OK_STRUCTURED),
    invokeStructuredWithImageWithUsage: jest.fn().mockResolvedValue(OK_STRUCTURED),
  } as unknown as jest.Mocked<LlmService>;
}

function textOpts(overrides: Record<string, unknown> = {}) {
  return {
    actor: ACTOR,
    feature: "kb.ask",
    prompt: { system: "sys", user: "user" },
    ...overrides,
  };
}

describe("AiGatewayRunnerHelper — output tokens are bounded at the gateway (12.3 criterion 4)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("applies a default output cap when the caller supplies no maxTokens", async () => {
    const llm = makeLlm();
    const runner = new AiGatewayRunnerHelper(llm, makeCredit());

    await runner.runText(textOpts(), "corr-1");

    const passed = llm.invokeTextWithUsage.mock.calls[0]?.[0];
    expect(passed?.maxTokens).toBe(4096);
  });

  it("never lets a caller exceed the gateway ceiling", async () => {
    const llm = makeLlm();
    const runner = new AiGatewayRunnerHelper(llm, makeCredit());

    await runner.runText(textOpts({ maxTokens: 1_000_000 }), "corr-2");

    expect(llm.invokeTextWithUsage.mock.calls[0]?.[0]?.maxTokens).toBe(4096);
  });

  it("honours a caller cap that is below the ceiling", async () => {
    const llm = makeLlm();
    const runner = new AiGatewayRunnerHelper(llm, makeCredit());

    await runner.runText(textOpts({ maxTokens: 512 }), "corr-3");

    expect(llm.invokeTextWithUsage.mock.calls[0]?.[0]?.maxTokens).toBe(512);
  });

  it("bounds the structured path too", async () => {
    const llm = makeLlm();
    const runner = new AiGatewayRunnerHelper(llm, makeCredit());

    await runner.runStructured(
      { ...textOpts(), schema: z.object({ value: z.string() }) },
      "corr-4",
    );

    expect(llm.invokeStructuredWithUsage.mock.calls[0]?.[0]?.maxTokens).toBe(4096);
  });

  it("bounds the image path too", async () => {
    const llm = makeLlm();
    const runner = new AiGatewayRunnerHelper(llm, makeCredit());

    await runner.runStructuredWithImage(
      { ...textOpts(), schema: z.object({ value: z.string() }), images: ["data:image/png;base64,AAA"] },
      "corr-5",
    );

    expect(llm.invokeStructuredWithImageWithUsage.mock.calls[0]?.[0]?.maxTokens).toBe(4096);
  });
});

describe("AiGatewayRunnerHelper — client aborts reach the provider (12.3 criterion 9)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("forwards the caller's AbortSignal to the text provider call", async () => {
    const llm = makeLlm();
    const runner = new AiGatewayRunnerHelper(llm, makeCredit());
    const controller = new AbortController();

    await runner.runText(textOpts({ signal: controller.signal }), "corr-6");

    expect(llm.invokeTextWithUsage.mock.calls[0]?.[0]?.signal).toBe(controller.signal);
  });

  it("forwards the signal on the structured path", async () => {
    const llm = makeLlm();
    const runner = new AiGatewayRunnerHelper(llm, makeCredit());
    const controller = new AbortController();

    await runner.runStructured(
      { ...textOpts({ signal: controller.signal }), schema: z.object({ value: z.string() }) },
      "corr-7",
    );

    expect(llm.invokeStructuredWithUsage.mock.calls[0]?.[0]?.signal).toBe(controller.signal);
  });

  it("omits the signal key entirely when the caller supplies none", async () => {
    const llm = makeLlm();
    const runner = new AiGatewayRunnerHelper(llm, makeCredit());

    await runner.runText(textOpts(), "corr-8");

    expect(llm.invokeTextWithUsage.mock.calls[0]?.[0]).not.toHaveProperty("signal");
  });

  it("releases the reservation when the provider call is aborted", async () => {
    const llm = makeLlm();
    const credit = makeCredit();
    llm.invokeTextWithUsage.mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );
    const runner = new AiGatewayRunnerHelper(llm, credit);
    const controller = new AbortController();

    const result = await runner.runText(
      textOpts({ signal: controller.signal, charge: true }),
      "corr-9",
    );

    expect(result.ok).toBe(false);
    expect(credit.handleProviderError).toHaveBeenCalledTimes(1);
  });
});
