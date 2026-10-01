import type { AiCreditsService } from "../../billing/core/ai-credits.service";
import { KbCreditsService } from "./kb-credits.service";

describe("KbCreditsService — cross-tenant isolation", () => {
  function service() {
    const getWallet = jest.fn().mockImplementation(async (orgId: string) => ({
      wallet: {
        id: 1,
        orgId,
        balance: 1,
        lifetimeGranted: 1,
        lifetimeConsumed: 0,
      },
      recentTransactions: [],
    }));
    const ledger = { getWallet } as unknown as AiCreditsService;
    return { credits: new KbCreditsService(ledger), getWallet };
  }

  it("scopes the canonical wallet lookup to the requesting org", async () => {
    const { credits, getWallet } = service();

    await expect(credits.getBalance("org-attacker")).resolves.toMatchObject({ orgId: "org-attacker" });
    expect(getWallet).toHaveBeenCalledWith("org-attacker");
  });

  it("does not reuse another tenant's balance", async () => {
    const { credits, getWallet } = service();

    await credits.getBalance("org-owner");
    await credits.getBalance("org-other");

    expect(getWallet.mock.calls).toEqual([["org-owner"], ["org-other"]]);
  });
});
