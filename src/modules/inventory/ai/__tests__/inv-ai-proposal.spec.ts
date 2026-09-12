import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { InvAiProposalService } from "../proposals/inv-ai-proposal.service";
import {
  MATERIAL_FIELDS,
  evidenceFromProposal,
  hashProposalEvidence,
  type InvAiProposalEvidence,
} from "../proposals/inv-ai-proposal-evidence";
import {
  invAiConfirmProposalSchema,
  invAiReorderProposalSchema,
} from "../proposals/dto/inv-ai-proposal.schemas";
import type { BatchableProposal } from "../../replenishment/forecast/po-batch.service";

const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: {
    kind: "human-session",
    membershipId: 1,
    isOrgOwner: false,
  },
};

/**
 * The persisted C2 proposal, exactly as `PoBatchService.proposalById` resolves
 * it: the quantity has already been through the reorder point, the live
 * position and the supplier's pack size.
 */
const PROPOSAL: BatchableProposal = {
  proposalId: 501,
  productVariantId: 77,
  variantSku: "SKU-077",
  productName: "Widget",
  warehouseId: 5,
  warehouseName: "Main WH",
  vendorId: 9,
  vendorName: "Acme",
  currency: "INR",
  generatedAt: "2026-08-01T00:00:00.000Z",
  reorderPoint: "120.0000",
  suggestedQuantity: "36.0000",
  unitCost: "12.5000",
  duplicateOfPoNumber: null,
  blockedReason: null,
};

/** The C1 version behind it. Only the fields the service projects. */
const FORECAST_VERSION = {
  id: 501,
  method: "holt",
  demandCategory: "smooth",
  applicable: true,
  refusalReason: null,
  serviceLevel: "0.9500",
  safetyStock: "18.0000",
  metrics: { mae: "1.0", rmse: "1.2", bias: "0.1", mase: "0.80" },
  demand: { mean: "30.0000", stdDev: "4.0000" },
  leadTime: { weeks: "2.0000", stdDevWeeks: "0.5000", observations: 12 },
  stockoutCensored: false,
};

const NARRATION = {
  status: "ok" as const,
  explanation: "Cover falls below the reorder point before the lead time elapses.",
  factors: [{ label: "Order quantity", value: "36.0000", isFactual: true }],
  recommendations: [
    {
      action: "draft_purchase_order" as const,
      rationale: "The shortfall is real and the supplier is set.",
      evidence: [{ kind: "product_variant" as const, id: 77 }],
    },
  ],
};

const USAGE = {
  model: "test-model",
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  credits: 1,
  costUsd: 0.0001,
};

function okGateway(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    invokeStructuredWithUsage: jest.fn().mockResolvedValue({
      ok: true,
      data: NARRATION,
      aiUsage: USAGE,
      correlationId: "corr-1",
    }),
    ...overrides,
  };
}

function buildService(parts: {
  gateway?: Record<string, unknown>;
  confirmation?: Record<string, unknown>;
  access?: Record<string, unknown>;
  batches?: Record<string, unknown>;
  forecasts?: Record<string, unknown>;
}) {
  return new InvAiProposalService(
    (parts.gateway ?? okGateway()) as never,
    (parts.confirmation ?? {}) as never,
    (parts.access ?? { holds: () => Promise.resolve(true) }) as never,
    (parts.batches ?? {}) as never,
    (parts.forecasts ?? {
      latest: jest.fn().mockResolvedValue(FORECAST_VERSION),
    }) as never,
  );
}

/** A confirmation service that hands back a payload the service must re-check. */
function confirmationReturning(payload: Record<string, unknown>, proposalId = 900) {
  return {
    confirm: jest.fn().mockResolvedValue({
      proposalId,
      action: "inventory:create-draft-po",
      payload,
    }),
    markExecuted: jest.fn().mockResolvedValue(undefined),
  };
}

function reviewedPayload(evidence: InvAiProposalEvidence = evidenceFromProposal(PROPOSAL)) {
  return { evidence, evidenceHash: hashProposalEvidence(evidence) };
}

describe("F4 — the proposal is a persisted C2 proposal", () => {
  it("reads C1's stored version and C2's resolution of it, and derives no quantity of its own", async () => {
    const latest = jest.fn().mockResolvedValue(FORECAST_VERSION);
    const proposalById = jest.fn().mockResolvedValue(PROPOSAL);
    const propose = jest.fn().mockResolvedValue({
      proposalId: 900,
      token: "t",
      expiresAt: new Date(),
    });

    const service = buildService({
      confirmation: { propose },
      batches: { proposalById },
      forecasts: { latest },
    });

    const result = await service.propose(USER, { variantId: 77, warehouseId: 5 });

    // The stored forecast, for exactly this variant and scope.
    expect(latest).toHaveBeenCalledWith("org-1", 77, 5);
    // Resolved through the buyer's own service, by the version's id.
    expect(proposalById).toHaveBeenCalledWith("org-1", "user-1", 501);
    // The quantity on the way out is the one C2 computed, character for
    // character. Nothing rounded it, re-derived it or read it off a narration.
    expect(result.evidence.suggestedQuantity).toBe("36.0000");
    expect(result.status).toBe("proposed");
  });

  it("stores the evidence and its hash, and nothing taken from the narration", async () => {
    const propose = jest.fn().mockResolvedValue({
      proposalId: 900,
      token: "t",
      expiresAt: new Date(),
    });
    const service = buildService({
      confirmation: { propose },
      batches: { proposalById: jest.fn().mockResolvedValue(PROPOSAL) },
    });

    await service.propose(USER, { variantId: 77 });

    const payload = propose.mock.calls[0]![0].payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["evidence", "evidenceHash"]);
    expect(payload["evidenceHash"]).toBe(
      hashProposalEvidence(evidenceFromProposal(PROPOSAL)),
    );
  });

  it("keys the proposal on the persisted proposal, so a refresh does not mint a second one", async () => {
    const propose = jest.fn().mockResolvedValue({
      proposalId: 900,
      token: "t",
      expiresAt: new Date(),
    });
    const service = buildService({
      confirmation: { propose },
      batches: { proposalById: jest.fn().mockResolvedValue(PROPOSAL) },
    });

    await service.propose(USER, { variantId: 77 });
    // No clock in the key. Two calls over the same shortfall must reach the same
    // PROPOSED row; two independently confirmable rows raise two purchase orders.
    expect(propose.mock.calls[0]![0].idempotencyKey).toBe("ai-reorder:org-1:501");
  });

  it("404s rather than guessing when no version has been stored for this scope", async () => {
    const service = buildService({
      forecasts: { latest: jest.fn().mockResolvedValue(null) },
      batches: { proposalById: jest.fn() },
    });
    await expect(
      service.propose(USER, { variantId: 77 }),
    ).rejects.toThrow(NotFoundException);
  });

  it("404s for a proposal the warehouse scope excludes, never 403", async () => {
    // `proposalById` returns null for an id outside the caller's org or scope.
    // A 403 would confirm the row exists, which §4 forbids.
    const service = buildService({
      batches: { proposalById: jest.fn().mockResolvedValue(null) },
    });
    await expect(
      service.propose(USER, { variantId: 77 }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("F4 — a blocked proposal costs nothing", () => {
  it("returns the server's reason and never reaches the provider", async () => {
    const gateway = okGateway();
    const propose = jest.fn();
    const service = buildService({
      gateway,
      confirmation: { propose },
      batches: {
        proposalById: jest.fn().mockResolvedValue({
          ...PROPOSAL,
          duplicateOfPoNumber: "PO-1",
          blockedReason: "Already on draft purchase order PO-1, so ordering it again would double the delivery.",
        }),
      },
    });

    const result = await service.propose(USER, { variantId: 77 });

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toContain("PO-1");
    expect(result.proposal).toBeNull();
    // Denial of wallet: narrating an order that cannot be raised is a bill for a
    // paragraph nobody can act on.
    expect(gateway.invokeStructuredWithUsage).not.toHaveBeenCalled();
    expect(propose).not.toHaveBeenCalled();
  });
});

describe("F4 — confirm re-evaluates rather than replays", () => {
  it("posts the order when the picture has not moved", async () => {
    const create = jest.fn().mockResolvedValue({
      poId: 1,
      poNumber: "PO-9",
      vendorId: 9,
      warehouseId: 5,
      currency: "INR",
      lineCount: 1,
      total: "450.0000",
      requiresApproval: false,
      nextStep: "",
      created: true,
    });
    const confirmation = confirmationReturning(reviewedPayload());
    const service = buildService({
      confirmation,
      batches: {
        proposalById: jest.fn().mockResolvedValue(PROPOSAL),
        create,
      },
    });

    const result = await service.confirm(USER, { proposalId: 900, token: "t" });

    expect(result.poNumber).toBe("PO-9");
    // No quantity crosses this call. `create` recomputes it from the persisted
    // proposal against the live position, which is why there is no field for one.
    expect(create).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      { proposalIds: [501], vendorId: 9 },
      "ai-reorder-confirm:900",
    );
    expect(confirmation.markExecuted).toHaveBeenCalled();
  });

  it("refuses a stale hash — the picture moved under the proposal", async () => {
    const create = jest.fn();
    // Reviewed at 36; the ledger now says 12, because a receipt landed.
    const service = buildService({
      confirmation: confirmationReturning(reviewedPayload()),
      batches: {
        proposalById: jest
          .fn()
          .mockResolvedValue({ ...PROPOSAL, suggestedQuantity: "12.0000" }),
        create,
      },
    });

    await expect(
      service.confirm(USER, { proposalId: 900, token: "t" }),
    ).rejects.toThrow(ConflictException);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses when the supplier changed, and says so", async () => {
    const create = jest.fn();
    const service = buildService({
      confirmation: confirmationReturning(reviewedPayload()),
      batches: {
        proposalById: jest
          .fn()
          .mockResolvedValue({ ...PROPOSAL, vendorId: 11, vendorName: "Other" }),
        create,
      },
    });

    await expect(
      service.confirm(USER, { proposalId: 900, token: "t" }),
    ).rejects.toThrow(/supplier for this item changed/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses when another buyer raised the same draft while the review sat", async () => {
    const create = jest.fn();
    const service = buildService({
      confirmation: confirmationReturning(reviewedPayload()),
      batches: {
        proposalById: jest.fn().mockResolvedValue({
          ...PROPOSAL,
          duplicateOfPoNumber: "PO-4",
          blockedReason: "Already on draft purchase order PO-4, so ordering it again would double the delivery.",
        }),
        create,
      },
    });

    await expect(
      service.confirm(USER, { proposalId: 900, token: "t" }),
    ).rejects.toThrow(ConflictException);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses when the proposal itself has gone", async () => {
    const create = jest.fn();
    const service = buildService({
      confirmation: confirmationReturning(reviewedPayload()),
      batches: { proposalById: jest.fn().mockResolvedValue(null), create },
    });

    await expect(
      service.confirm(USER, { proposalId: 900, token: "t" }),
    ).rejects.toThrow(ConflictException);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a payload it cannot verify rather than executing on trust", async () => {
    const create = jest.fn();
    const service = buildService({
      confirmation: confirmationReturning({ suggestion: { suggestedQty: 42 } }),
      batches: { proposalById: jest.fn(), create },
    });

    await expect(
      service.confirm(USER, { proposalId: 900, token: "t" }),
    ).rejects.toThrow(ConflictException);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a token that names a different proposal from the body", async () => {
    const create = jest.fn();
    const service = buildService({
      confirmation: confirmationReturning(reviewedPayload(), 901),
      batches: { proposalById: jest.fn(), create },
    });

    await expect(
      service.confirm(USER, { proposalId: 900, token: "t" }),
    ).rejects.toThrow(ConflictException);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("F4 — permission", () => {
  it("asserts the conjunction BEFORE the token is consumed", async () => {
    const order: string[] = [];
    const access = {
      holds: jest.fn((_u: CurrentUserContext, key: string) => {
        order.push(`holds:${key}`);
        return Promise.resolve(key !== "inventory:purchase-orders:create");
      }),
    };
    const confirm = jest.fn(() => {
      order.push("confirm");
      return Promise.resolve({
        proposalId: 900,
        action: "inventory:create-draft-po",
        payload: reviewedPayload(),
      });
    });

    const service = buildService({
      access,
      confirmation: { confirm, markExecuted: jest.fn() },
      batches: { proposalById: jest.fn(), create: jest.fn() },
    });

    await expect(
      service.confirm(USER, { proposalId: 900, token: "t" }),
    ).rejects.toThrow(ForbiddenException);

    // A denial after `confirm` would leave the caller with a spent token, and
    // repeated denials would be a way to burn other people's proposals.
    expect(order).not.toContain("confirm");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("measures a replayed token against the authority its own action demands", async () => {
    const holds = jest.fn((_u: CurrentUserContext, key: string) =>
      Promise.resolve(key !== "inventory:stock:transfer"),
    );
    const service = buildService({
      access: { holds },
      confirmation: {
        confirm: jest.fn().mockResolvedValue({
          proposalId: 900,
          // A transfer token replayed against the purchase-order route.
          action: "inventory:create-transfer",
          payload: reviewedPayload(),
        }),
        markExecuted: jest.fn(),
      },
      batches: { proposalById: jest.fn(), create: jest.fn() },
    });

    await expect(
      service.confirm(USER, { proposalId: 900, token: "t" }),
    ).rejects.toThrow(ForbiddenException);
    // The route cannot be used to launder a cheaper permission into a transfer.
    expect(holds).toHaveBeenCalledWith(USER, "inventory:stock:transfer");
  });
});

describe("F4 — a client cannot state a quantity or a supplier", () => {
  it("has no field for either, on either request", () => {
    // Unrepresentable, not rejected-at-runtime: there is no check to delete.
    expect(
      invAiReorderProposalSchema.safeParse({
        variantId: 77,
        suggestedQty: 5000,
      }).success,
    ).toBe(false);
    expect(
      invAiReorderProposalSchema.safeParse({ variantId: 77, vendorId: 3 })
        .success,
    ).toBe(false);
    expect(
      invAiConfirmProposalSchema.safeParse({
        proposalId: 1,
        token: "t",
        quantity: "5000",
      }).success,
    ).toBe(false);
  });

  it("accepts only a variant and, at most, a site", () => {
    expect(
      invAiReorderProposalSchema.safeParse({ variantId: 77 }).success,
    ).toBe(true);
    expect(
      invAiReorderProposalSchema.safeParse({ variantId: 77, warehouseId: 5 })
        .success,
    ).toBe(true);
  });
});

describe("F4 — the evidence hash", () => {
  it("covers every figure the decision turns on", () => {
    const base = evidenceFromProposal(PROPOSAL);
    for (const field of MATERIAL_FIELDS) {
      const moved: InvAiProposalEvidence = {
        ...base,
        [field]: typeof base[field] === "number" ? 4242 : "moved",
      };
      expect(`${field} changes the hash: ${hashProposalEvidence(moved) !== hashProposalEvidence(base)}`)
        .toBe(`${field} changes the hash: true`);
    }
  });

  it("ignores cosmetic fields, so a rename does not cry wolf", () => {
    const base = evidenceFromProposal(PROPOSAL);
    const renamed: InvAiProposalEvidence = {
      ...base,
      productName: "Widget (renamed)",
      variantSku: "SKU-077-B",
      vendorName: "Acme Ltd",
      warehouseName: "Main Warehouse",
    };
    expect(hashProposalEvidence(renamed)).toBe(hashProposalEvidence(base));
  });

  it("separates its fields, so two different worlds cannot agree", () => {
    const base = evidenceFromProposal(PROPOSAL);
    // vendor 1 / qty 23 versus vendor 12 / qty 3 — identical concatenated.
    const a = hashProposalEvidence({ ...base, vendorId: 1, suggestedQuantity: "23" });
    const b = hashProposalEvidence({ ...base, vendorId: 12, suggestedQuantity: "3" });
    expect(a).not.toBe(b);
  });

  it("treats two spellings of the same quantity as unchanged", async () => {
    // `"36.0000" !== "36"` as strings; as quantities they are the same number,
    // and a refusal here would teach people to ignore the refusal that matters.
    const create = jest.fn().mockResolvedValue({ poId: 1, poNumber: "PO-9" });
    const reviewed = evidenceFromProposal(PROPOSAL);
    const service = buildService({
      confirmation: confirmationReturning({
        evidence: reviewed,
        evidenceHash: hashProposalEvidence(reviewed),
      }),
      batches: {
        proposalById: jest.fn().mockResolvedValue(PROPOSAL),
        create,
      },
    });

    await service.confirm(USER, { proposalId: 900, token: "t" });
    expect(create).toHaveBeenCalled();
  });
});

describe("F4 — an AI proposal never posts stock", () => {
  /**
   * Structural, not behavioural. "AI never writes stock" is a property of the
   * import graph: if the proposal path cannot reach the movement engine, no
   * future edit to a mock can make it post one. A behavioural test only proves
   * the path did not write *today*.
   */
  const sources = [
    ["inv-ai-proposal.service.ts", join(__dirname, "..", "proposals", "inv-ai-proposal.service.ts")],
    ["inv-ai-proposal-evidence.ts", join(__dirname, "..", "proposals", "inv-ai-proposal-evidence.ts")],
  ] as const;

  it("imports nothing that can move stock", () => {
    // The engine's write surfaces. A draft purchase order is a document and
    // touches none of them; a movement, a reservation or a hold touches one.
    const forbidden = [
      "movement-apply.service",
      "stock-engine/movement",
      "inv-stock-reservations.service",
      "quality-hold",
      "inv-stock.service",
    ];
    for (const [label, path] of sources) {
      const source = readFileSync(path, "utf8");
      for (const needle of forbidden) {
        expect(`${label} imports ${needle}: ${source.includes(needle)}`).toBe(
          `${label} imports ${needle}: false`,
        );
      }
    }
  });

  it("holds no database handle at all, so it has nothing to write with", () => {
    // Stronger than scanning for `.insert(`: the proposal path never injects
    // `DRIZZLE` and never imports a schema table, so there is no handle a write
    // could be issued on. Every read and every write it causes goes through a
    // service that owns the gate for it.
    for (const [label, path] of sources) {
      const source = readFileSync(path, "utf8");
      for (const forbidden of [
        "drizzle.constants",
        "drizzle.module",
        "db/schema",
        "db.insert(",
        "db.update(",
        "db.delete(",
        ".transaction(",
      ]) {
        expect(`${label} contains ${forbidden}: ${source.includes(forbidden)}`).toBe(
          `${label} contains ${forbidden}: false`,
        );
      }
    }
  });

  it("reaches exactly one mutation, and it is the buyer's own draft-PO service", () => {
    const source = readFileSync(sources[0][1], "utf8");
    // `PoBatchService.create` asserts `inventory:purchase-orders:create` itself.
    expect(source.match(/this\.batches\.create\(/g)?.length ?? 0).toBe(1);
    expect(source).not.toContain("generatePo");
  });
});
