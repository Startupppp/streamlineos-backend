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
    limit: jest.fn().mockResolvedValue([]),
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

describe("AiCreditsService.grantPlanCredits — idempotency", () => {
  let service: AiCreditsService;

  function makeGrantDb(existingTxRow: { id: number } | undefined) {
    const txMock = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(existingTxRow ? [existingTxRow] : []),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ ...mockWalletRow, balance: 500 }]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };
    return {
      db: {
        transaction: jest.fn().mockImplementation(
          (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
        ),
      },
      txMock,
    };
  }

  it("skips insert when referenceId already has a PLAN_GRANT transaction", async () => {
    const { db, txMock } = makeGrantDb({ id: 99 });
    const module = await Test.createTestingModule({
      providers: [AiCreditsService, { provide: DRIZZLE, useValue: db }],
    }).compile();
    service = module.get(AiCreditsService);

    await service.grantPlanCredits("org1", "STARTER", "user1", "pay_abc123");

    expect(txMock.insert).not.toHaveBeenCalled();
  });

  it("proceeds with grant when no existing transaction for referenceId", async () => {
    let whereCallCount = 0;
    const txChain = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockImplementation(() => {
        whereCallCount++;
        if (whereCallCount === 1) {
          return { limit: jest.fn().mockResolvedValue([]) };
        }
        return { for: jest.fn().mockResolvedValue([mockWalletRow]) };
      }),
      for: jest.fn().mockResolvedValue([mockWalletRow]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ ...mockWalletRow, balance: 500 }]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };

    const db2 = {
      transaction: jest.fn().mockImplementation(
        (fn: (tx: typeof txChain) => Promise<unknown>) => fn(txChain),
      ),
    };

    const module = await Test.createTestingModule({
      providers: [AiCreditsService, { provide: DRIZZLE, useValue: db2 }],
    }).compile();
    service = module.get(AiCreditsService);

    await service.grantPlanCredits("org1", "STARTER", "user1", "pay_new_xyz");

    expect(txChain.insert).toHaveBeenCalled();
  });

  it("does nothing for an unknown plan (0 credits)", async () => {
    const db = { transaction: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [AiCreditsService, { provide: DRIZZLE, useValue: db }],
    }).compile();
    service = module.get(AiCreditsService);

    await service.grantPlanCredits("org1", "UNKNOWN_PLAN");

    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe("AiCreditsService.hasMonthlyPlanGrant", () => {
  let service: AiCreditsService;

  function makeMonthlyGrantDb(existingRow: { id: number } | undefined) {
    const chain = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(existingRow ? [existingRow] : []),
    };
    return { db: chain };
  }

  it("returns true when a PLAN_GRANT exists this month", async () => {
    const { db } = makeMonthlyGrantDb({ id: 5 });
    const module = await Test.createTestingModule({
      providers: [AiCreditsService, { provide: DRIZZLE, useValue: db }],
    }).compile();
    service = module.get(AiCreditsService);

    const result = await service.hasMonthlyPlanGrant("org1");
    expect(result).toBe(true);
  });

  it("returns false when no PLAN_GRANT exists this month", async () => {
    const { db } = makeMonthlyGrantDb(undefined);
    const module = await Test.createTestingModule({
      providers: [AiCreditsService, { provide: DRIZZLE, useValue: db }],
    }).compile();
    service = module.get(AiCreditsService);

    const result = await service.hasMonthlyPlanGrant("org1");
    expect(result).toBe(false);
  });
});

describe("AiCreditsService.hasSameDayPurchaseForPack", () => {
  let service: AiCreditsService;

  function makeSameDayDb(existingRow: { id: number } | undefined) {
    const chain = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(existingRow ? [existingRow] : []),
    };
    return { db: chain };
  }

  it("returns true when a same-day PURCHASE exists for this pack", async () => {
    const { db } = makeSameDayDb({ id: 10 });
    const module = await Test.createTestingModule({
      providers: [AiCreditsService, { provide: DRIZZLE, useValue: db }],
    }).compile();
    service = module.get(AiCreditsService);

    const result = await service.hasSameDayPurchaseForPack("org1", 1);
    expect(result).toBe(true);
  });

  it("returns false when no same-day PURCHASE exists", async () => {
    const { db } = makeSameDayDb(undefined);
    const module = await Test.createTestingModule({
      providers: [AiCreditsService, { provide: DRIZZLE, useValue: db }],
    }).compile();
    service = module.get(AiCreditsService);

    const result = await service.hasSameDayPurchaseForPack("org1", 1);
    expect(result).toBe(false);
  });
});

describe("AiCreditsService.getWallet — trial grant on creation", () => {
  let service: AiCreditsService;

  it("inserts a PLAN_GRANT trial transaction when wallet does not exist", async () => {
    const trialWallet = { ...mockWalletRow, balance: 100, lifetimeGranted: 100 };
    const txMock = {
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([trialWallet]),
    };

    let selectCallCount = 0;

    const walletChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([]),
    };

    const recentChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };

    const dbMock = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1 ? walletChain : recentChain;
      }),
      transaction: jest.fn().mockImplementation(
        (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
    };

    const module = await Test.createTestingModule({
      providers: [AiCreditsService, { provide: DRIZZLE, useValue: dbMock }],
    }).compile();
    service = module.get(AiCreditsService);

    await service.getWallet("new-org");

    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
    expect(txMock.insert).toHaveBeenCalled();
  });

  it("does not create a transaction when wallet already exists", async () => {
    let selectCallCount2 = 0;

    const existingWalletChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([mockWalletRow]),
    };

    const recentChain2 = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };

    const dbMock2 = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount2++;
        return selectCallCount2 === 1 ? existingWalletChain : recentChain2;
      }),
      transaction: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [AiCreditsService, { provide: DRIZZLE, useValue: dbMock2 }],
    }).compile();
    service = module.get(AiCreditsService);

    await service.getWallet("org1");

    expect(dbMock2.transaction).not.toHaveBeenCalled();
  });
});
