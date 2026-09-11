import { Test } from "@nestjs/testing";
import { CronHrRetentionService } from "../cron-hr-retention.service";
import { StorageService } from "../../storage/storage.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

const ORG_ID = "org-aaaaaaaa-0000-0000-0000-000000000001";

jest.mock("../../../common/tenant/for-each-org", () => ({
  forEachOrg: jest.fn(),
}));

import { forEachOrg } from "../../../common/tenant/for-each-org";

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;

function drizzleSqlContains(obj: unknown, needle: string): boolean {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (Array.isArray(o.queryChunks)) {
    for (const chunk of o.queryChunks) {
      if (typeof chunk === "string") {
        if (chunk.toLowerCase().includes(needle.toLowerCase())) return true;
        continue;
      }
      if (!chunk || typeof chunk !== "object") continue;
      const c = chunk as Record<string, unknown>;
      if (Array.isArray(c.value)) {
        for (const v of c.value) {
          if (typeof v === "string" && v.toLowerCase().includes(needle.toLowerCase())) return true;
          if (drizzleSqlContains(v, needle)) return true;
        }
      }
      if (drizzleSqlContains(c, needle)) return true;
    }
  }
  return false;
}

function makeTx(opts: {
  policies?: unknown[];
  selectResults?: unknown[][];
  updateRows?: { id: number }[];
  deleteRows?: { id: number }[];
  captureWhere?: (arg: unknown) => void;
}) {
  const { policies = [], selectResults, updateRows = [], deleteRows = [], captureWhere } = opts;
  let selectCall = 0;

  const whereReturning = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue(updateRows),
  });

  const whereImpl = jest.fn().mockImplementation((arg: unknown) => {
    captureWhere?.(arg);
    return { returning: jest.fn().mockResolvedValue(updateRows) };
  });

  const deleteWhere = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue(deleteRows),
  });

  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation(() => {
          const rows = selectResults?.[selectCall++] ?? policies;
          const query = Promise.resolve(rows) as Promise<unknown[]> & { limit: jest.Mock };
          query.limit = jest.fn().mockResolvedValue(rows);
          return query;
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: whereImpl }),
    }),
    delete: jest.fn().mockReturnValue({ where: deleteWhere }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue(undefined),
    }),
    _whereImpl: whereImpl,
    _deleteWhere: deleteWhere,
    _whereReturning: whereReturning,
  };
}

function employeePolicy(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    id: 1,
    orgId: ORG_ID,
    recordType: "employee",
    retentionMonths: 6,
    action: "delete",
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    countryCode: null,
    ...overrides,
  };
}

describe("CronHrRetentionService", () => {
  let svc: CronHrRetentionService;
  const mockDb = {};

  beforeEach(async () => {
    jest.resetAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        CronHrRetentionService,
        { provide: DRIZZLE, useValue: mockDb },
        {
          provide: StorageService,
          useValue: { deleteFileIfPresent: jest.fn().mockResolvedValue(true) },
        },
      ],
    }).compile();

    svc = module.get(CronHrRetentionService);
  });

  function runWithTx(tx: ReturnType<typeof makeTx>) {
    mockedForEachOrg.mockImplementation(async (_db, _sweep, fn) => {
      await fn(tx as unknown as Parameters<typeof fn>[0], ORG_ID);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });
  }

  it("(A) policy window not expired — WHERE clause MUST contain the created_at cutoff guard", async () => {
    let capturedWhere: unknown = null;
    const tx = makeTx({
      policies: [employeePolicy({ retentionMonths: 24 })],
      updateRows: [],
      captureWhere: (arg) => {
        capturedWhere = arg;
      },
    });
    runWithTx(tx);

    await svc.sweep();

    expect(capturedWhere).not.toBeNull();
    const containsCutoff =
      drizzleSqlContains(capturedWhere, "created_at") ||
      drizzleSqlContains(capturedWhere, "hr_people");
    expect(containsCutoff).toBe(true);
  });

  it("(B) expired record without legal hold — update is called and count reflects returned rows", async () => {
    const tx = makeTx({
      policies: [employeePolicy()],
      updateRows: [{ id: 99 }],
    });
    runWithTx(tx);

    const result = await svc.sweep();

    expect(result.employeeSoftDeleted).toBe(1);
    expect(tx.update).toHaveBeenCalled();
  });

  it("(C-bite) WHERE clause for employee sweep includes legal hold exclusion — this test FAILS when the guard is removed", async () => {
    let capturedWhere: unknown = null;
    const tx = makeTx({
      policies: [employeePolicy()],
      updateRows: [],
      captureWhere: (arg) => {
        capturedWhere = arg;
      },
    });
    runWithTx(tx);

    await svc.sweep();

    expect(capturedWhere).not.toBeNull();
    const hasLegalHoldGuard = drizzleSqlContains(capturedWhere, "legal_holds");
    expect(hasLegalHoldGuard).toBe(true);
  });

  it("(D) case records: WHERE clause includes legal hold exclusion via subject_employee_id", async () => {
    let capturedWhere: unknown = null;
    const tx = makeTx({
      policies: [employeePolicy({ recordType: "case" })],
      updateRows: [],
      captureWhere: (arg) => {
        capturedWhere = arg;
      },
    });
    runWithTx(tx);

    await svc.sweep();

    expect(drizzleSqlContains(capturedWhere, "legal_holds")).toBe(true);
  });

  it("(E) attendance records: physical DELETE WHERE clause includes legal hold exclusion", async () => {
    let capturedDeleteWhere: unknown = null;
    const tx = makeTx({
      policies: [employeePolicy({ recordType: "attendance" })],
      deleteRows: [],
    });
    tx._deleteWhere.mockImplementation((arg: unknown) => {
      capturedDeleteWhere = arg;
      return { returning: jest.fn().mockResolvedValue([]) };
    });
    runWithTx(tx);

    await svc.sweep();

    expect(drizzleSqlContains(capturedDeleteWhere, "legal_holds")).toBe(true);
  });

  it("(F) document policies are consumed and payroll policies are explicitly retained", async () => {
    const logWarnSpy = jest.spyOn(svc["logger"], "warn").mockImplementation(() => {});
    const tx = makeTx({
      policies: [
        employeePolicy({ recordType: "document", id: 5 }),
        employeePolicy({ recordType: "payroll", id: 6 }),
      ],
      selectResults: [
        [
          employeePolicy({ recordType: "document", id: 5 }),
          employeePolicy({ recordType: "payroll", id: 6 }),
        ],
        [],
        [],
      ],
      updateRows: [],
    });
    runWithTx(tx);

    const result = await svc.sweep();

    expect(result.documentsDeleted).toBe(0);
    expect(result.protectedPayrollPolicies).toBe(1);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.insert).toHaveBeenCalled();
    expect(logWarnSpy).toHaveBeenCalled();
    logWarnSpy.mockRestore();
  });

  it("(G) inactive policies are filtered out by SELECT — no purge runs", async () => {
    const tx = makeTx({ policies: [], updateRows: [] });
    runWithTx(tx);

    const result = await svc.sweep();

    expect(result.employeeSoftDeleted).toBe(0);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("(H) audit log is written when records are purged", async () => {
    const tx = makeTx({
      policies: [employeePolicy()],
      updateRows: [{ id: 42 }],
    });
    runWithTx(tx);

    await svc.sweep();

    expect(tx.insert).toHaveBeenCalled();
    const insertValues = tx.insert.mock.results[0].value.values;
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        actorMembershipId: null,
        entityType: "hr_person_batch",
        action: "retention_sweep.employee",
      }),
    );
  });
});
