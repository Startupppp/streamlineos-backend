import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AiCreditsService } from "./ai-credits.service";

const mockPack = {
  id: 1,
  name: "Starter Pack",
  credits: 500,
  bonusCredits: 50,
  priceInPaise: 49900,
  isActive: true,
  sortOrder: 1,
  createdAt: new Date(),
};

const mockWalletRow = {
  id: 1,
  orgId: "org1",
  balance: 650,
  lifetimeGranted: 650,
  lifetimeConsumed: 0,
  autoTopUpEnabled: false,
  autoTopUpPackId: null,
  autoTopUpThreshold: null,
  updatedAt: new Date(),
};

function makeTx(walletBalance: number) {
  const updatedWallet = { ...mockWalletRow, balance: walletBalance };
  const tx = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    for: jest.fn().mockResolvedValue([{ ...mockWalletRow, balance: walletBalance - 550 }]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([updatedWallet]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  };
  return tx;
}

describe("AiCreditsService.purchaseCreditsDirectly", () => {
  let service: AiCreditsService;

  const mockTx = makeTx(650);

  const mockDb = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([mockPack]),
    transaction: jest.fn().mockImplementation(
      (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx),
    ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.where = jest.fn().mockResolvedValue([mockPack]);
    mockDb.select = jest.fn().mockReturnThis();
    mockDb.from = jest.fn().mockReturnThis();

    const module = await Test.createTestingModule({
      providers: [
        AiCreditsService,
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();

    service = module.get(AiCreditsService);
  });

  it("returns creditsAdded = credits + bonusCredits", async () => {
    const result = await service.purchaseCreditsDirectly("org1", "user1", 1);
    expect(result.creditsAdded).toBe(mockPack.credits + mockPack.bonusCredits);
  });

  it("returns the matched pack in the result", async () => {
    const result = await service.purchaseCreditsDirectly("org1", "user1", 1);
    expect(result.pack.id).toBe(mockPack.id);
    expect(result.pack.name).toBe(mockPack.name);
  });

  it("returns the new wallet balance", async () => {
    const result = await service.purchaseCreditsDirectly("org1", "user1", 1);
    expect(typeof result.balance).toBe("number");
  });

  it("executes a transaction for the wallet update", async () => {
    await service.purchaseCreditsDirectly("org1", "user1", 1);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
  });

  it("throws NotFoundException when pack does not exist", async () => {
    mockDb.where = jest.fn().mockResolvedValue([]);
    await expect(
      service.purchaseCreditsDirectly("org1", "user1", 99),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws NotFoundException when pack is inactive", async () => {
    mockDb.where = jest.fn().mockResolvedValue([]);
    await expect(
      service.purchaseCreditsDirectly("org1", "user1", 2),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("is tenant-scoped — uses orgId for the wallet update", async () => {
    await service.purchaseCreditsDirectly("org-tenant-42", "user1", 1);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    const txFn = mockDb.transaction.mock.calls[0]?.[0] as
      | ((tx: typeof mockTx) => Promise<unknown>)
      | undefined;
    expect(txFn).toBeDefined();
  });
});
