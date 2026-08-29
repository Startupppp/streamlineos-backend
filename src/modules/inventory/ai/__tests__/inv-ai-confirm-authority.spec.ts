import { ForbiddenException } from "@nestjs/common";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { InvAiExplainService } from "../inv-ai-explain.service";
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
 */
describe("F1 — confirmReorderProposal with only inventory:ai:propose", () => {
  function buildService(access: { holds: jest.Mock }, confirmation: object, replenishment: object) {
    return new InvAiExplainService(
      {} as never,
      {} as never,
      confirmation as never,
      replenishment as never,
      {} as never,
      {} as never,
      access as never,
    );
  }

  it("refuses, and never reaches the purchase-order service", async () => {
    const generatePo = jest.fn();
    const confirm = jest.fn();
    const service = buildService(
      accessHolding("inventory:ai:propose"),
      { confirm, markExecuted: jest.fn() },
      { generatePo },
    );

    await expect(
      service.confirmReorderProposal(USER, 1, "1.9999999999.abc"),
    ).rejects.toThrow(ForbiddenException);

    expect(generatePo).not.toHaveBeenCalled();
    // The denial lands before the proposal is consumed. Confirming first and
    // refusing after would spend the token on a call that achieved nothing,
    // and would hand anyone holding `ai:propose` a way to burn other people's
    // proposals one 403 at a time.
    expect(confirm).not.toHaveBeenCalled();
  });

  it("admits a caller holding both keys and raises the draft PO", async () => {
    const generatePo = jest.fn().mockResolvedValue({ id: "po-1" });
    const service = buildService(
      accessHolding("inventory:ai:propose", "inventory:purchase-orders:create"),
      {
        confirm: jest.fn().mockResolvedValue({
          proposalId: 1,
          action: "inventory:create-draft-po",
          payload: {
            suggestion: {
              productVariantId: 77,
              suggestedQty: 10,
              currentOnHand: 2,
              vendorId: 9,
              warehouseId: 5,
            },
          },
        }),
        markExecuted: jest.fn().mockResolvedValue(undefined),
      },
      { generatePo },
    );

    await service.confirmReorderProposal(USER, 1, "1.9999999999.abc");
    expect(generatePo).toHaveBeenCalledTimes(1);
  });

  it("refuses a token whose stored action is not this route's", async () => {
    // A transfer proposal replayed against the purchase-order route. The caller
    // holds both PO keys, so the route's own gate passes -- and the proposal is
    // still refused, because authority is measured against what the stored row
    // says it will do.
    const generatePo = jest.fn();
    const service = buildService(
      accessHolding("inventory:ai:propose", "inventory:purchase-orders:create"),
      {
        confirm: jest.fn().mockResolvedValue({
          proposalId: 2,
          action: "inventory:create-transfer",
          payload: { suggestion: { productVariantId: 1, suggestedQty: 1, vendorId: 1 } },
        }),
        markExecuted: jest.fn(),
      },
      { generatePo },
    );

    await expect(
      service.confirmReorderProposal(USER, 2, "2.9999999999.abc"),
    ).rejects.toThrow(ForbiddenException);
    expect(generatePo).not.toHaveBeenCalled();
  });
});
