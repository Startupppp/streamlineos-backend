import { PayrollJobsWorkerService } from "../payroll-jobs-worker.service";
import type { PayrollJobsService } from "../payroll-jobs.service";

jest.mock("../../../../common/tenant", () => ({
  forEachOrg: async (
    _db: unknown,
    _name: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => {
    await fn(
      {
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      },
      "org-a",
    );
    return { organizations: 1, succeeded: 1, failed: 0 };
  },
  withTenant: (
    _db: unknown,
    _opts: unknown,
    fn: (tx: unknown) => Promise<unknown>,
  ) => fn({}),
  runWithTenantContext: (_opts: unknown, fn: () => Promise<unknown>) => fn(),
}));

describe("PayrollJobsWorkerService", () => {
  function makeWorker(handlers: {
    generate?: { generateRun: jest.Mock };
    publishing?: { publish: jest.Mock };
    filings?: { prepareExport: jest.Mock };
  }) {
    const claimed = [
      {
        id: 1,
        orgId: "org-a",
        jobType: "GENERATE",
        resourceId: "42",
        createdBy: "actor-1",
        payload: {},
      },
      {
        id: 2,
        orgId: "org-a",
        jobType: "PDF_PUBLISH",
        resourceId: "42",
        createdBy: "actor-1",
        payload: { userIds: ["u1"] },
      },
      {
        id: 3,
        orgId: "org-a",
        jobType: "FILING_EXPORT",
        resourceId: null,
        createdBy: "actor-1",
        payload: { filingType: "PF_ECR" },
      },
    ];

    const jobs = {
      claimPending: jest.fn().mockResolvedValue(claimed),
      setProgress: jest.fn().mockResolvedValue(undefined),
      succeed: jest.fn().mockResolvedValue({}),
      fail: jest.fn().mockResolvedValue({}),
    } as unknown as PayrollJobsService;

    const moduleRef = {
      get: jest.fn((token: unknown) => {
        if (token && (token as { name?: string }).name === "GenerateService") return handlers.generate;
        if (token && (token as { name?: string }).name === "PublishingService") return handlers.publishing;
        if (token && (token as { name?: string }).name === "PayrollFilingsService") return handlers.filings;
        return undefined;
      }),
    };

    const worker = new PayrollJobsWorkerService(
      jobs,
      moduleRef as never,
      {} as never,
      {} as never,
      handlers.generate as never,
      handlers.publishing as never,
      handlers.filings as never,
    );

    return { worker, jobs };
  }

  it("processes GENERATE, PDF_PUBLISH, and FILING_EXPORT successfully", async () => {
    const generate = { generateRun: jest.fn().mockResolvedValue({ ok: true }) };
    const publishing = {
      publish: jest.fn().mockResolvedValue({ published: 1, total: 1, runStatus: "PAYSLIPS_PUBLISHED" }),
    };
    const filings = {
      prepareExport: jest.fn().mockResolvedValue({
        id: 9,
        status: "EXPORT_PREPARED",
        statusLabel: "Export prepared — external filing required",
      }),
    };

    const { worker, jobs } = makeWorker({ generate, publishing, filings });
    const result = await worker.flush(10);

    expect(result.claimed).toBe(3);
    expect(result.completed).toBe(3);
    expect(result.failed).toBe(0);
    expect(generate.generateRun).toHaveBeenCalledWith("org-a", 42, "actor-1", false);
    expect(publishing.publish).toHaveBeenCalled();
    expect(filings.prepareExport).toHaveBeenCalled();
    expect(jobs.succeed).toHaveBeenCalledTimes(3);
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it("marks job FAILED when generate returns not ok", async () => {
    const generate = { generateRun: jest.fn().mockResolvedValue({ ok: false, reason: "locked" }) };
    const jobs = {
      claimPending: jest.fn().mockResolvedValue([
        {
          id: 7,
          orgId: "org-a",
          jobType: "GENERATE",
          resourceId: "1",
          createdBy: "a",
          payload: {},
        },
      ]),
      setProgress: jest.fn(),
      succeed: jest.fn(),
      fail: jest.fn(),
    } as unknown as PayrollJobsService;

    const worker = new PayrollJobsWorkerService(
      jobs,
      { get: jest.fn() } as never,
      {} as never,
      {} as never,
      generate as never,
      undefined,
      undefined,
    );

    const result = await worker.flush(5);
    expect(result.failed).toBe(1);
    expect(jobs.fail).toHaveBeenCalledWith("org-a", 7, "locked");
  });

  it("failed jobs remain failed and are not auto-succeeded", async () => {
    const jobs = {
      claimPending: jest.fn().mockResolvedValue([
        {
          id: 8,
          orgId: "org-a",
          jobType: "PDF_PUBLISH",
          resourceId: "1",
          createdBy: "a",
          payload: {},
        },
      ]),
      setProgress: jest.fn(),
      succeed: jest.fn(),
      fail: jest.fn(),
    } as unknown as PayrollJobsService;

    const publishing = {
      publish: jest.fn().mockRejectedValue(new Error("PDF generation failed")),
    };

    const worker = new PayrollJobsWorkerService(
      jobs,
      { get: jest.fn() } as never,
      {} as never,
      {} as never,
      undefined,
      publishing as never,
      undefined,
    );

    await worker.flush(1);
    expect(jobs.succeed).not.toHaveBeenCalled();
    expect(jobs.fail).toHaveBeenCalledWith("org-a", 8, "PDF generation failed");
  });
});
