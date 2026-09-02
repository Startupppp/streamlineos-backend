import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  FILING_EXPORT_RESOURCE_TYPE,
  PayrollFilingsExportJobService,
} from "../filings-export-job.service";
import { PayrollJobsWorkerService } from "../../jobs/payroll-jobs-worker.service";
import type { PayrollJobsService } from "../../jobs/payroll-jobs.service";

jest.mock("../../../../common/tenant", () => ({
  forEachOrg: async (
    _db: unknown,
    _name: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => {
    await fn(
      {
        update: () => ({
          set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
        }),
      },
      "org-a",
    );
    return { organizations: 1, succeeded: 1, failed: 0 };
  },
  withTenant: (_db: unknown, _opts: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}),
  runWithTenantContext: (_opts: unknown, fn: () => Promise<unknown>) => fn(),
}));

const ORG = "org-a";
const ACTOR = "actor-1";

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 41,
    orgId: ORG,
    jobType: "FILING_EXPORT",
    status: "PENDING",
    progress: 0,
    correlationId: "corr-1",
    errorMessage: null,
    result: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    finishedAt: null,
    ...overrides,
  };
}

function makeService(jobs: Partial<PayrollJobsService>, entity?: { countryCode: string }) {
  const entities = {
    getEntity: jest.fn().mockResolvedValue(entity ?? { id: 3, countryCode: "IN" }),
    assertNoCountryContamination: jest.fn(),
    ensurePeriod: jest.fn(),
  };
  const service = new PayrollFilingsExportJobService(jobs as never, entities as never);
  return { service, entities };
}

describe("POST /payroll/filings/export — durable job, not an inline CSV build", () => {
  it("enqueues a FILING_EXPORT job and touches no payroll data on the request thread", async () => {
    const enqueue = jest.fn().mockResolvedValue(jobRow());
    const { service, entities } = makeService({ enqueue });

    const view = await service.requestExport(ORG, ACTOR, {
      filingType: "PF_ECR",
      month: "2026-07",
      entityId: 3,
    });

    // The service holds no database handle at all; the only synchronous work is
    // the entity read, and the period row is created by the worker, not here.
    expect(entities.ensurePeriod).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const args = enqueue.mock.calls[0]?.[0];
    expect(args.jobType).toBe("FILING_EXPORT");
    expect(args.orgId).toBe(ORG);
    expect(args.actorId).toBe(ACTOR);
    expect(args.resourceType).toBe(FILING_EXPORT_RESOURCE_TYPE);
    expect(args.payload).toMatchObject({ filingType: "PF_ECR", month: "2026-07", entityId: 3 });
    expect(view).toMatchObject({ jobId: 41, status: "PENDING", filingId: null });
    expect(view.statusLabel).toContain("queued");
  });

  it("carries runId through to the worker payload and onto the job resource", async () => {
    const enqueue = jest.fn().mockResolvedValue(jobRow());
    const { service } = makeService({ enqueue });

    await service.requestExport(ORG, ACTOR, { filingType: "TDS_24Q", runId: 88 });

    const args = enqueue.mock.calls[0]?.[0];
    expect(args.payload.runId).toBe(88);
    expect(args.resourceId).toBe("88");
  });

  it("rejects an unsupported filing type before anything is enqueued", async () => {
    const enqueue = jest.fn();
    const { service } = makeService({ enqueue });

    await expect(
      service.requestExport(ORG, ACTOR, { filingType: "NOT_A_FILING" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects a non-India entity before anything is enqueued", async () => {
    const enqueue = jest.fn();
    const { service } = makeService({ enqueue }, { countryCode: "US" });

    await expect(
      service.requestExport(ORG, ACTOR, { filingType: "PF_ECR", entityId: 3 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reports the prepared filing id once the job succeeds", async () => {
    const get = jest.fn().mockResolvedValue(
      jobRow({ status: "SUCCEEDED", progress: 100, result: { filingId: 512 } }),
    );
    const { service } = makeService({ get });

    const view = await service.getExportJob(ORG, 41);
    expect(view).toMatchObject({ jobId: 41, status: "SUCCEEDED", filingId: 512 });
    expect(view.statusLabel).toBe("Export prepared — external filing required");
  });

  it("refuses to expose a job of another type through the filings status route", async () => {
    const get = jest.fn().mockResolvedValue(jobRow({ jobType: "GENERATE" }));
    const { service } = makeService({ get });

    await expect(service.getExportJob(ORG, 41)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("PayrollJobsWorkerService — FILING_EXPORT run/month passthrough", () => {
  it("hands runId and month to prepareExport so a queued export resolves its run", async () => {
    const prepareExport = jest.fn().mockResolvedValue({ id: 9, status: "EXPORT_PREPARED" });
    const jobs = {
      claimPending: jest.fn().mockResolvedValue([
        {
          id: 3,
          orgId: ORG,
          jobType: "FILING_EXPORT",
          resourceId: "88",
          createdBy: ACTOR,
          payload: { filingType: "PF_ECR", runId: 88, month: "2026-07", entityId: 3 },
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
      undefined,
      undefined,
      { prepareExport } as never,
    );

    const result = await worker.flush(5);
    expect(result.completed).toBe(1);
    expect(prepareExport).toHaveBeenCalledWith(
      ORG,
      ACTOR,
      expect.objectContaining({ filingType: "PF_ECR", runId: 88, month: "2026-07", entityId: 3 }),
    );
    expect(jobs.fail).not.toHaveBeenCalled();
  });
});
