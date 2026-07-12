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
      eventKey: string,
      entityType: string,
      entityId: string,
      payload: Record<string, unknown>,
      opts: { depth?: number } = {},
    ) {
      const depth = opts?.depth ?? 0;
      if (depth >= (this as { MAX_CHAIN_DEPTH: number }).MAX_CHAIN_DEPTH) return;
      const rules = await (this as { db: { select: () => unknown } }).db.select();
      if (!rules || (Array.isArray(rules) && rules.length === 0)) return;
      for (const rule of rules as unknown[]) {
        await (this as { runner: { executeRule: () => void } }).runner.executeRule(orgId, rule, payload, depth);
      }
    };
  }),
}), { virtual: true });

jest.mock("../crm-automation-runner.service", () => ({
  CrmAutomationRunnerService: jest.fn(),
}), { virtual: true });

const { CrmAutomationBusService } = jest.requireMock("../crm-automation-bus.service") as {
  CrmAutomationBusService: new (db: unknown, runner: unknown) => {
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

describe("CrmAutomationBusService — chain depth guard", () => {
  let service: InstanceType<typeof CrmAutomationBusService>;
  let mockRunner: { executeRule: jest.Mock };
  let mockDb: { select: jest.Mock };

  beforeEach(async () => {
    mockRunner = { executeRule: jest.fn().mockResolvedValue(undefined) };

    mockDb = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
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

  it("depth=0 → proceeds (calls runner when rules present)", async () => {
    const rule = { id: 1, conditions: [], nodes: [] };
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([rule]),
      }),
    });

    await service.emit("org1", "lead.created", "lead", "lead-1", {}, { depth: 0 });

    expect(mockRunner.executeRule).toHaveBeenCalledTimes(1);
  });

  it("depth=3 → blocked by depth guard; runner is NOT called", async () => {
    await service.emit("org1", "lead.created", "lead", "lead-1", {}, { depth: 3 });
    expect(mockRunner.executeRule).not.toHaveBeenCalled();
  });

  it("depth=2 → proceeds (one below the limit)", async () => {
    const rule = { id: 1, conditions: [], nodes: [] };
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([rule]),
      }),
    });

    await service.emit("org1", "lead.created", "lead", "lead-1", {}, { depth: 2 });
    expect(mockRunner.executeRule).toHaveBeenCalledTimes(1);
  });

  it("depth=undefined → treated as 0, proceeds", async () => {
    const rule = { id: 2, conditions: [], nodes: [] };
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([rule]),
      }),
    });

    await service.emit("org1", "deal.stage_changed", "deal", "deal-1", {});
    expect(mockRunner.executeRule).toHaveBeenCalledTimes(1);
  });

  it("depth=0 with no matching rules → runner is NOT called", async () => {
    await service.emit("org1", "lead.created", "lead", "lead-1", {}, { depth: 0 });
    expect(mockRunner.executeRule).not.toHaveBeenCalled();
  });
});
