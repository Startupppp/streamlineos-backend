import { ConflictException } from "@nestjs/common";
import { GenerateService } from "../generate.service";
import { DEFAULT_PAYROLL_TOGGLES } from "../../payroll.types";
import type { GenerateRunCommand } from "../run-types";

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: "org-a",
    month: "2026-07",
    status: "PREVIEW_READY",
    policyVersionId: 1,
    statutoryRuleVersion: "IN-2026",
    ...overrides,
  };
}

function makeDb(row: unknown) {
  const builder = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn(),
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(row ? [row] : []).then(resolve),
  };
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  return { select: jest.fn().mockReturnValue(builder) };
}

function makeServices(overrides: {
  dataLoader?: Partial<ReturnType<typeof defaultDataLoader>>;
  persister?: Partial<{ persistRunResults: jest.Mock }>;
  runLocks?: Partial<ReturnType<typeof defaultRunLocks>>;
} = {}) {
  const pipeline = {
    buildInputsFromBatch: jest.fn().mockReturnValue({
      source: "MANUAL",
      scheduledDays: "31",
      paidDays: "31",
      lopDays: "0",
      halfDays: "0",
      overtimeHours: "0",
      shiftAllowanceUnits: "0",
      holidayWorkDays: "0",
      billableHours: "0",
      isOverride: false,
      overrideReason: null,
    }),
    buildCalcInputsFromBatch: jest.fn().mockReturnValue({
      approvedBonuses: [],
      approvedIncentives: [],
      approvedReimbursements: [],
      consumedReimbursementIds: [],
      consumedIncentiveIds: [],
      consumedBonusIds: [],
      activeLoans: [],
      taxDeclaration: null,
    }),
    runCalcAndDetect: jest.fn().mockReturnValue({
      snapshot: {
        totals: { gross: "0", deductions: "0", employerContributions: "0", net: "0" },
        lines: [],
        variance: null,
        fxRate: null,
        netPayoutCurrency: null,
      },
      exceptions: [],
    }),
  };

  const batchLoader = {
    loadRunBatchData: jest.fn().mockResolvedValue({
      lockedPeriodId: null,
      lockedSectionsByUser: new Map(),
      runInputsByUser: new Map(),
      liveAttendanceByUser: new Map(),
      componentsByProfileId: new Map(),
      bonusesByUser: new Map(),
      incentivesByUser: new Map(),
      reimbursementsByUser: new Map(),
      expensesByUser: new Map(),
      loansByUser: new Map(),
      taxDeclarationByUser: new Map(),
    }),
  };

  const notifications = {
    notifyExceptions: jest.fn().mockResolvedValue(undefined),
  };

  const runLocks = { ...defaultRunLocks(), ...overrides.runLocks };
  const efService = { getSensitiveFactsBatch: jest.fn().mockResolvedValue(new Map()) };
  const calculationGuards = {
    findDuplicateBankAccounts: jest.fn().mockReturnValue([]),
    loadStatutoryIdFlags: jest.fn().mockReturnValue(new Map()),
  };
  const dataLoader = { ...defaultDataLoader(), ...overrides.dataLoader };
  const persister = {
    persistRunResults: jest.fn().mockResolvedValue({ finalExceptionCount: 0 }),
    ...overrides.persister,
  };
  const loanRecovery = { postPayrollLock: jest.fn().mockResolvedValue(undefined) };

  return { pipeline, batchLoader, notifications, runLocks, efService, calculationGuards, dataLoader, persister, loanRecovery };
}

function defaultRunLocks() {
  return {
    acquire: jest.fn().mockResolvedValue("token-abc"),
    release: jest.fn().mockResolvedValue(undefined),
    assertNoOtherActiveGeneration: jest.fn().mockResolvedValue(undefined),
  };
}

function defaultDataLoader() {
  return {
    loadPolicy: jest.fn().mockResolvedValue({
      toggles: { ...DEFAULT_PAYROLL_TOGGLES, lopFromAttendance: false },
      config: {},
      policyVersionId: 1,
    }),
    loadEligibleProfiles: jest.fn().mockResolvedValue([]),
    loadHeldUserIds: jest.fn().mockResolvedValue(new Set()),
    getLockedInputPeriodId: jest.fn().mockResolvedValue(null),
    loadStatutoryStateCode: jest.fn().mockResolvedValue(null),
    clearPreviouslyConsumedReimbursements: jest.fn().mockResolvedValue(undefined),
    clearRunAllocations: jest.fn().mockResolvedValue(undefined),
    loadPreviousSnapshots: jest.fn().mockResolvedValue(new Map()),
  };
}

function buildService(
  db: ReturnType<typeof makeDb>,
  services: ReturnType<typeof makeServices>,
) {
  const { pipeline, batchLoader, notifications, runLocks, efService, calculationGuards, dataLoader, persister, loanRecovery } = services;
  return new GenerateService(
    db as never,
    pipeline as never,
    batchLoader as never,
    notifications as never,
    runLocks as never,
    efService as never,
    calculationGuards as never,
    dataLoader as never,
    persister as never,
    loanRecovery as never,
  );
}

describe("GenerateService — cross-tenant isolation", () => {
  it("returns not_found when the DB query (WHERE org_id AND run_id) returns no rows", async () => {
    const db = makeDb(null);
    const services = makeServices();
    const svc = buildService(db, services);

    const cmd: GenerateRunCommand = { orgId: "org-attacker", runId: 1, actorId: "u1", isRecalc: false };
    const result = await svc.generateRun(cmd);

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(services.runLocks.acquire).not.toHaveBeenCalled();
    expect(services.persister.persistRunResults).not.toHaveBeenCalled();
  });
});

describe("GenerateService — idempotency guards", () => {
  const LOCKED_STATUSES = ["LOCKED", "PAID", "PAYSLIPS_PUBLISHED", "CLOSED"];

  for (const status of LOCKED_STATUSES) {
    it(`returns locked without touching the lock service for status=${status}`, async () => {
      const db = makeDb(makeRun({ status }));
      const services = makeServices();
      const svc = buildService(db, services);

      const cmd: GenerateRunCommand = { orgId: "org-a", runId: 1, actorId: "u1", isRecalc: false };
      const result = await svc.generateRun(cmd);

      expect(result).toEqual({ ok: false, reason: "locked" });
      expect(services.runLocks.acquire).not.toHaveBeenCalled();
      expect(services.persister.persistRunResults).not.toHaveBeenCalled();
    });
  }

  it("returns generation_in_progress when lock acquire throws ConflictException", async () => {
    const db = makeDb(makeRun());
    const services = makeServices({
      runLocks: { acquire: jest.fn().mockRejectedValue(new ConflictException("in progress")) },
    });
    const svc = buildService(db, services);

    const cmd: GenerateRunCommand = { orgId: "org-a", runId: 1, actorId: "u1", isRecalc: false };
    const result = await svc.generateRun(cmd);

    expect(result).toEqual({ ok: false, reason: "generation_in_progress" });
    expect(services.persister.persistRunResults).not.toHaveBeenCalled();
  });

  it("returns no_policy and skips persistence when no active policy exists", async () => {
    const db = makeDb(makeRun());
    const services = makeServices({
      dataLoader: { loadPolicy: jest.fn().mockResolvedValue(null) },
    });
    const svc = buildService(db, services);

    const cmd: GenerateRunCommand = { orgId: "org-a", runId: 1, actorId: "u1", isRecalc: false };
    const result = await svc.generateRun(cmd);

    expect(result).toEqual({ ok: false, reason: "no_policy" });
    expect(services.persister.persistRunResults).not.toHaveBeenCalled();
  });
});

describe("GenerateService — lock lifecycle (rollback safety)", () => {
  it("always releases the lock after a successful generation", async () => {
    const db = makeDb(makeRun());
    const services = makeServices();
    const svc = buildService(db, services);

    await svc.generateRun({ orgId: "org-a", runId: 1, actorId: "u1", isRecalc: false });

    expect(services.runLocks.acquire).toHaveBeenCalledWith("org-a", 1);
    expect(services.runLocks.release).toHaveBeenCalledWith("org-a", 1, "token-abc");
  });

  it("releases the lock even when persister throws — DB rolls back", async () => {
    const db = makeDb(makeRun());
    const services = makeServices({
      persister: { persistRunResults: jest.fn().mockRejectedValue(new Error("DB error")) },
    });
    const svc = buildService(db, services);

    await expect(
      svc.generateRun({ orgId: "org-a", runId: 1, actorId: "u1", isRecalc: false }),
    ).rejects.toThrow("DB error");

    expect(services.runLocks.release).toHaveBeenCalledWith("org-a", 1, "token-abc");
  });

  it("releases the lock even when data loading throws", async () => {
    const db = makeDb(makeRun());
    const services = makeServices({
      dataLoader: {
        loadPolicy: jest.fn().mockResolvedValue({
          toggles: { ...DEFAULT_PAYROLL_TOGGLES },
          config: {},
          policyVersionId: 1,
        }),
        loadEligibleProfiles: jest.fn().mockRejectedValue(new Error("DB timeout")),
        loadHeldUserIds: jest.fn().mockResolvedValue(new Set()),
        getLockedInputPeriodId: jest.fn().mockResolvedValue(null),
        loadStatutoryStateCode: jest.fn().mockResolvedValue(null),
        clearPreviouslyConsumedReimbursements: jest.fn().mockResolvedValue(undefined),
        clearRunAllocations: jest.fn().mockResolvedValue(undefined),
        loadPreviousSnapshots: jest.fn().mockResolvedValue(new Map()),
      },
    });
    const svc = buildService(db, services);

    await expect(
      svc.generateRun({ orgId: "org-a", runId: 1, actorId: "u1", isRecalc: false }),
    ).rejects.toThrow("DB timeout");

    expect(services.runLocks.release).toHaveBeenCalledWith("org-a", 1, "token-abc");
  });
});

describe("GenerateService — recalculation idempotency", () => {
  it("clears previous allocations and reimbursements before recalculating", async () => {
    const db = makeDb(makeRun());
    const services = makeServices();
    const svc = buildService(db, services);

    await svc.generateRun({ orgId: "org-a", runId: 1, actorId: "u1", isRecalc: true });

    expect(services.dataLoader.clearPreviouslyConsumedReimbursements).toHaveBeenCalledWith("org-a", 1);
    expect(services.dataLoader.clearRunAllocations).toHaveBeenCalledWith("org-a", 1);
  });

  it("does NOT clear allocations on initial generation (non-recalc)", async () => {
    const db = makeDb(makeRun());
    const services = makeServices();
    const svc = buildService(db, services);

    await svc.generateRun({ orgId: "org-a", runId: 1, actorId: "u1", isRecalc: false });

    expect(services.dataLoader.clearPreviouslyConsumedReimbursements).not.toHaveBeenCalled();
    expect(services.dataLoader.clearRunAllocations).not.toHaveBeenCalled();
  });

  it("persister called with isRecalc=true so the event is recorded as RECALCULATED", async () => {
    const db = makeDb(makeRun());
    const services = makeServices();
    const svc = buildService(db, services);

    await svc.generateRun({ orgId: "org-a", runId: 1, actorId: "u1", isRecalc: true });

    const callArgs = services.persister.persistRunResults.mock.calls[0]?.[0] as { isRecalc: boolean };
    expect(callArgs?.isRecalc).toBe(true);
  });
});
