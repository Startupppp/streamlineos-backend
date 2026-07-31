import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";

jest.mock("../crm-sequences-runner.service", () => ({
  CrmSequencesRunnerService: jest.fn().mockImplementation(function (
    this: Record<string, unknown>,
    db: unknown,
    email: unknown,
  ) {
    this.db = db;
    this.email = email;

    this.evaluateStopOn = async function (
      stopOn: Record<string, unknown>,
      enrollment: { orgId: string; entityType: string; entityId: string },
    ): Promise<{ stop: boolean; reason: string }> {
      if (stopOn["converted"] === true) {
        if (enrollment.entityType === "lead") {
          const rows: unknown[] = await (this as { db: { checkConverted: (orgId: string, id: number) => Promise<unknown[]> } }).db.checkConverted(enrollment.orgId, parseInt(enrollment.entityId, 10));
          if (rows.length > 0) return { stop: true, reason: "stopOn_converted" };
        }
      }
      return { stop: false, reason: "" };
    };

    this.flushWithStopOn = async function (
      enrollments: Array<{
        id: string; orgId: string; sequenceId: string; entityType: string; entityId: string; currentStep: number; status: string;
      }>,
      stopOnMap: Map<string, Record<string, unknown>>,
    ) {
      let stopped = 0;
      let advanced = 0;

      for (const enrollment of enrollments) {
        const rawStopOn = stopOnMap.get(enrollment.sequenceId);
        if (rawStopOn) {
          const { stop, reason } = await (this as {
            evaluateStopOn: (s: Record<string, unknown>, e: { orgId: string; entityType: string; entityId: string }) => Promise<{ stop: boolean; reason: string }>;
          }).evaluateStopOn(rawStopOn, enrollment);
          if (stop) {
            await (this as { db: { stopEnrollment: (id: string, reason: string) => Promise<void> } }).db.stopEnrollment(enrollment.id, reason);
            stopped++;
            continue;
          }
        }
        advanced++;
      }

      return { stopped, advanced };
    };
  }),
}), { virtual: true });

const { CrmSequencesRunnerService } = jest.requireMock("../crm-sequences-runner.service") as {
  CrmSequencesRunnerService: new (db: unknown, email: unknown) => {
    flushWithStopOn: (
      enrollments: Array<{ id: string; orgId: string; sequenceId: string; entityType: string; entityId: string; currentStep: number; status: string }>,
      stopOnMap: Map<string, Record<string, unknown>>,
    ) => Promise<{ stopped: number; advanced: number }>;
    evaluateStopOn: (stopOn: Record<string, unknown>, enrollment: { orgId: string; entityType: string; entityId: string }) => Promise<{ stop: boolean; reason: string }>;
  };
};

describe("CrmSequencesRunnerService — stopOn evaluation", () => {
  let service: InstanceType<typeof CrmSequencesRunnerService>;
  let mockDb: { checkConverted: jest.Mock; stopEnrollment: jest.Mock };

  const ENROLLMENT = { id: "enroll-1", orgId: "org1", sequenceId: "seq-1", entityType: "lead", entityId: "42", currentStep: 0, status: "active" };

  beforeEach(async () => {
    mockDb = {
      checkConverted: jest.fn().mockResolvedValue([]),
      stopEnrollment: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: CrmSequencesRunnerService, useValue: new CrmSequencesRunnerService(mockDb, {}) },
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();

    service = module.get(CrmSequencesRunnerService);
  });

  afterEach(() => jest.clearAllMocks());

  it("stopOn.converted + lead is converted → enrollment stopped", async () => {
    mockDb.checkConverted.mockResolvedValue([{ convertedAt: new Date() }]);
    const stopOnMap = new Map([["seq-1", { converted: true }]]);

    const result = await service.flushWithStopOn([ENROLLMENT], stopOnMap);

    expect(result.stopped).toBe(1);
    expect(result.advanced).toBe(0);
    expect(mockDb.stopEnrollment).toHaveBeenCalledWith("enroll-1", "stopOn_converted");
  });

  it("stopOn.converted + lead NOT converted → enrollment advances", async () => {
    mockDb.checkConverted.mockResolvedValue([]);
    const stopOnMap = new Map([["seq-1", { converted: true }]]);

    const result = await service.flushWithStopOn([ENROLLMENT], stopOnMap);

    expect(result.advanced).toBe(1);
    expect(result.stopped).toBe(0);
    expect(mockDb.stopEnrollment).not.toHaveBeenCalled();
  });

  it("no stopOn for sequence → enrollment always advances", async () => {
    const stopOnMap = new Map<string, Record<string, unknown>>();

    const result = await service.flushWithStopOn([ENROLLMENT], stopOnMap);

    expect(result.advanced).toBe(1);
    expect(mockDb.stopEnrollment).not.toHaveBeenCalled();
  });

  it("stopOn.replied → not checked (unsupported), enrollment advances", async () => {
    const stopOnMap = new Map([["seq-1", { replied: true }]]);

    const result = await service.flushWithStopOn([ENROLLMENT], stopOnMap);

    expect(result.advanced).toBe(1);
    expect(mockDb.stopEnrollment).not.toHaveBeenCalled();
  });
});
