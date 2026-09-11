import "dotenv/config";
import { AiGatewayRunnerHelper } from "../modules/ai/core/gateway/ai-gateway-runner.helper";
import { AiGatewayCreditHelper } from "../modules/ai/core/gateway/ai-gateway-credit.helper";
import type { AiCreditLedger } from "../modules/ai/core/gateway/credit-ledger.interface";
import type { LlmService } from "../modules/ai/core/providers/llm.service";
import type { AiUsageService } from "../modules/ai/core/services/ai-usage.service";
import type { AuditService } from "../common/audit/audit.service";
import type { InvokeStructuredOpts } from "../modules/ai/core/gateway/ai-gateway.types";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDb = databaseUrl ? describe : describe.skip;
import { z } from "zod";

const actor = { orgId: "org-ai-test", userId: "user-1" };
const prompt = { system: "You are helpful.", user: "Hello.", promptKey: "test", promptVersion: 1 };

function makeMockLedger(opts: {
  reserveFails?: boolean;
  reservationId?: number;
}): jest.Mocked<AiCreditLedger> {
  return {
    reserve: opts.reserveFails
      ? jest.fn().mockRejectedValue(new Error("ledger unavailable"))
      : jest.fn().mockResolvedValue({ reservationId: opts.reservationId ?? 42 }),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

function makeMockLlm(fails: boolean): jest.Mocked<Pick<LlmService, "invokeStructuredWithUsage">> {
  if (fails)
    return {
      invokeStructuredWithUsage: jest.fn().mockRejectedValue(new Error("AI provider down")),
    };
  return {
    invokeStructuredWithUsage: jest.fn().mockResolvedValue({
      data: { result: "ok" },
      model: "gpt-4o-mini",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }),
  };
}

function makeMockUsage(): jest.Mocked<Pick<AiUsageService, "track">> {
  return { track: jest.fn().mockResolvedValue(undefined) };
}

function makeMockAudit(): jest.Mocked<Pick<AuditService, "log">> {
  return { log: jest.fn() };
}

function makeOpts<T>(schema: z.ZodType<T>, charge: boolean): InvokeStructuredOpts<T> {
  return {
    actor,
    feature: "crm.score-lead",
    schema,
    prompt,
    charge,
  };
}

describe("AI provider degraded — credits reserved before provider call", () => {
  it("reserve is called before invokeStructuredWithUsage — no charge without a prior reservation", async () => {
    const ledger = makeMockLedger({ reservationId: 99 });
    const llm = makeMockLlm(false);
    const usage = makeMockUsage();
    const audit = makeMockAudit();
    const credit = new AiGatewayCreditHelper(ledger, usage as never, audit as never);
    const runner = new AiGatewayRunnerHelper(llm as never, credit);

    await runner.runStructured(makeOpts(z.object({ result: z.string() }), true), "corr-1");

    const reserveOrder = ledger.reserve.mock.invocationCallOrder[0];
    const llmOrder = llm.invokeStructuredWithUsage.mock.invocationCallOrder[0];

    expect(reserveOrder).toBeDefined();
    expect(llmOrder).toBeDefined();
    expect(reserveOrder!).toBeLessThan(llmOrder!);
  });

  it("release is called when the provider throws — reservation is returned to the wallet", async () => {
    const ledger = makeMockLedger({ reservationId: 42 });
    const llm = makeMockLlm(true);
    const usage = makeMockUsage();
    const audit = makeMockAudit();
    const credit = new AiGatewayCreditHelper(ledger, usage as never, audit as never);
    const runner = new AiGatewayRunnerHelper(llm as never, credit);

    const result = await runner.runStructured(makeOpts(z.object({ result: z.string() }), true), "corr-2");

    expect(result.ok).toBe(false);
    expect(ledger.release).toHaveBeenCalledWith(42, "provider_error", actor.orgId);
    expect(ledger.settle).not.toHaveBeenCalled();
  });

  it("settle is called (not release) when the provider succeeds", async () => {
    const ledger = makeMockLedger({ reservationId: 77 });
    const llm = makeMockLlm(false);
    const usage = makeMockUsage();
    const audit = makeMockAudit();
    const credit = new AiGatewayCreditHelper(ledger, usage as never, audit as never);
    const runner = new AiGatewayRunnerHelper(llm as never, credit);

    const result = await runner.runStructured(makeOpts(z.object({ result: z.string() }), true), "corr-3");

    expect(result.ok).toBe(true);
    expect(ledger.settle).toHaveBeenCalledWith(77, expect.objectContaining({ orgId: actor.orgId }));
    expect(ledger.release).not.toHaveBeenCalled();
  });

  it("no charge opts: reserve is not called, provider failure does not release anything", async () => {
    const ledger = makeMockLedger({});
    const llm = makeMockLlm(true);
    const usage = makeMockUsage();
    const audit = makeMockAudit();
    const credit = new AiGatewayCreditHelper(ledger, usage as never, audit as never);
    const runner = new AiGatewayRunnerHelper(llm as never, credit);

    await runner.runStructured(makeOpts(z.object({ result: z.string() }), false), "corr-4");

    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(ledger.release).not.toHaveBeenCalled();
    expect(ledger.settle).not.toHaveBeenCalled();
  });

  it("the result is { ok: false, kind: 'provider_unavailable' } when the provider is down", async () => {
    const ledger = makeMockLedger({ reservationId: 1 });
    const llm = makeMockLlm(true);
    const usage = makeMockUsage();
    const audit = makeMockAudit();
    const credit = new AiGatewayCreditHelper(ledger, usage as never, audit as never);
    const runner = new AiGatewayRunnerHelper(llm as never, credit);

    const result = await runner.runStructured(makeOpts(z.object({ result: z.string() }), true), "corr-5");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("provider_unavailable");
  });

  it("core product usage (no charge) continues even when the ledger is unavailable", async () => {
    const ledger = makeMockLedger({ reserveFails: true });
    const llm = makeMockLlm(false);
    const usage = makeMockUsage();
    const audit = makeMockAudit();
    const credit = new AiGatewayCreditHelper(ledger, usage as never, audit as never);
    const runner = new AiGatewayRunnerHelper(llm as never, credit);

    const result = await runner.runStructured(makeOpts(z.object({ result: z.string() }), false), "corr-6");

    expect(result.ok).toBe(true);
  });
});

describe("AiCreditsReservationService — idempotent release on provider failure", () => {
  it("release is idempotent: releasing a reservation twice does not throw", async () => {
    const ledger = makeMockLedger({ reservationId: 10 });
    const usage = makeMockUsage();
    const audit = makeMockAudit();
    const credit = new AiGatewayCreditHelper(ledger, usage as never, audit as never);

    await credit.releaseReservation(10, "provider_error", actor.orgId, "corr-7");
    await credit.releaseReservation(10, "provider_error", actor.orgId, "corr-7");

    expect(ledger.release).toHaveBeenCalledTimes(2);
  });

  it.skip(
    "integration: releasing a RESERVED reservation restores the org wallet balance — persisted refund, owner-scope, and rollback probes are unimplemented; a provider-isolated seeded harness exists but requires an approved disposable database at the current migration head",
    () => {},
  );

  it.skip(
    "integration: sweeping expired reservations restores credits atomically within each tenant — persisted refund and rollback probes are unimplemented; tenants commit or roll back independently and require an approved disposable database at the current migration head",
    () => {},
  );
});
