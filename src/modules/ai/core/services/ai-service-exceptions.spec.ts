import { ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { AiStreamBreaker } from "../streaming/ai-stream-breaker";
import {
  AI_CONCURRENCY_LIMIT_CODE,
  AI_PROVIDER_UNAVAILABLE_CODE,
  AiConcurrencyLimitException,
  AiProviderUnavailableException,
} from "./ai-service-exceptions";
import { throwOnAiFailure } from "./gateway-result.util";

function body(error: ServiceUnavailableException): Record<string, unknown> {
  const response: unknown = error.getResponse();
  if (response === null || typeof response !== "object") throw new Error("expected an object body");
  return response as Record<string, unknown>;
}

describe("the two AI 503s are distinguishable without matching message text", () => {
  it("the breaker's 503 and the capacity 503 carry different codes", () => {
    expect(body(new AiProviderUnavailableException())["code"]).toBe(AI_PROVIDER_UNAVAILABLE_CODE);
    expect(body(new AiConcurrencyLimitException())["code"]).toBe(AI_CONCURRENCY_LIMIT_CODE);
    expect(AI_PROVIDER_UNAVAILABLE_CODE).not.toBe(AI_CONCURRENCY_LIMIT_CODE);
  });

  it("the shape matches the ledger's 402, which is what the client already branches on", () => {
    const credits = new InsufficientAiCreditsException({ message: "no credits" });
    const creditBody: unknown = credits.getResponse();
    expect(Object.keys(creditBody as object)).toContain("code");
    expect(Object.keys(body(new AiConcurrencyLimitException()))).toContain("code");
    expect(Object.keys(body(new AiConcurrencyLimitException()))).toContain("message");
  });

  it("both are still 503 and still ServiceUnavailableException, so existing instanceof checks hold", () => {
    for (const error of [new AiProviderUnavailableException(), new AiConcurrencyLimitException()]) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.getStatus()).toBe(503);
    }
  });

  it("`.message` still reads back the string, so the gateway's message-based classification is unaffected", () => {
    expect(new AiProviderUnavailableException("AI assistant is not available").message).toBe(
      "AI assistant is not available",
    );
    expect(new AiConcurrencyLimitException().message).toMatch(/concurrent/i);
  });

  it("an empty message falls back rather than shipping a blank envelope", () => {
    expect(new AiProviderUnavailableException("   ").message).toBe(
      "AI provider is temporarily unavailable",
    );
  });
});

describe("the emitting sites really raise the coded exceptions", () => {
  it("an open breaker raises the provider code", async () => {
    const breaker = new AiStreamBreaker({
      key: "test",
      unavailableMessage: "AI assistant is temporarily unavailable",
      failureThreshold: 1,
    });
    breaker.recordFailure();

    await expect(breaker.assertClosed()).rejects.toBeInstanceOf(AiProviderUnavailableException);
    await breaker.assertClosed().catch((error: unknown) => {
      expect(body(error as ServiceUnavailableException)["code"]).toBe(AI_PROVIDER_UNAVAILABLE_CODE);
    });
  });

  it("a gateway concurrency rejection raises the capacity code, not the provider one", () => {
    expect(() =>
      throwOnAiFailure({
        ok: false,
        kind: "concurrency_exceeded",
        message: "Too many concurrent AI requests for this organization",
        correlationId: "c1",
      }),
    ).toThrow(AiConcurrencyLimitException);
  });

  it("a gateway provider failure raises the provider code, not the capacity one", () => {
    expect(() =>
      throwOnAiFailure({
        ok: false,
        kind: "provider_unavailable",
        message: "AI provider is temporarily unavailable",
        correlationId: "c1",
      }),
    ).toThrow(AiProviderUnavailableException);
  });

  /**
   * The regression the breaker already carries a fix for: counting
   * `failures === threshold` opens once and never again, because past the
   * threshold the equality stops matching and only a success resets the counter.
   */
  it("BITE — the breaker re-arms after its window, so it is not inert for the rest of the process", async () => {
    let now = 1_000;
    const breaker = new AiStreamBreaker({
      key: "test",
      unavailableMessage: "down",
      failureThreshold: 2,
      openDurationMs: 100,
      now: () => now,
    });

    breaker.recordFailure();
    breaker.recordFailure();
    expect(await breaker.isOpen()).toBe(true);

    now += 200;
    expect(await breaker.isOpen()).toBe(false);

    breaker.recordFailure();
    expect(await breaker.isOpen()).toBe(true);
  });
});
