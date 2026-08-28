process.env.APP_URL ??= "http://localhost:1000";

import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { createE2eApp } from "test/helpers/e2e-app";
import { AccessService } from "../../access/access.service";
import { EntitlementsService } from "../../access/entitlements.service";
import { JournalOutboxService } from "./journal-outbox.service";
import { withAccessResolution } from "../../../../test/helpers/access-stub";

const mockBatch = {
  id: 1,
  periodKey: "2025-07",
  version: 1,
  status: "POSTED",
  reconciliationStatus: "UNRECONCILED",
  reversalOfBatchId: null,
  provisional: false,
  totalDebits: "1000.00",
  totalCredits: "1000.00",
  lineCount: 1,
  unmappedCodes: [],
  runId: 5,
  note: null,
  reversalReason: null,
  reconciliationNote: null,
  postedAt: null,
  exportedAt: null,
  reversedAt: null,
  reconciledAt: null,
  createdAt: new Date().toISOString(),
  lines: [
    { lineNo: 1, account: "Salary Expense", description: "Basic", debit: "1000.00", credit: "0.00", costCenter: null },
  ],
};

const mockOutbox = {
  list: jest.fn().mockResolvedValue({ data: [mockBatch], total: 1, page: 1, limit: 25 }),
  get: jest.fn().mockResolvedValue(mockBatch),
  createBatch: jest.fn().mockResolvedValue(mockBatch),
  markPosted: jest.fn().mockResolvedValue(mockBatch),
  markExported: jest.fn().mockResolvedValue(mockBatch),
  reverseBatch: jest.fn().mockResolvedValue({ ...mockBatch, id: 2, reversalOfBatchId: 1 }),
  reconcile: jest.fn().mockResolvedValue({ ...mockBatch, reconciliationStatus: "RECONCILED" }),
};

const alwaysOnEntitlements = {
  isModuleEnabled: async (): Promise<boolean> => true,
  moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
  getModuleMap: async (): Promise<Record<string, boolean>> => ({}),
  getEffectiveModuleMap: async (): Promise<Record<string, boolean>> => ({}),
};

const access = (perms: [string, string][]) =>
  withAccessResolution({
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map(perms)),
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
  });

const fullAccess = access([
  ["payroll:accounting:view", "all"],
  ["payroll:accounting:manage", "all"],
  ["payroll:reports:export", "all"],
]);
const viewOnlyAccess = access([["payroll:accounting:view", "all"]]);
const noAccess = access([]);

type Method = "get" | "post";

const READ_ROUTES: ReadonlyArray<[Method, string]> = [
  ["get", "/payroll/accounting/journal-batches"],
  ["get", "/payroll/accounting/journal-batches/1"],
];

const WRITE_ROUTES: ReadonlyArray<[Method, string]> = [
  ["post", "/payroll/accounting/journal-batches"],
  ["post", "/payroll/accounting/journal-batches/1/post"],
  ["post", "/payroll/accounting/journal-batches/1/reverse"],
  ["post", "/payroll/accounting/journal-batches/1/reconcile"],
];

async function buildApp(accessMock: ReturnType<typeof access>): Promise<INestApplication> {
  return createE2eApp({
    overrides: [
      { provide: AccessService, useValue: accessMock },
      { provide: EntitlementsService, useValue: alwaysOnEntitlements },
      { provide: JournalOutboxService, useValue: mockOutbox },
    ],
  });
}

describe("journal outbox — auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(fullAccess); }, 120_000);
  afterAll(async () => { if (app) await app.close(); });

  it.each([...READ_ROUTES, ...WRITE_ROUTES])("401 on %s %s without a token", async (method, path) => {
    const res = await request(app.getHttpServer())[method](path);
    expect(res.status).toBe(401);
  });
});

describe("journal outbox — RBAC denies without the new permission keys (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(noAccess); }, 120_000);
  afterAll(async () => { if (app) await app.close(); });

  it.each([...READ_ROUTES, ...WRITE_ROUTES])("403 on %s %s with no permissions", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())[method](path)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe("journal outbox — view permission does not grant ledger writes (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(viewOnlyAccess); }, 120_000);
  afterAll(async () => { if (app) await app.close(); });

  it.each(WRITE_ROUTES)("403 on %s %s for a view-only caller", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())[method](path)
      .set("Authorization", `Bearer ${token}`)
      .send({ periodKey: "2025-07", reason: "x", status: "RECONCILED" });
    expect(res.status).toBe(403);
  });

  it("allows reads", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/accounting/journal-batches")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe("journal outbox — contract (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(fullAccess); }, 120_000);
  afterAll(async () => { if (app) await app.close(); });
  beforeEach(() => Object.values(mockOutbox).forEach((m) => m.mockClear()));

  it("rejects a malformed periodKey", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/accounting/journal-batches")
      .set("Authorization", `Bearer ${token}`)
      .send({ periodKey: "July 2025" });
    expect(res.status).toBe(400);
    expect(mockOutbox.createBatch).not.toHaveBeenCalled();
  });

  it("requires a reason to reverse — a silent reversal is not auditable", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/accounting/journal-batches/1/reverse")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(mockOutbox.reverseBatch).not.toHaveBeenCalled();
  });

  it("creates a batch and returns 201", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/accounting/journal-batches")
      .set("Authorization", `Bearer ${token}`)
      .send({ periodKey: "2025-07" });
    expect(res.status).toBe(201);
    expect(mockOutbox.createBatch).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.objectContaining({ periodKey: "2025-07" }),
    );
  });

  it("marks the batch exported when the CSV is pulled", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/accounting/journal-batches/1/export")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(mockOutbox.markExported).toHaveBeenCalled();
  });

  it("rejects an unknown reconciliation status", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/accounting/journal-batches/1/reconcile")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "SORTED" });
    expect(res.status).toBe(400);
    expect(mockOutbox.reconcile).not.toHaveBeenCalled();
  });
});
