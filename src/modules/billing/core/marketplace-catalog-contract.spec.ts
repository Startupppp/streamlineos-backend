import { BillingMarketplace } from "./billing-marketplace";

const mockAiCredits = {
  listPacks: jest.fn().mockResolvedValue([]),
} as unknown as never;

const mockPlatformMerchant = {
  resolve: jest.fn().mockReturnValue(null),
} as unknown as never;

function makeMarketplace(): BillingMarketplace {
  return new BillingMarketplace(mockAiCredits, mockPlatformMerchant);
}

describe("marketplace catalog — every purchasable addon is handled", () => {
  it("every addon with available=true is handled by purchaseAddon", async () => {
    const marketplace = makeMarketplace();
    const { addons } = marketplace.listAddons();

    const purchasable = addons.filter((a) => a.available === true && !(a as Record<string, unknown>)["comingSoon"]);

    for (const addon of purchasable) {
      if (!addon.id.startsWith("ai_pack_") && addon.id !== "ai_credits") {
        throw new Error(
          `Addon "${addon.id}" is advertised as available but purchaseAddon cannot handle it. Either build support or mark it comingSoon/unavailable.`,
        );
      }
    }

    expect(purchasable.every((a) => a.id === "ai_credits" || a.id.startsWith("ai_pack_"))).toBe(true);
  });

  it("ai_credits is the only available addon without comingSoon", () => {
    const { addons } = makeMarketplace().listAddons();
    const available = addons.filter((a) => a.available === true);
    expect(available).toHaveLength(1);
    expect(available[0].id).toBe("ai_credits");
  });

  it("extra_storage is not marked as available (unsupported by purchaseAddon)", () => {
    const { addons } = makeMarketplace().listAddons();
    const storage = addons.find((a) => a.id === "extra_storage");
    expect(storage).toBeDefined();
    expect(storage?.available).toBe(false);
  });
});

describe("marketplace catalog — no links to retired routes", () => {
  it("no addon href points at /billing/ai-credits (retired route)", () => {
    const { addons } = makeMarketplace().listAddons();
    for (const addon of addons) {
      const href = (addon as Record<string, unknown>)["href"];
      if (href !== undefined) {
        expect(String(href)).not.toBe("/billing/ai-credits");
        expect(String(href)).not.toMatch(/^\/billing\//);
      }
    }
  });

  it("ai_credits addon links to /settings/billing/ai-credits (canonical route)", () => {
    const { addons } = makeMarketplace().listAddons();
    const aiCredits = addons.find((a) => a.id === "ai_credits");
    expect(aiCredits).toBeDefined();
    const href = (aiCredits as Record<string, unknown>)["href"];
    expect(href).toBe("/settings/billing/ai-credits");
  });

  it("getMarketplace returns an empty structure — not a stale cached catalog", () => {
    const result = makeMarketplace().getMarketplace();
    expect(result).toEqual({ apps: [], addons: [] });
  });
});

describe("marketplace catalog — purchaseAddon rejects unknown types", () => {
  it("rejects extra_storage purchases with BadRequestException", async () => {
    const marketplace = makeMarketplace();
    await expect(marketplace.purchaseAddon("org1", "extra_storage", 1)).rejects.toThrow("Unknown addon type");
  });

  it("rejects whatsapp purchases with BadRequestException", async () => {
    const marketplace = makeMarketplace();
    await expect(marketplace.purchaseAddon("org1", "whatsapp", 1)).rejects.toThrow("Unknown addon type");
  });

  it("accepts ai_pack_ prefixed ids for routing to the AI credits flow", async () => {
    const aiCreditsMarketplace = new BillingMarketplace(
      { listPacks: jest.fn().mockResolvedValue([]) } as unknown as never,
      { resolve: jest.fn().mockReturnValue({ isReady: () => false }) } as unknown as never,
    );
    await expect(aiCreditsMarketplace.purchaseAddon("org1", "ai_pack_1", 1)).rejects.toThrow(
      "AI credit pack not found",
    );
  });
});
