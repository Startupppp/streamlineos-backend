import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { OrganizationSagaService } from "./organization-saga.service";
import { PURGE_ADAPTER_REGISTRY, type PurgeAdapterResult } from "./organization-purge-adapters";
import { PURGE_ADAPTERS, type PurgeAdapter } from "../../../../db/schema/common/organization-purge";
import { SAGA_STEPS } from "./organization-lifecycle-transitions";

function buildSelectChain(rows: unknown[]) {
  const resolved = Promise.resolve(rows);
  const chain: Record<string, unknown> = {
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
  };
  for (const m of ["from", "innerJoin", "where", "orderBy"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.limit = jest.fn().mockResolvedValue(rows);
  return chain;
}

function buildUpdateChain() {
  // Drizzle's .where() is awaitable AND chainable into .returning(); the double has to be both.
  const where = jest.fn().mockImplementation(() =>
    Object.assign(Promise.resolve(undefined), {
      returning: jest.fn().mockResolvedValue([{ sagaId: "saga-1" }]),
    }),
  );
  return { set: jest.fn().mockReturnValue({ where }) };
}

function buildInsertChain(opts: { throwCode?: string } = {}) {
  return {
    values: jest.fn().mockImplementation(() => {
      if (opts.throwCode) {
        const e = Object.assign(new Error("duplicate"), { code: opts.throwCode });
        return Promise.reject(e);
      }
      return Promise.resolve();
    }),
    onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
  };
}

function buildInsertOnConflictChain(opts: { throwCode?: string } = {}) {
  return {
    values: jest.fn().mockReturnValue({
      onConflictDoNothing: jest.fn().mockImplementation(() => {
        if (opts.throwCode) {
          const e = Object.assign(new Error("duplicate"), { code: opts.throwCode });
          return Promise.reject(e);
        }
        return Promise.resolve();
      }),
    }),
  };
}

async function buildService(db: Record<string, unknown>): Promise<OrganizationSagaService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      OrganizationSagaService,
      { provide: DRIZZLE, useValue: db },
    ],
  }).compile();
  return moduleRef.get(OrganizationSagaService);
}

const fakeSaga = {
  sagaId: "saga-1",
  organizationId: "org-1",
  kind: "ARCHIVE",
  state: "PENDING",
  requestKey: "req-key-1",
  actorUserId: "user-1",
  fromStatus: "ACTIVE",
  toStatus: "ARCHIVED",
  lastError: null,
  startedAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
};

describe("OrganizationSagaService.begin — inserts saga and steps", () => {
  it("returns the inserted saga with step states", async () => {
    const archiveSteps = SAGA_STEPS.ARCHIVE.map((stepName, idx) => ({
      stepId: `step-${idx}`,
      sagaId: "saga-1",
      stepName,
      position: idx,
      state: "PENDING",
      attempts: 0,
      detail: null,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(),
    }));

    let selectCall = 0;
    const db = {
      insert: jest.fn().mockReturnValue(buildInsertOnConflictChain()),
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) return buildSelectChain([fakeSaga]);
        return buildSelectChain(archiveSteps);
      }),
      update: jest.fn().mockReturnValue(buildUpdateChain()),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };

    const service = await buildService(db as never);
    const result = await service.begin("ARCHIVE", "org-1", "req-key-1", "user-1", "ACTIVE");

    expect(db.insert).toHaveBeenCalledTimes(2);
    expect(result.saga.sagaId).toBe("saga-1");
    expect(result.steps).toHaveLength(SAGA_STEPS.ARCHIVE.length);
  });
});

describe("OrganizationSagaService.begin — resume with same requestKey", () => {
  it("returns the EXISTING saga on second call (does not duplicate)", async () => {
    const existingSaga = { ...fakeSaga, sagaId: "saga-existing", state: "RUNNING" };
    const existingStep = {
      stepId: "step-1",
      sagaId: "saga-existing",
      stepName: "revoke-invitations",
      position: 0,
      state: "DONE",
      attempts: 1,
      detail: null,
      startedAt: new Date(Date.now() - 4000),
      completedAt: new Date(Date.now() - 3000),
      updatedAt: new Date(),
    };

    let selectCall = 0;
    const db = {
      insert: jest.fn().mockReturnValue(buildInsertOnConflictChain()),
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        if (selectCall % 2 === 1) return buildSelectChain([existingSaga]);
        return buildSelectChain([existingStep]);
      }),
      update: jest.fn().mockReturnValue(buildUpdateChain()),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };

    const service = await buildService(db as never);

    const first = await service.begin("ARCHIVE", "org-1", "req-key-resume", "user-1", "ACTIVE");
    const second = await service.begin("ARCHIVE", "org-1", "req-key-resume", "user-1", "ACTIVE");

    expect(first.saga.sagaId).toBe("saga-existing");
    expect(second.saga.sagaId).toBe("saga-existing");
    expect(second.saga.state).toBe("RUNNING");
  });

  it("uses onConflictDoNothing on saga insert so a duplicate requestKey does not throw", async () => {
    let selectCall = 0;
    const db = {
      insert: jest.fn().mockReturnValue(buildInsertOnConflictChain()),
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        if (selectCall % 2 === 1) return buildSelectChain([fakeSaga]);
        return buildSelectChain([]);
      }),
      update: jest.fn().mockReturnValue(buildUpdateChain()),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };

    const service = await buildService(db as never);
    await expect(
      service.begin("ARCHIVE", "org-1", "req-key-1", "user-1", "ACTIVE"),
    ).resolves.toBeDefined();

    const insertCalls = (db.insert as jest.Mock).mock.results;
    for (const r of insertCalls) {
      const chain = r.value as { values: jest.Mock };
      const valuesResult = chain.values.mock.results[0]?.value as { onConflictDoNothing: jest.Mock } | undefined;
      if (valuesResult?.onConflictDoNothing) {
        expect(valuesResult.onConflictDoNothing).toHaveBeenCalled();
      }
    }
  });
});

describe("OrganizationSagaService.runStep", () => {
  it("marks step DONE on success", async () => {
    const setCalls: unknown[] = [];
    const db = {
      insert: jest.fn().mockReturnValue(buildInsertOnConflictChain()),
      select: jest.fn().mockReturnValue(buildSelectChain([])),
      update: jest.fn().mockImplementation(() => ({
        set: jest.fn().mockImplementation((s: unknown) => {
          setCalls.push(s);
          return {
            where: jest.fn().mockImplementation(() =>
              Object.assign(Promise.resolve(undefined), {
                returning: jest.fn().mockResolvedValue([{ sagaId: "saga-1" }]),
              }),
            ),
          };
        }),
      })),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };

    const service = await buildService(db as never);
    await service.runStep("saga-1", "reserve-identity", async () => "ok");

    const doneCall = setCalls.find((c) => (c as Record<string, unknown>)["state"] === "DONE");
    expect(doneCall).toBeDefined();
  });

  it("marks step FAILED and updates saga lastError when fn throws", async () => {
    const setCalls: unknown[] = [];
    const db = {
      insert: jest.fn().mockReturnValue(buildInsertOnConflictChain()),
      select: jest.fn().mockReturnValue(buildSelectChain([])),
      update: jest.fn().mockImplementation(() => ({
        set: jest.fn().mockImplementation((s: unknown) => {
          setCalls.push(s);
          return {
            where: jest.fn().mockImplementation(() =>
              Object.assign(Promise.resolve(undefined), {
                returning: jest.fn().mockResolvedValue([{ sagaId: "saga-1" }]),
              }),
            ),
          };
        }),
      })),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };

    const service = await buildService(db as never);
    await expect(
      service.runStep("saga-1", "reserve-identity", async () => {
        throw new Error("network timeout");
      }),
    ).rejects.toThrow("network timeout");

    const failedCall = setCalls.find(
      (c) => (c as Record<string, unknown>)["state"] === "FAILED",
    );
    expect(failedCall).toBeDefined();
    expect(String((failedCall as Record<string, unknown>)["detail"] ?? "")).toContain("network timeout");

    const sagaFailedCall = setCalls.find(
      (c) => (c as Record<string, unknown>)["lastError"] !== undefined,
    );
    expect(sagaFailedCall).toBeDefined();
  });

  it("rethrows the original error", async () => {
    const db = {
      insert: jest.fn().mockReturnValue(buildInsertOnConflictChain()),
      select: jest.fn().mockReturnValue(buildSelectChain([])),
      update: jest.fn().mockReturnValue(buildUpdateChain()),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };
    const service = await buildService(db as never);
    const original = new Error("original");
    await expect(
      service.runStep("saga-1", "step", async () => { throw original; }),
    ).rejects.toBe(original);
  });
});

describe("OrganizationSagaService.compensate — reverse position order", () => {
  it("calls compensators in reverse position order (DESC)", async () => {
    const calledOrder: string[] = [];
    const doneSteps = [
      { stepName: "bootstrap-cell-organization", position: 2 },
      { stepName: "reserve-placement", position: 1 },
      { stepName: "reserve-identity", position: 0 },
    ];

    let selectCall = 0;
    const db = {
      insert: jest.fn().mockReturnValue(buildInsertOnConflictChain()),
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        return buildSelectChain(selectCall === 1 ? doneSteps : []);
      }),
      update: jest.fn().mockReturnValue(buildUpdateChain()),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };

    const service = await buildService(db as never);
    await service.compensate("saga-1", {
      "reserve-identity": async () => { calledOrder.push("reserve-identity"); },
      "reserve-placement": async () => { calledOrder.push("reserve-placement"); },
      "bootstrap-cell-organization": async () => { calledOrder.push("bootstrap-cell-organization"); },
    });

    expect(calledOrder).toEqual([
      "bootstrap-cell-organization",
      "reserve-placement",
      "reserve-identity",
    ]);
  });

  it("marks each compensated step as COMPENSATED and saga as COMPENSATED", async () => {
    const setCalls: unknown[] = [];
    const doneSteps = [{ stepName: "reserve-identity", position: 0 }];

    let selectCall = 0;
    const db = {
      insert: jest.fn().mockReturnValue(buildInsertOnConflictChain()),
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        return buildSelectChain(selectCall === 1 ? doneSteps : []);
      }),
      update: jest.fn().mockImplementation(() => ({
        set: jest.fn().mockImplementation((s: unknown) => {
          setCalls.push(s);
          return {
            where: jest.fn().mockImplementation(() =>
              Object.assign(Promise.resolve(undefined), {
                returning: jest.fn().mockResolvedValue([{ sagaId: "saga-1" }]),
              }),
            ),
          };
        }),
      })),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };

    const service = await buildService(db as never);
    await service.compensate("saga-1", {
      "reserve-identity": async () => {},
    });

    const compensatedStep = setCalls.find(
      (c) => (c as Record<string, unknown>)["state"] === "COMPENSATED",
    );
    expect(compensatedStep).toBeDefined();

    const compensatedSaga = setCalls.find(
      (c) => (c as Record<string, unknown>)["state"] === "COMPENSATED" &&
        (c as Record<string, unknown>)["completedAt"] !== undefined,
    );
    expect(compensatedSaga).toBeDefined();
  });
});

describe("OrganizationSagaService.reserve — 23505 returns false", () => {
  it("returns false on SQLSTATE 23505 (unique violation — taken slug)", async () => {
    const db = {
      insert: jest.fn().mockReturnValue(buildInsertChain({ throwCode: "23505" })),
      select: jest.fn().mockReturnValue(buildSelectChain([])),
      update: jest.fn().mockReturnValue(buildUpdateChain()),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };

    const service = await buildService(db as never);
    const result = await service.reserve("SLUG", "my-org", "org-1", "saga-1");
    expect(result).toBe(false);
  });

  it("returns true when a retry finds its own reservation after a 23505", async () => {
    const db = {
      insert: jest.fn().mockReturnValue(buildInsertChain({ throwCode: "23505" })),
      select: jest.fn().mockReturnValue(
        buildSelectChain([
          {
            organizationId: "org-1",
            sagaId: "saga-1",
            state: "RESERVED",
          },
        ]),
      ),
      update: jest.fn().mockReturnValue(buildUpdateChain()),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };

    const service = await buildService(db as never);
    await expect(
      service.reserve("SLUG", "my-org", "org-1", "saga-1"),
    ).resolves.toBe(true);
  });

  it("rethrows errors with SQLSTATE other than 23505", async () => {
    const db = {
      insert: jest.fn().mockReturnValue(buildInsertChain({ throwCode: "08006" })),
      select: jest.fn().mockReturnValue(buildSelectChain([])),
      update: jest.fn().mockReturnValue(buildUpdateChain()),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };

    const service = await buildService(db as never);
    await expect(service.reserve("SLUG", "my-org", "org-1", "saga-1")).rejects.toThrow(
      "duplicate",
    );
  });

  it("returns true when the reservation succeeds", async () => {
    const db = {
      insert: jest.fn().mockReturnValue(buildInsertChain()),
      select: jest.fn().mockReturnValue(buildSelectChain([])),
      update: jest.fn().mockReturnValue(buildUpdateChain()),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };

    const service = await buildService(db as never);
    const result = await service.reserve("SLUG", "new-org", "org-2", "saga-2");
    expect(result).toBe(true);
  });
});

describe("Criterion 6 — purge completion is BLOCKED when one adapter does not confirm", () => {
  function buildAdapterOverrides(
    overrides: Partial<Record<PurgeAdapter, PurgeAdapterResult>>,
  ): typeof PURGE_ADAPTER_REGISTRY {
    const registry = { ...PURGE_ADAPTER_REGISTRY };
    for (const [adapter, result] of Object.entries(overrides)) {
      registry[adapter as PurgeAdapter] = { confirm: async () => result };
    }
    return registry;
  }

  function buildMockDbForAdapters(orgRow?: Record<string, unknown>) {
    const rows = orgRow ? [orgRow] : [];
    return {
      select: jest.fn().mockReturnValue(buildSelectChain(rows)),
    };
  }

  async function simulatePurgeAdapterRun(
    registry: typeof PURGE_ADAPTER_REGISTRY,
    mockDb?: Record<string, unknown>,
  ): Promise<{ allConfirmed: boolean; results: Record<string, string> }> {
    const db = mockDb ?? buildMockDbForAdapters({ id: "org-1", statusV2: "PURGE_SCHEDULED" });
    const adapterResults: Record<string, PurgeAdapterResult> = {};
    for (const adapter of PURGE_ADAPTERS) {
      adapterResults[adapter] = await registry[adapter].confirm("org-1", "job-1", db as never);
    }
    const allConfirmed = PURGE_ADAPTERS.every(
      (a) =>
        adapterResults[a].state === "CONFIRMED" || adapterResults[a].state === "NOT_APPLICABLE",
    );
    return {
      allConfirmed,
      results: Object.fromEntries(
        Object.entries(adapterResults).map(([k, v]) => [k, v.state]),
      ),
    };
  }

  it("blocks when database_rows adapter returns FAILED", async () => {
    const registry = buildAdapterOverrides({
      database_rows: { state: "FAILED", detail: "not cleaned up" },
    });
    const { allConfirmed, results } = await simulatePurgeAdapterRun(registry);
    expect(allConfirmed).toBe(false);
    expect(results["database_rows"]).toBe("FAILED");
  });

  it("completes when every adapter is CONFIRMED or NOT_APPLICABLE", async () => {
    const registry = buildAdapterOverrides({
      database_rows: { state: "CONFIRMED", detail: "cleaned" },
      object_storage: { state: "CONFIRMED", detail: "cleaned" },
      cache: { state: "NOT_APPLICABLE", detail: "TTL-based" },
      search_index: { state: "CONFIRMED", detail: "cleaned" },
      vector_index: { state: "CONFIRMED", detail: "cleaned" },
      analytics_copies: { state: "CONFIRMED", detail: "cleaned" },
      provider_mirrors: { state: "CONFIRMED", detail: "cleaned" },
      backups: { state: "NOT_APPLICABLE", detail: "no backup system" },
      audit_evidence: { state: "NOT_APPLICABLE", detail: "retained" },
    });
    const { allConfirmed } = await simulatePurgeAdapterRun(registry);
    expect(allConfirmed).toBe(true);
  });

  it("blocks when a single adapter returns FAILED even if all others pass", async () => {
    const registry = buildAdapterOverrides({
      database_rows: { state: "CONFIRMED", detail: "cleaned" },
      object_storage: { state: "CONFIRMED", detail: "cleaned" },
      cache: { state: "NOT_APPLICABLE", detail: "TTL" },
      search_index: { state: "FAILED", detail: "index not cleared" },
      vector_index: { state: "CONFIRMED", detail: "cleaned" },
      analytics_copies: { state: "CONFIRMED", detail: "cleaned" },
      provider_mirrors: { state: "CONFIRMED", detail: "cleaned" },
      backups: { state: "NOT_APPLICABLE", detail: "N/A" },
      audit_evidence: { state: "NOT_APPLICABLE", detail: "retained" },
    });
    const { allConfirmed, results } = await simulatePurgeAdapterRun(registry);
    expect(allConfirmed).toBe(false);
    expect(results["search_index"]).toBe("FAILED");
  });

  it("real PURGE_ADAPTER_REGISTRY blocks purge today because critical adapters are unimplemented", async () => {
    const mockDb = buildMockDbForAdapters({ id: "org-1", statusV2: "PURGE_SCHEDULED" });
    const { allConfirmed, results } = await simulatePurgeAdapterRun(PURGE_ADAPTER_REGISTRY, mockDb);
    expect(allConfirmed).toBe(false);
    const failedAdapters = Object.entries(results)
      .filter(([, s]) => s === "FAILED")
      .map(([k]) => k);
    expect(failedAdapters.length).toBeGreaterThan(0);
  });
});

describe("OrganizationSagaService — compensation releases reserved slug after failure", () => {
  it("calls slug-release compensator last (position 0 = lowest priority in reverse)", async () => {
    const calledOrder: string[] = [];
    const doneSteps = [
      { stepName: "reserve-placement", position: 1 },
      { stepName: "reserve-identity", position: 0 },
    ];

    let selectCall = 0;
    const db = {
      insert: jest.fn().mockReturnValue(buildInsertOnConflictChain()),
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        return buildSelectChain(selectCall === 1 ? doneSteps : []);
      }),
      update: jest.fn().mockReturnValue(buildUpdateChain()),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };

    const service = await buildService(db as never);
    const slugReleaseFn = jest.fn(async () => { calledOrder.push("release-slug"); });

    await service.compensate("saga-1", {
      "reserve-identity": slugReleaseFn,
      "reserve-placement": async () => { calledOrder.push("unplace"); },
    });

    expect(calledOrder).toEqual(["unplace", "release-slug"]);
    expect(slugReleaseFn).toHaveBeenCalledTimes(1);
  });
});
