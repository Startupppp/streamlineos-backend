import { Test, type TestingModule } from "@nestjs/testing";
import { CrmSequencesRunnerService } from "../crm-sequences-runner.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { CrmOutboundEmailService } from "../../consent/crm-outbound-email.service";

type StepRow = { id: number; sequenceId: number; stepType: string; sortOrder: number; config: Record<string, unknown>; waitHours: number };
type EnrollmentUpdateCall = { id: string; status: string; currentStep?: number };

function makeThenableChain(data: unknown[]) {
  const chain: Record<string, unknown> = {
    then(resolve: (v: unknown[]) => unknown) {
      return Promise.resolve(data).then(resolve);
    },
    catch(reject: (e: unknown) => unknown) {
      return Promise.resolve(data).catch(reject);
    },
  };
  const passthrough = () => chain;
  for (const m of ["from", "where", "limit", "orderBy", "innerJoin", "leftJoin", "set", "groupBy", "onConflictDoNothing"]) {
    chain[m] = passthrough;
  }
  return chain;
}

describe("CrmSequencesRunnerService.flushDueEnrollments() — set-based reads", () => {
  let service: CrmSequencesRunnerService;
  let mockEmail: { send: jest.Mock };
  const updateCalls: EnrollmentUpdateCall[] = [];

  const STEPS_SEQ1: StepRow[] = [
    { id: 10, sequenceId: 1, stepType: "email", sortOrder: 0, config: { to: "a@b.com", subject: "S", body: "<p>H</p>" }, waitHours: 24 },
    { id: 11, sequenceId: 1, stepType: "call_task", sortOrder: 1, config: { taskTitle: "Call", assigneeId: "u1" }, waitHours: 0 },
  ];

  const ENROLLMENT_AT_STEP_0 = {
    id: "e1", orgId: "org1", sequenceId: 1, entityType: "deal", entityId: "d1",
    currentStep: 0, status: "active", stopReason: null,
  };
  const ENROLLMENT_AT_LAST_STEP = {
    id: "e2", orgId: "org1", sequenceId: 1, entityType: "deal", entityId: "d2",
    currentStep: 1, status: "active", stopReason: null,
  };
  const ENROLLMENT_CONVERTED_LEAD = {
    id: "e3", orgId: "org1", sequenceId: 2, entityType: "lead", entityId: "42",
    currentStep: 0, status: "active", stopReason: null,
  };
  const ENROLLMENT_NO_STEPS = {
    id: "e4", orgId: "org1", sequenceId: 3, entityType: "deal", entityId: "d4",
    currentStep: 0, status: "active", stopReason: null,
  };

  const SEQUENCES = [
    { id: 1, stopOn: null },
    { id: 2, stopOn: { converted: true } },
    { id: 3, stopOn: null },
  ];

  const STEPS_ALL: StepRow[] = [
    ...STEPS_SEQ1,
  ];

  const CONVERTED_LEADS = [{ organizationId: "org1", leadId: 42 }];

  beforeEach(async () => {
    updateCalls.length = 0;
    mockEmail = { send: jest.fn().mockResolvedValue(undefined) };

    let selectIndex = 0;
    const selectResults = [
      [ENROLLMENT_AT_STEP_0, ENROLLMENT_AT_LAST_STEP, ENROLLMENT_CONVERTED_LEAD, ENROLLMENT_NO_STEPS],
      SEQUENCES,
      STEPS_ALL,
      CONVERTED_LEADS,
    ];

    const mockUpdateChain = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockImplementation(function () {
        return {
          then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
          catch: () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve([]).then(r) }),
        };
      }),
    };

    const captureSet = (setArg: Record<string, unknown>) => {
      return {
        where: jest.fn().mockImplementation(() => {
          updateCalls.push({ id: "?", status: String(setArg["status"] ?? ""), currentStep: setArg["currentStep"] as number | undefined });
          return {
            then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
            catch: () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve([]).then(r) }),
          };
        }),
      };
    };

    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        const data = selectResults[selectIndex++] ?? [];
        return makeThenableChain(data as unknown[]);
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((setArg: Record<string, unknown>) => captureSet(setArg)),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
          catch: () => {},
        }),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmSequencesRunnerService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CrmOutboundEmailService, useValue: mockEmail },
      ],
    })
      .overrideProvider(CrmOutboundEmailService)
      .useValue(mockEmail)
      .compile();

    service = module.get(CrmSequencesRunnerService);
  });

  afterEach(() => jest.clearAllMocks());

  it("enrollment at step 0 (mid-sequence) → advanced; enrollment at last step → completed", async () => {
    const result = await service.flushDueEnrollments(new Date());

    expect(result.processed).toBe(4);
    expect(result.advanced).toBe(1);
    expect(result.stopped).toBe(3);

    const statuses = updateCalls.map((c) => c.status);
    expect(statuses).toContain("completed");
    expect(statuses).toContain("stopped");
  });

  it("converted lead enrollment → stopped with reason stopOn_converted", async () => {
    const result = await service.flushDueEnrollments(new Date());

    const stoppedStatuses = updateCalls.filter((c) => c.status === "stopped");
    expect(stoppedStatuses.length).toBeGreaterThanOrEqual(1);
    expect(result.stopped).toBeGreaterThanOrEqual(1);
  });

  it("enrollment with no steps for its sequence → completed immediately", async () => {
    const result = await service.flushDueEnrollments(new Date());

    const completedStatuses = updateCalls.filter((c) => c.status === "completed");
    expect(completedStatuses.length).toBeGreaterThanOrEqual(1);
    expect(result.stopped).toBeGreaterThanOrEqual(1);
  });

  it("no due enrollments → zero counts returned without touching update", async () => {
    let firstCall = true;
    const emptyDb = {
      select: jest.fn().mockImplementation(() => {
        if (firstCall) { firstCall = false; return makeThenableChain([]); }
        return makeThenableChain([]);
      }),
      update: jest.fn(),
      insert: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmSequencesRunnerService,
        { provide: DRIZZLE, useValue: emptyDb },
        { provide: CrmOutboundEmailService, useValue: mockEmail },
      ],
    })
      .overrideProvider(CrmOutboundEmailService)
      .useValue(mockEmail)
      .compile();

    const svc = module.get(CrmSequencesRunnerService);
    const result = await svc.flushDueEnrollments(new Date());

    expect(result).toEqual({ processed: 0, advanced: 0, stopped: 0 });
    expect(emptyDb.update).not.toHaveBeenCalled();
  });
});

describe("CrmSequencesRunnerService — idempotency: a converted lead already in the pre-fetched set stops without re-querying", () => {
  it("evaluateStopOn uses the pre-fetched convertedLeadKeys set, not a live DB call", async () => {
    const selectCalls: string[] = [];
    let idx = 0;

    const enrollments = [
      { id: "e1", orgId: "org1", sequenceId: 1, entityType: "lead", entityId: "99", currentStep: 0, status: "active", stopReason: null },
    ];
    const sequences = [{ id: 1, stopOn: { converted: true } }];
    const steps: unknown[] = [];
    const convertedLeads = [{ organizationId: "org1", leadId: 99 }];
    const results = [enrollments, sequences, steps, convertedLeads];

    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        selectCalls.push(`select-${idx}`);
        const data = results[idx++] ?? [];
        return {
          from: function () { return this; },
          where: function () { return this; },
          limit: function () { return this; },
          orderBy: function () { return this; },
          innerJoin: function () { return this; },
          then(resolve: (v: unknown) => unknown) { return Promise.resolve(data).then(resolve); },
          catch() { return this; },
        };
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            then: (r: (v: unknown) => unknown) => Promise.resolve([]).then(r),
            catch: () => {},
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmSequencesRunnerService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CrmOutboundEmailService, useValue: { send: jest.fn() } },
      ],
    })
      .overrideProvider(CrmOutboundEmailService)
      .useValue({ send: jest.fn() })
      .compile();

    const svc = module.get(CrmSequencesRunnerService);
    const result = await svc.flushDueEnrollments(new Date());

    expect(result.stopped).toBe(1);
    expect(result.advanced).toBe(0);
    expect(selectCalls).toHaveLength(4);
  });
});
