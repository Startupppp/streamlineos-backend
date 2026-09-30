import { ProviderCircuitBreaker } from "../../../common/outbound/provider-circuit-breaker";
import {
  PlatformProviderHttpError,
  callPlatformProvider,
} from "./platform-provider-outbound";

const breaker = () => new ProviderCircuitBreaker(50, 1_000);

describe("callPlatformProvider", () => {
  it("retries reads on retryable provider failures", async () => {
    const operation = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new PlatformProviderHttpError(503))
      .mockResolvedValue("ok");

    const result = await callPlatformProvider(
      {
        provider: "stripe",
        operation: "fetch-order",
        safety: { kind: "read" },
        timeoutMs: 1_000,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
      operation,
      breaker(),
    );

    expect(result).toEqual({ value: "ok", attempts: 2 });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("retries writes only when the caller supplies a stable idempotency key", async () => {
    const retryable = () => Promise.reject(new PlatformProviderHttpError(503));

    await expect(
      callPlatformProvider(
        {
          provider: "stripe",
          operation: "create-order",
          safety: { kind: "write", idempotencyKey: "receipt-1" },
          timeoutMs: 1_000,
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
        jest.fn(retryable),
        breaker(),
      ),
    ).rejects.toMatchObject({ attempts: 3 });

    const unsafeWrite = jest.fn(retryable);
    await expect(
      callPlatformProvider(
        {
          provider: "razorpay",
          operation: "create-order",
          safety: { kind: "write" },
          timeoutMs: 1_000,
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
        unsafeWrite,
        breaker(),
      ),
    ).rejects.toMatchObject({ attempts: 1 });
    expect(unsafeWrite).toHaveBeenCalledTimes(1);
  });

  it("does not expose provider response messages through its public error", async () => {
    const secretBearingMessage = "request failed for sk_live_do_not_log";

    const error = await callPlatformProvider(
      {
        provider: "stripe",
        operation: "create-order",
        safety: { kind: "write", idempotencyKey: "receipt-2" },
        timeoutMs: 1_000,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
      async () => {
        throw new PlatformProviderHttpError(400, secretBearingMessage);
      },
      breaker(),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ provider: "stripe", operation: "create-order", attempts: 1 });
    expect((error as Error).message).not.toContain(secretBearingMessage);
  });
});
