import { ConflictException } from "@nestjs/common";
import { creditsToMilli } from "../../ai/core/billing/ai-model-pricing.constants";
import type { AiCreditsService } from "../../billing/core/ai-credits.service";
import { KbCreditsService } from "./kb-credits.service";

describe("KbCreditsService — authoritative AI credit ledger adapter", () => {
  const orgId = "org-a";

  function setup() {
    const ledger = {
      getWallet: jest.fn().mockResolvedValue({
        wallet: { id: 7, orgId, balance: 125.5, lifetimeGranted: 200, lifetimeConsumed: 74.5 },
        recentTransactions: [],
      }),
      reserve: jest.fn().mockResolvedValue({ reservationId: 41 }),
      settle: jest.fn().mockResolvedValue(undefined),
      grantCredits: jest.fn().mockResolvedValue({ balance: 130.5 }),
    } as unknown as jest.Mocked<AiCreditsService>;
    return { ledger, service: new KbCreditsService(ledger) };
  }

  it("reads the canonical org wallet and never the legacy KB wallet", async () => {
    const { ledger, service } = setup();

    await expect(service.getBalance(orgId)).resolves.toMatchObject({
      orgId,
      balance: 125.5,
    });
    expect(ledger.getWallet).toHaveBeenCalledWith(orgId);
  });

  it("consumes through reserve then settle using milli-credits and one stable idempotency key", async () => {
    const { ledger, service } = setup();

    await expect(service.consume(orgId, 2.5, {
      reason: "answer generated",
      feature: "kb.ask",
      userId: "user-a",
      idempotencyKey: "kb-answer:123",
    })).resolves.toBe(125.5);

    expect(ledger.reserve).toHaveBeenCalledWith({
      orgId,
      userId: "user-a",
      feature: "kb.ask",
      credits: creditsToMilli(2.5),
      idempotencyKey: "kb-answer:123",
    });
    expect(ledger.settle).toHaveBeenCalledWith(41, {
      orgId,
      actualMilli: creditsToMilli(2.5),
      metadata: { reason: "answer generated" },
    });
  });

  it("requires idempotency for every positive legacy mutation", async () => {
    const { ledger, service } = setup();

    await expect(service.consume(orgId, 1, {
      reason: "answer generated",
      feature: "kb.ask",
    })).rejects.toThrow(ConflictException);
    expect(ledger.reserve).not.toHaveBeenCalled();
  });

  it("grants through the canonical wallet with the caller's replay key", async () => {
    const { ledger, service } = setup();

    await expect(service.grant(orgId, 5, {
      reason: "manual correction",
      feature: "kb.admin",
      userId: "user-a",
      idempotencyKey: "correction:19",
    })).resolves.toBe(130.5);

    expect(ledger.grantCredits).toHaveBeenCalledWith({
      orgId,
      userId: "user-a",
      credits: 5,
      feature: "kb.admin",
      reason: "manual correction",
      idempotencyKey: "correction:19",
    });
  });

  it("keeps tenant identity on every ledger call", async () => {
    const { ledger, service } = setup();

    await service.consume("org-attacker", 1, {
      reason: "test",
      feature: "kb.ask",
      idempotencyKey: "attacker:1",
    });

    expect(ledger.reserve).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-attacker" }));
    expect(ledger.settle).toHaveBeenCalledWith(41, expect.objectContaining({ orgId: "org-attacker" }));
  });
});
