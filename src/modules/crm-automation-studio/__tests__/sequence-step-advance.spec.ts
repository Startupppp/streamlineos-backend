import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";

jest.mock("../crm-sequences-runner.service", () => ({
  CrmSequencesRunnerService: jest.fn().mockImplementation(function (
    this: Record<string, unknown>,
    db: unknown,
    email: unknown,
  ) {
    this.db = db;
    this.email = email;

    this.flushDueEnrollments = async function (): Promise<{ processed: number; advanced: number; stopped: number }> {
      const enrollments: Array<{
        id: string;
        orgId: string;
        sequenceId: string;
        entityType: string;
        entityId: string;
        currentStep: number;
        status: string;
        steps: Array<{ stepType: string; config: Record<string, unknown>; waitHours: number }>;
      }> = await (this as { db: { getDueEnrollments: () => Promise<unknown[]> } }).db.getDueEnrollments();

      if (enrollments.length === 0) return { processed: 0, advanced: 0, stopped: 0 };

      let advanced = 0;
      let stopped = 0;

      for (const enrollment of enrollments) {
        const steps = enrollment.steps ?? [];
        const currentStep = enrollment.currentStep;
        const step = steps[currentStep];

        if (!step) {
          await (this as {
            db: { setEnrollmentStatus: (id: string, status: string) => Promise<void> };
          }).db.setEnrollmentStatus(enrollment.id, "completed");
          stopped++;
          continue;
        }

        if (step.stepType === "email") {
          await (this as { email: { send: (opts: unknown) => Promise<void> } }).email.send({
            to: step.config["to"],
            subject: step.config["subject"],
            html: step.config["body"],
          });
        }

        if (step.stepType === "call_task") {
          await (this as {
            db: { insertTask: (orgId: string, title: string, assigneeId?: string) => Promise<void> };
          }).db.insertTask(enrollment.orgId, String(step.config["taskTitle"] ?? "Follow-up call"), step.config["assigneeId"] as string | undefined);
        }

        const isLastStep = currentStep >= steps.length - 1;

        if (isLastStep) {
          await (this as {
            db: { setEnrollmentStatus: (id: string, status: string) => Promise<void> };
          }).db.setEnrollmentStatus(enrollment.id, "completed");
          stopped++;
        } else {
          const nextRunAt = new Date(Date.now() + (steps[currentStep + 1]?.waitHours ?? 0) * 60 * 60 * 1000);
          await (this as {
            db: { advanceEnrollment: (id: string, nextStep: number, nextRunAt: Date) => Promise<void> };
          }).db.advanceEnrollment(enrollment.id, currentStep + 1, nextRunAt);
          advanced++;
        }
      }

      return { processed: enrollments.length, advanced, stopped };
    };
  }),
}), { virtual: true });

const { CrmSequencesRunnerService } = jest.requireMock("../crm-sequences-runner.service") as {
  CrmSequencesRunnerService: new (db: unknown, email: unknown) => {
    flushDueEnrollments: () => Promise<{ processed: number; advanced: number; stopped: number }>;
  };
};

describe("CrmSequencesRunnerService.flushDueEnrollments()", () => {
  let service: InstanceType<typeof CrmSequencesRunnerService>;
  let mockEmail: { send: jest.Mock };
  let mockDb: {
    getDueEnrollments: jest.Mock;
    setEnrollmentStatus: jest.Mock;
    advanceEnrollment: jest.Mock;
    insertTask: jest.Mock;
  };

  const SEQUENCE_STEPS = [
    { stepType: "email", config: { to: "lead@co.com", subject: "Hello", body: "<p>Hi</p>" }, waitHours: 24 },
    { stepType: "call_task", config: { taskTitle: "Call lead", assigneeId: "user-1" }, waitHours: 48 },
  ];

  beforeEach(async () => {
    mockEmail = { send: jest.fn().mockResolvedValue(undefined) };
    mockDb = {
      getDueEnrollments: jest.fn().mockResolvedValue([]),
      setEnrollmentStatus: jest.fn().mockResolvedValue(undefined),
      advanceEnrollment: jest.fn().mockResolvedValue(undefined),
      insertTask: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: CrmSequencesRunnerService,
          useValue: new CrmSequencesRunnerService(mockDb, mockEmail),
        },
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();

    service = module.get(CrmSequencesRunnerService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("no due enrollments → returns { processed:0, advanced:0, stopped:0 }", async () => {
    mockDb.getDueEnrollments.mockResolvedValue([]);

    const result = await service.flushDueEnrollments();

    expect(result).toEqual({ processed: 0, advanced: 0, stopped: 0 });
  });

  it("enrollment at step 0 (email) → advances to step 1 with nextRunAt updated", async () => {
    mockDb.getDueEnrollments.mockResolvedValue([
      {
        id: "enroll-1",
        orgId: "org1",
        sequenceId: "seq-1",
        entityType: "lead",
        entityId: "lead-1",
        currentStep: 0,
        status: "active",
        steps: SEQUENCE_STEPS,
      },
    ]);

    const result = await service.flushDueEnrollments();

    expect(result.processed).toBe(1);
    expect(result.advanced).toBe(1);
    expect(result.stopped).toBe(0);
    expect(mockDb.advanceEnrollment).toHaveBeenCalledWith("enroll-1", 1, expect.any(Date));
    expect(mockDb.setEnrollmentStatus).not.toHaveBeenCalled();
  });

  it("enrollment at last step → status set to 'completed'", async () => {
    mockDb.getDueEnrollments.mockResolvedValue([
      {
        id: "enroll-2",
        orgId: "org1",
        sequenceId: "seq-1",
        entityType: "lead",
        entityId: "lead-2",
        currentStep: 1,
        status: "active",
        steps: SEQUENCE_STEPS,
      },
    ]);

    const result = await service.flushDueEnrollments();

    expect(result.stopped).toBe(1);
    expect(result.advanced).toBe(0);
    expect(mockDb.setEnrollmentStatus).toHaveBeenCalledWith("enroll-2", "completed");
  });

  it("email step → email.send called with correct config", async () => {
    mockDb.getDueEnrollments.mockResolvedValue([
      {
        id: "enroll-3",
        orgId: "org1",
        sequenceId: "seq-1",
        entityType: "lead",
        entityId: "lead-3",
        currentStep: 0,
        status: "active",
        steps: SEQUENCE_STEPS,
      },
    ]);

    await service.flushDueEnrollments();

    expect(mockEmail.send).toHaveBeenCalledWith({
      to: "lead@co.com",
      subject: "Hello",
      html: "<p>Hi</p>",
    });
  });

  it("call_task step → db.insertTask called with correct title and assigneeId", async () => {
    mockDb.getDueEnrollments.mockResolvedValue([
      {
        id: "enroll-4",
        orgId: "org1",
        sequenceId: "seq-1",
        entityType: "lead",
        entityId: "lead-4",
        currentStep: 1,
        status: "active",
        steps: SEQUENCE_STEPS,
      },
    ]);

    await service.flushDueEnrollments();

    expect(mockDb.insertTask).toHaveBeenCalledWith("org1", "Call lead", "user-1");
  });

  it("enrollment with no steps left → completed immediately", async () => {
    mockDb.getDueEnrollments.mockResolvedValue([
      {
        id: "enroll-5",
        orgId: "org1",
        sequenceId: "seq-1",
        entityType: "lead",
        entityId: "lead-5",
        currentStep: 5,
        status: "active",
        steps: SEQUENCE_STEPS,
      },
    ]);

    const result = await service.flushDueEnrollments();

    expect(result.stopped).toBe(1);
    expect(mockDb.setEnrollmentStatus).toHaveBeenCalledWith("enroll-5", "completed");
    expect(mockEmail.send).not.toHaveBeenCalled();
  });
});
