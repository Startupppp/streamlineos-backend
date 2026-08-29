import { ForbiddenException } from "@nestjs/common";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { InvAiProposalService } from "../proposals/inv-ai-proposal.service";
import {
  evidenceFromProposal,
  hashProposalEvidence,
} from "../proposals/inv-ai-proposal-evidence";
import type { BatchableProposal } from "../../replenishment/forecast/po-batch.service";
import {
  INV_AI_CONFIRMABLE_ACTIONS,
  assertInvAiConfirmAuthority,
  requiredPermissionsForAiAction,
} from "../inv-ai-confirm-authority";

const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
};

/** The persisted C2 proposal a confirm re-resolves. */
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

/** An access service that answers only for the keys the caller actually holds. */
function accessHolding(...held: string[]) {
  const set = new Set(held);
  return {
    holds: jest.fn((_user: CurrentUserContext, key: string) =>
      Promise.resolve(set.has(key)),
    ),
  };
}

describe("F1 — the permission a confirmed AI proposal costs", () => {
  it("prices a draft purchase order at ai:propose AND purchase-orders:create", () => {
    expect(requiredPermissionsForAiAction("inventory:create-draft-po")).toEqual([
      "inventory:ai:propose",
      "inventory:purchase-orders:create",
    ]);
  });

  it("prices a transfer at ai:propose AND stock:transfer", () => {
    expect(requiredPermissionsForAiAction("inventory:create-transfer")).toEqual([
      "inventory:ai:propose",
      "inventory:stock:transfer",
    ]);
  });

  it("denies an action nobody has priced", async () => {
    // Fail closed. An unrecognised action is one whose authority was never
    // decided, and "we never decided" must not read as "anyone may".
    expect(requiredPermissionsForAiAction("inventory:vaporise-warehouse")).toBeNull();
    await expect(
      assertInvAiConfirmAuthority(
        accessHolding("inventory:ai:propose") as never,
        USER,
        "inventory:vaporise-warehouse",
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("every priced action demands ai:propose plus exactly one mutation key", () => {
    // The shape of the rule, not a restatement of the table: `ai:propose` is
    // never sufficient on its own, so every entry carries a second key.
    for (const [action, keys] of Object.entries(INV_AI_CONFIRMABLE_ACTIONS)) {
      expect(`${action}: ${keys.join(",")}`).toContain("inventory:ai:propose");
      expect(keys.length).toBeGreaterThan(1);
      expect(keys.filter((k) => k !== "inventory:ai:propose")).toHaveLength(1);
    }
  });

  it("refuses a caller holding only ai:propose", async () => {
    await expect(
      assertInvAiConfirmAuthority(
        accessHolding("inventory:ai:propose") as never,
        USER,
        "inventory:create-draft-po",
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("refuses a caller holding only purchase-orders:create", async () => {
    await expect(
      assertInvAiConfirmAuthority(
        accessHolding("inventory:purchase-orders:create") as never,
        USER,
        "inventory:create-draft-po",
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("admits a caller holding both", async () => {
    await expect(
      assertInvAiConfirmAuthority(
        accessHolding(
          "inventory:ai:propose",
          "inventory:purchase-orders:create",
        ) as never,
        USER,
        "inventory:create-draft-po",
      ),
    ).resolves.toBeUndefined();
  });

  it("does not ask for the second key once the first is missing", async () => {
    // Short-circuit: a caller who fails the cheap check never pays for the
    // expensive lookup, and the denial is identical either way.
    const access = accessHolding("inventory:purchase-orders:create");
    await expect(
      assertInvAiConfirmAuthority(access as never, USER, "inventory:create-draft-po"),
    ).rejects.toThrow(ForbiddenException);
    expect(access.holds).toHaveBeenCalledTimes(1);
  });
});

/**
 * The behaviour the contract names: "User with only `ai:propose` cannot create
 * a PO." Asserted against the service, not just the helper, because the helper
 * being right is worth nothing if the confirm path forgets to call it.
 *
 * F4 moved the confirm path to `InvAiProposalService`, and moved the mutation
 * from `InvReplenishmentService.generatePo` to `PoBatchService.create`. The
 * assertion is unchanged: a caller holding only `ai:propose` never reaches the
 * service that raises the order, and never spends the proposal finding out.
 */
describe("F1 — confirming with only inventory:ai:propose", () => {
  function buildService(access: { holds: jest.Mock }, confirmation: object, batches: object) {
    return new InvAiProposalService(
      {} as never,
      confirmation as never,
      access as never,
      batches as never,
      {} as never,
    );
  }

  it("refuses, and never reaches the purchase-order service", async () => {
    const create = jest.fn();
    const confirm = jest.fn();
    const service = buildService(
      accessHolding("inventory:ai:propose"),
      { confirm, markExecuted: jest.fn() },
      { create, proposalById: jest.fn() },
    );

    await expect(
      service.confirm(USER, { proposalId: 1, token: "1.9999999999.abc" }),
    ).rejects.toThrow(ForbiddenException);

    expect(create).not.toHaveBeenCalled();
    // The denial lands before the proposal is consumed. Confirming first and
    // refusing after would spend the token on a call that achieved nothing,
    // and would hand anyone holding `ai:propose` a way to burn other people's
    // proposals one 403 at a time.
    expect(confirm).not.toHaveBeenCalled();
  });

  it("admits a caller holding both keys and raises the draft PO", async () => {
    const evidence = evidenceFromProposal(PROPOSAL);
    const create = jest.fn().mockResolvedValue({ poId: 1, poNumber: "PO-1" });
    const service = buildService(
      accessHolding("inventory:ai:propose", "inventory:purchase-orders:create"),
      {
        confirm: jest.fn().mockResolvedValue({
          proposalId: 1,
          action: "inventory:create-draft-po",
          payload: { evidence, evidenceHash: hashProposalEvidence(evidence) },
        }),
        markExecuted: jest.fn().mockResolvedValue(undefined),
      },
      { create, proposalById: jest.fn().mockResolvedValue(PROPOSAL) },
    );

    await service.confirm(USER, { proposalId: 1, token: "1.9999999999.abc" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses a token whose stored action is not this route's", async () => {
    // A transfer proposal replayed against the purchase-order route. The caller
    // holds both PO keys, so the route's own gate passes -- and the proposal is
    // still refused, because authority is measured against what the stored row
    // says it will do.
    const create = jest.fn();
    const service = buildService(
      accessHolding("inventory:ai:propose", "inventory:purchase-orders:create"),
      {
        confirm: jest.fn().mockResolvedValue({
          proposalId: 2,
          action: "inventory:create-transfer",
          payload: { evidence: evidenceFromProposal(PROPOSAL), evidenceHash: "x" },
        }),
        markExecuted: jest.fn(),
      },
      { create, proposalById: jest.fn() },
    );

    await expect(
      service.confirm(USER, { proposalId: 2, token: "2.9999999999.abc" }),
    ).rejects.toThrow(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });
});
