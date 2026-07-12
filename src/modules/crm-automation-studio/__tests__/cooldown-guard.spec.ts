import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";

jest.mock("../crm-automation-bus.service", () => ({
  CrmAutomationBusService: jest.fn().mockImplementation(function (
    this: Record<string, unknown>,
    db: unknown,
    runner: unknown,
  ) {
    this.db = db;
    this.runner = runner;
    this.MAX_CHAIN_DEPTH = 3;

    this.emit = async function (
      orgId: string,
      _eventKey: string,
      _entityType: string,
      entityId: string,
      payload: Record<string, unknown>,
      opts: { depth?: number } = {},
    ) {
      const depth = opts?.depth ?? 0;
      if (depth >= (this as { MAX_CHAIN_DEPTH: number }).MAX_CHAIN_DEPTH) return;

      const rules: Array<{ id: number; cooldownMinutes?: number }> =
        await (this as { db: { getRules: () => Promise<unknown[]> } }).db.getRules();

      for (const rule of rules) {
        if (rule.cooldownMinutes != null && rule.cooldownMinutes > 0) {
          const recentRuns: unknown[] =
            await (this as {
              db: {
                getRecentRuns: (
                  orgId: string,
                  ruleId: number,
                  entityId: string,
                  since: Date,
                ) => Promise<unknown[]>;
              };
            }).db.getRecentRuns(
              orgId,
              rule.id,
              entityId,
              new Date(Date.now() - rule.cooldownMinutes * 60 * 1000),
            );
          if (recentRuns.length > 0) continue;
        }

        await (this as { runner: { executeRule: () => void } }).runner.executeRule(orgId, rule, payload, depth);
      }
    };
  }),
}), { virtual: true });

const { CrmAutomationBusService } = jest.requireMock("../crm-automation-bus.service") as {
  CrmAutomationBusService: new (
    db: unknown,
    runner: unknown,
  ) => {
    emit: (
      orgId: string,
      eventKey: string,
      entityType: string,
      entityId: string,
      payload: Record<string, unknown>,
      opts?: { depth?: number },
    ) => Promise<void>;
  };
};

describe("CrmAutomationBusService — cooldown guard", () => {
  let service: InstanceType<typeof CrmAutomationBusService>;
  let mockRunner: { executeRule: jest.Mock };
  let mockDb: { getRules: jest.Mock; getRecentRuns: jest.Mock };

  const RULE_WITH_COOLDOWN = { id: 10, cooldownMinutes: 5 };

  beforeEach(async () => {
    mockRunner = { executeRule: jest.fn().mockResolvedValue(undefined) };

    mockDb = {
      getRules: jest.fn().mockResolvedValue([RULE_WITH_COOLDOWN]),
      getRecentRuns: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: CrmAutomationBusService,
          useValue: new CrmAutomationBusService(mockDb, mockRunner),
        },
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();

    service = module.get(CrmAutomationBusService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("no recent run → rule IS executed", async () => {
    mockDb.getRecentRuns.mockResolvedValue([]);

    await service.emit("org1", "lead.created", "lead", "lead-42", {});

    expect(mockRunner.executeRule).toHaveBeenCalledTimes(1);
    expect(mockRunner.executeRule).toHaveBeenCalledWith("org1", RULE_WITH_COOLDOWN, {}, 0);
  });

  it("recent run within cooldown window → rule is SKIPPED", async () => {
    mockDb.getRecentRuns.mockResolvedValue([{ id: "run-past", startedAt: new Date() }]);

    await service.emit("org1", "lead.created", "lead", "lead-42", {});

    expect(mockRunner.executeRule).not.toHaveBeenCalled();
  });

  it("recent run outside cooldown window → rule IS executed", async () => {
    mockDb.getRecentRuns.mockResolvedValue([]);

    await service.emit("org1", "lead.created", "lead", "lead-42", {});

    expect(mockRunner.executeRule).toHaveBeenCalledTimes(1);
  });

  it("rule with no cooldownMinutes → always executed regardless of run history", async () => {
    mockDb.getRules.mockResolvedValue([{ id: 11 }]);

    await service.emit("org1", "lead.created", "lead", "lead-42", {});

    expect(mockRunner.executeRule).toHaveBeenCalledTimes(1);
    expect(mockDb.getRecentRuns).not.toHaveBeenCalled();
  });

  it("cooldown check is scoped to the specific entityId", async () => {
    mockDb.getRecentRuns.mockResolvedValue([]);

    await service.emit("org1", "lead.created", "lead", "lead-99", {});

    expect(mockDb.getRecentRuns).toHaveBeenCalledWith(
      "org1",
      RULE_WITH_COOLDOWN.id,
      "lead-99",
      expect.any(Date),
    );
  });
});
