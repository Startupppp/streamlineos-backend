import { createHash } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { jobVisibilityPredicate } from "../audit-export-job";
import type { AuditExportWindow } from "../audit-export-rows";

const mockStore: Record<string, (string | null)[][]> = { ledger: [], audit_events: [] };
const mockWindows: AuditExportWindow[] = [];
const mockPin = { pinnedXmax: "9001", ledgerCeilingId: 12, auditCeilingId: 7 };

jest.mock("../audit-export-rows", () => ({
  ...jest.requireActual("../audit-export-rows"),
  pinEvidence: jest.fn(() => Promise.resolve(mockPin)),
  isEvidenceSettled: jest.fn(() => Promise.resolve(true)),
  countSection: jest.fn((_db: unknown, section: string) =>
    Promise.resolve((mockStore[section] ?? []).length),
  ),
  readSection: jest.fn(async function* (
    _db: unknown,
    section: string,
    window: AuditExportWindow,
  ) {
    mockWindows.push(window);
    for (const row of mockStore[section] ?? []) yield row;
  }),
}));

import { AuditExportService } from "../audit-export.service";

const LEDGER_ROW = (id: string, qty: string): (string | null)[] => [
  id, "org_1", "40", "7", "RECEIPT", "ON_HAND",
  qty, "0.0000", qty, null, null,
  "12.5000", "62.5000", "2026-01-04", `idem-${id}`, "purchase_order", "88",
  null, "user_1", "2026-01-04 09:15:00.123456",
];

interface JobLike extends Record<string, unknown> {
  id: number;
  status: string;
}

function buildDb(state: { jobs: JobLike[] }) {
  return {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => {
          const row: JobLike = {
            ledgerRowCount: null,
            auditRowCount: null,
            checksum: null,
            byteLength: null,
            settledAt: null,
            failureReason: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
            ...values,
            id: state.jobs.length + 1,
            status: String(values["status"]),
          };
          state.jobs.push(row);
          return Promise.resolve([row]);
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(state.jobs.slice(0, 1)),
          orderBy: () => ({
            limit: () => ({ offset: () => Promise.resolve(state.jobs.slice(0, 1)) }),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          const job = state.jobs[0];
          if (job) Object.assign(job, patch);
          return Promise.resolve([]);
        },
      }),
    }),
  };
}

const cache = {
  invalidateNamespace: jest.fn(() => Promise.resolve()),
  cachedVersioned: jest.fn((_ns: string, _key: string, fn: () => Promise<unknown>) => fn()),
};

function captureResponse() {
  const chunks: Buffer[] = [];
  return {
    chunks,
    res: {
      setHeader: jest.fn(),
      write: (chunk: Buffer) => {
        chunks.push(chunk);
        return true;
      },
      end: jest.fn(),
      once: jest.fn(),
    },
  };
}

function build(scope: number[] | null) {
  const state = { jobs: [] as JobLike[] };
  const warehouseScope = new WarehouseScopeService({} as never, {} as never);
  jest.spyOn(warehouseScope, "resolve").mockResolvedValue(scope);
  const service = new AuditExportService(buildDb(state) as never, cache as never, warehouseScope);
  return { service, state, warehouseScope };
}

describe("AuditExportService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWindows.length = 0;
    mockStore["ledger"] = [LEDGER_ROW("1", "5.0000"), LEDGER_ROW("2", "7.2500")];
    mockStore["audit_events"] = [
      ["1", "org_1", "user_1", "settings.update", "inv_settings", "1", null, null, null, "2026-01-06 08:00:00.000000"],
    ];
  });

  it("completes the job with a checksum over the document it will hand out", async () => {
    const { service, state } = build(null);

    const created = await service.createJob("org_1", "user_1", {});

    const job = state.jobs[0];
    expect(created.evidenceVersion).toBe("L12.A7");
    expect(job?.status).toBe("COMPLETED");
    expect(job?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(job?.ledgerRowCount).toBe(2);
    expect(job?.auditRowCount).toBe(1);
  });

  it("hands out the same bytes twice for the same evidence version", async () => {
    const { service, state } = build(null);
    await service.createJob("org_1", "user_1", {});
    const checksum = String(state.jobs[0]?.checksum);

    const first = captureResponse();
    await service.download("org_1", "user_1", 1, first.res as never);
    const second = captureResponse();
    await service.download("org_1", "user_1", 1, second.res as never);

    const firstBytes = Buffer.concat(first.chunks);
    const secondBytes = Buffer.concat(second.chunks);

    expect(firstBytes.equals(secondBytes)).toBe(true);
    expect(createHash("sha256").update(firstBytes).digest("hex")).toBe(checksum);
    expect(first.res.setHeader).toHaveBeenCalledWith("X-Audit-Export-Checksum", `sha-256=${checksum}`);
  });

  it("verifies a completed export against the evidence still in the database", async () => {
    const { service } = build(null);
    await service.createJob("org_1", "user_1", {});

    const verification = await service.verify("org_1", "user_1", 1);

    expect(verification.match).toBe(true);
    expect(verification.actualChecksum).toBe(verification.expectedChecksum);
  });

  it("fails verification once one exported row no longer renders the same", async () => {
    const { service } = build(null);
    await service.createJob("org_1", "user_1", {});

    mockStore["ledger"] = [LEDGER_ROW("1", "6.0000"), LEDGER_ROW("2", "7.2500")];
    const verification = await service.verify("org_1", "user_1", 1);

    expect(verification.match).toBe(false);
    expect(verification.actualChecksum).not.toBe(verification.expectedChecksum);
  });

  it("omits the audit trail for a warehouse-scoped caller, because it is not warehouse-attributable", async () => {
    const { service, state } = build([9, 3]);

    const created = await service.createJob("org_1", "user_1", {});

    expect(created.sections).toEqual(["ledger"]);
    expect(created.evidenceVersion).toBe("L12");
    expect(state.jobs[0]?.scopeWarehouseIds).toEqual([3, 9]);
    expect(state.jobs[0]?.auditCeilingId).toBe(0);
  });

  it("filters the ledger read to the job's recorded warehouses, in a stable order", async () => {
    const { service } = build([9, 3]);
    await service.createJob("org_1", "user_1", {});

    const window = mockWindows[0];
    expect(window).toBeDefined();
    const compiled = new PgDialect().sqlToQuery(window!.locationScope);

    expect(compiled.sql).toContain("inv_locations");
    expect(compiled.params).toEqual([3, 9]);
  });

  it("refuses a job whose warehouses the caller does not hold, as a 404", async () => {
    const { service, warehouseScope } = build([3, 9]);
    await service.createJob("org_1", "user_1", {});

    jest.spyOn(warehouseScope, "resolve").mockResolvedValue([3]);

    await expect(service.findOne("org_1", "user_2", 1)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.verify("org_1", "user_2", 1)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses an org-wide job to a warehouse-scoped caller", async () => {
    const { service, warehouseScope } = build(null);
    await service.createJob("org_1", "user_1", {});

    jest.spyOn(warehouseScope, "resolve").mockResolvedValue([3, 9]);

    await expect(service.findOne("org_1", "user_2", 1)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("jobVisibilityPredicate", () => {
  const dialect = new PgDialect();

  it("lets an org-wide caller see every job", () => {
    expect(dialect.sqlToQuery(jobVisibilityPredicate(null)).sql.trim()).toBe("TRUE");
  });

  it("shows a caller with no warehouse nothing", () => {
    expect(dialect.sqlToQuery(jobVisibilityPredicate([])).sql.trim()).toBe("FALSE");
  });

  it("restricts a scoped caller to jobs contained by their own warehouses", () => {
    const compiled = dialect.sqlToQuery(jobVisibilityPredicate([3, 9]));

    expect(compiled.sql).toContain("scope_warehouse_ids");
    expect(compiled.sql).toContain("IS NOT NULL");
    expect(compiled.sql).toContain("<@");
    expect(compiled.params).toEqual(["[3,9]"]);
  });
});
