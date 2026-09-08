import type { INestApplication } from "@nestjs/common";
import { Readable } from "node:stream";
import request from "supertest";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { createE2eApp } from "test/helpers/e2e-app";
import { AccessService } from "../../access/access.service";
import { EntitlementsService } from "../../access/entitlements.service";
import { ApprovalsService } from "./approvals.service";
import { LockingService } from "./locking.service";
import { PayoutBatchesService } from "./payout-batches.service";
import { BatchCreatorService } from "./batch-creator.service";
import { BatchStatusService } from "./batch-status.service";
import { PayoutValidationService } from "./payout-validation.service";
import { PayslipTemplatesService } from "./payslip-templates.service";
import { PublishingService } from "./publishing.service";
import { PayrollCommandReceiptsService } from "../command-receipts.service";
import { withAccessResolution } from "../../../../test/helpers/access-stub";

const ALL_PAYOUT_PERMS = new Map([
  ["payroll:runs:view", "all"],
  ["payroll:runs:update", "all"],
  ["payroll:runs:manage", "all"],
  ["payroll:runs:approve", "all"],
  ["payroll:bank:view", "all"],
  ["payroll:bank:manage", "all"],
  ["payroll:payslips:view", "all"],
  ["payroll:payslips:manage", "all"],
]);

const permittedAccess = withAccessResolution({
  resolveUserPermissions: jest.fn().mockResolvedValue(ALL_PAYOUT_PERMS),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
  moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
});

const forbiddenAccess = withAccessResolution({
  resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
  moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
});

const approveOnlyAccess = withAccessResolution({
  resolveUserPermissions: jest.fn().mockResolvedValue(new Map([
    ["payroll:runs:view", "all"],
    ["payroll:runs:approve", "all"],
  ])),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
  moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
});

const mockApproval = {
  id: 1,
  orgId: "org1",
  runId: 1,
  stage: 1,
  stageName: "Finance Review",
  requiredPermission: "payroll:runs:approve",
  status: "PENDING",
  actedByMembershipId: null,
  actedAt: null,
  comment: null,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  isCurrentUserApprover: true,
  approverName: "Finance Approver",
};
const mockBatch = {
  id: 1,
  orgId: "org1",
  runId: 1,
  batchNumber: "PB-2026-01-001",
  status: "DRAFT",
  format: "NEFT_CSV",
  totalAmount: "0.00",
  itemCount: 1,
  generatedBy: null,
  generatedAt: null,
  sentAt: null,
  idempotencyKey: null,
};
const mockPublication = {
  id: 1,
  userId: "u1",
  workerId: null,
  runEmployeeId: 1,
  status: "PUBLISHED",
  pdfUrl: null,
  publishedAt: new Date("2026-07-01T00:00:00.000Z"),
  failureReason: null,
};
const mockTemplate = {
  id: 1,
  orgId: "org1",
  name: "Default",
  layout: "CLASSIC",
  config: {},
  isDefault: true,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
};

const mockApprovalsService = {
  submitApproval: jest.fn().mockResolvedValue({ autoApproved: false, runStatus: "PENDING_APPROVAL" }),
  listApprovals: jest.fn().mockResolvedValue([mockApproval]),
  approveStage: jest.fn().mockResolvedValue({ success: true, runStatus: "PENDING_APPROVAL" }),
  rejectStage: jest.fn().mockResolvedValue({ success: true, runStatus: "REJECTED" }),
};

const mockLockingService = {
  lock: jest.fn().mockResolvedValue({ success: true, lockedAt: new Date("2026-07-01T00:00:00.000Z") }),
  reopen: jest.fn().mockResolvedValue({ success: true, reopenedAt: new Date("2026-07-01T00:00:00.000Z") }),
  close: jest.fn().mockResolvedValue({ success: true, closedAt: new Date("2026-07-01T00:00:00.000Z") }),
};

const mockPayoutBatchesService = {
  listBatches: jest.fn().mockResolvedValue({ data: [mockBatch], pagination: { limit: 25, hasMore: false, nextCursor: null } }),
  getBatch: jest.fn().mockResolvedValue({ batch: mockBatch, items: { data: [], hasMore: false, nextCursor: null } }),
  downloadFile: jest.fn().mockResolvedValue({
    file: {
      body: Readable.from([Buffer.from("account,amount\n")]),
      contentType: "text/csv",
      contentLength: 15,
    },
    fileName: "PB-2026-01-001.csv",
  }),
  getBankDetails: jest.fn().mockResolvedValue({
    userId: "u1",
    employeeName: "Test User",
    accountNumber: "***1234",
    bankName: "Test Bank",
    branch: "Main",
    ifsc: "SBIN0001",
    accountHolder: "Test User",
    pfUanNumber: null,
    bankCountry: "IN",
  }),
};

const mockBatchCreatorService = {
  createBatch: jest.fn().mockResolvedValue(mockBatch),
};

const mockBatchStatusService = {
  markSent: jest.fn().mockResolvedValue({ success: true }),
  markBatchPaid: jest.fn().mockResolvedValue({ success: true }),
  markItemPaid: jest.fn().mockResolvedValue({ success: true }),
  markItemFailed: jest.fn().mockResolvedValue({ success: true }),
  importBankReturn: jest.fn().mockResolvedValue({
    success: true,
    paid: 1,
    failed: 0,
    skipped: 0,
    parseErrors: [],
    honestyNote: "Manual export/import only.",
    mode: "export_manual",
  }),
};

const mockPayoutValidationService = {
  validatePayout: jest.fn().mockResolvedValue({ valid: true, blockers: [] }),
};

const mockPayslipTemplatesService = {
  list: jest.fn().mockResolvedValue({ data: [mockTemplate], pagination: { limit: 25, hasMore: false, nextCursor: null } }),
  preview: jest.fn().mockReturnValue("<html>payslip</html>"),
  create: jest.fn().mockResolvedValue(mockTemplate),
  update: jest.fn().mockResolvedValue(mockTemplate),
  delete: jest.fn().mockResolvedValue({ ok: true }),
};

const mockPublishingService = {
  publish: jest.fn().mockResolvedValue({ published: 0, skipped: 0 }),
  listPublications: jest.fn().mockResolvedValue({ items: [mockPublication], truncated: false }),
  downloadPdf: jest.fn().mockResolvedValue({ buffer: Buffer.from(""), contentType: "application/pdf" }),
};

const mockCommandReceiptsService = {
  begin: jest.fn().mockResolvedValue({ kind: "fresh" as const, receiptId: 1, correlationId: "corr_1" }),
  succeed: jest.fn().mockResolvedValue(undefined),
  fail: jest.fn().mockResolvedValue(undefined),
  hashRequest: jest.fn().mockReturnValue("hash"),
};

const alwaysOnEntitlements = {
  isModuleEnabled: async (): Promise<boolean> => true,
  getModuleMap: async (): Promise<Record<string, boolean>> => ({}),
  getEffectiveModuleMap: async (): Promise<Record<string, boolean>> => ({}),
};

type Method = "get" | "post" | "patch" | "delete";

const allProtectedRoutes: ReadonlyArray<[Method, string]> = [
  ["post", "/payroll/runs/1/submit-approval"],
  ["get", "/payroll/runs/1/approvals"],
  ["post", "/payroll/runs/1/approvals/1/approve"],
  ["post", "/payroll/runs/1/approvals/1/reject"],
  ["post", "/payroll/runs/1/lock"],
  ["post", "/payroll/runs/1/reopen"],
  ["post", "/payroll/runs/1/close"],
  ["get", "/payroll/runs/1/payout/validation"],
  ["post", "/payroll/runs/1/payout/batches"],
  ["get", "/payroll/payout/batches"],
  ["get", "/payroll/payout/batches/1"],
  ["get", "/payroll/payout/batches/1/file"],
  ["post", "/payroll/payout/batches/1/mark-sent"],
  ["post", "/payroll/payout/batches/1/mark-paid"],
  ["post", "/payroll/payout/batches/1/items/1/mark-paid"],
  ["post", "/payroll/payout/batches/1/items/1/mark-failed"],
  ["get", "/payroll/employees/u1/bank"],
  ["post", "/payroll/runs/1/payslips/publish"],
  ["get", "/payroll/runs/1/payslips"],
  ["get", "/payroll/payslip-templates"],
  ["post", "/payroll/payslip-templates"],
  ["patch", "/payroll/payslip-templates/1"],
  ["delete", "/payroll/payslip-templates/1"],
];

async function buildApp(accessMock: typeof permittedAccess): Promise<INestApplication> {
  return createE2eApp({
    overrides: [
      { provide: AccessService, useValue: accessMock },
      { provide: EntitlementsService, useValue: alwaysOnEntitlements },
      { provide: ApprovalsService, useValue: mockApprovalsService },
      { provide: LockingService, useValue: mockLockingService },
      { provide: PayoutBatchesService, useValue: mockPayoutBatchesService },
      { provide: BatchCreatorService, useValue: mockBatchCreatorService },
      { provide: BatchStatusService, useValue: mockBatchStatusService },
      { provide: PayoutValidationService, useValue: mockPayoutValidationService },
      { provide: PayslipTemplatesService, useValue: mockPayslipTemplatesService },
      { provide: PublishingService, useValue: mockPublishingService },
      { provide: PayrollCommandReceiptsService, useValue: mockCommandReceiptsService },
    ],
  });
}

describe("payroll-payout auth/RBAC — 401 (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  it.each(allProtectedRoutes)("401 on %s %s without token", async (method, path) => {
    const res = await request(app.getHttpServer())[method](path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("GET /payroll/payslips/1/download → 401 without token (auth-only guard)", async () => {
    const res = await request(app.getHttpServer()).get("/payroll/payslips/1/download");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });
});

describe("payroll-payout RBAC — 403 when no permissions (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(forbiddenAccess); });
  afterAll(async () => app.close());

  const rbacRoutes: ReadonlyArray<[Method, string]> = [
    ["post", "/payroll/runs/1/submit-approval"],
    ["get", "/payroll/runs/1/approvals"],
    ["post", "/payroll/runs/1/approvals/1/approve"],
    ["post", "/payroll/runs/1/approvals/1/reject"],
    ["post", "/payroll/runs/1/lock"],
    ["post", "/payroll/runs/1/reopen"],
    ["post", "/payroll/runs/1/close"],
    ["get", "/payroll/runs/1/payout/validation"],
    ["post", "/payroll/runs/1/payout/batches"],
    ["get", "/payroll/payout/batches"],
    ["get", "/payroll/payout/batches/1"],
    ["get", "/payroll/payout/batches/1/file"],
    ["post", "/payroll/payout/batches/1/mark-sent"],
    ["post", "/payroll/payout/batches/1/mark-paid"],
    ["post", "/payroll/payout/batches/1/items/1/mark-paid"],
    ["post", "/payroll/payout/batches/1/items/1/mark-failed"],
    ["get", "/payroll/employees/u1/bank"],
    ["post", "/payroll/runs/1/payslips/publish"],
    ["get", "/payroll/runs/1/payslips"],
    ["get", "/payroll/payslip-templates"],
    ["post", "/payroll/payslip-templates"],
    ["patch", "/payroll/payslip-templates/1"],
    ["delete", "/payroll/payslip-templates/1"],
  ];

  it.each(rbacRoutes)("403 on %s %s with empty permission map", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())[method](path)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});

describe("payroll-payout RBAC — specific permission key enforcement (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(approveOnlyAccess); });
  afterAll(async () => app.close());

  it("POST /payroll/runs/1/lock → 403 for approve-only caller (requires payroll:runs:manage)", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/payroll/runs/1/lock")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("POST /payroll/runs/1/reopen → 403 for approve-only caller (requires payroll:runs:manage)", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/payroll/runs/1/reopen")
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "reopening" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("GET /payroll/runs/1/payout/validation → 403 for approve-only (requires payroll:bank:manage)", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/payroll/runs/1/payout/validation")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("POST /payroll/runs/1/payslips/publish → 403 for approve-only (requires payroll:payslips:manage)", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/payroll/runs/1/payslips/publish")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("GET /payroll/employees/u1/bank → 403 for approve-only (requires payroll:bank:view)", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/payroll/employees/u1/bank")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});

/**
 * The bank file is a CSV of every payee's UNMASKED account number and IFSC.
 *
 * The route used to answer `{ url, batchNumber }` — a presigned S3 link valid
 * for 3600 s — which the table then opened with `window.open`. That put the
 * most sensitive artefact payroll produces behind a bearer-free URL that
 * outlived the screen, survived in browser history and could be forwarded.
 *
 * It streams under the caller's own credential now. These assertions pin the
 * three properties that make that true: the body is the file's bytes and not a
 * JSON envelope, no URL is minted anywhere in the response, and the response is
 * marked private and non-storable.
 */
describe("payroll-payout — the bank file streams, it is not a presigned URL (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  it("GET /payroll/payout/batches/1/file returns the CSV bytes, not a link to them", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/payout/batches/1/file")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.text).toContain("account,amount");
    expect(res.body).not.toHaveProperty("url");
    expect(JSON.stringify(res.headers) + res.text).not.toMatch(/X-Amz-Signature|Expires=/i);
  });
});

/**
 * Every payout command that moves money is `@Idempotent`. A missing
 * `Idempotency-Key` is rejected by the global interceptor before the handler
 * runs — that 400 IS the fence, and its absence is what let a double-clicked
 * "Mark Paid" settle the same batch twice. `check:idempotent-commands` could
 * not see these four handlers because it matched the string on the method
 * decorator ("mark-paid") rather than the full path under
 * `@Controller("payroll/payout")`.
 */
describe("payroll-payout — money-moving commands are idempotency-fenced (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  const fencedCommands: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["/payroll/payout/batches/1/mark-sent", {}],
    ["/payroll/payout/batches/1/mark-paid", { transactionRef: "NEFT001" }],
    ["/payroll/payout/batches/1/items/1/mark-paid", { transactionRef: "NEFT002" }],
    ["/payroll/payout/batches/1/items/1/mark-failed", { failureReason: "Account closed" }],
    ["/payroll/payout/batches/1/import-return", { csv: "ref,status\nNEFT001,PAID" }],
  ];

  it.each(fencedCommands)("POST %s → 400 without an Idempotency-Key", async (path, body) => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post(path)
      .set("Authorization", `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Idempotency-Key/i);
  });

  it.each(fencedCommands)("POST %s → 200 once a key is supplied", async (path, body) => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post(path)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `e2e-${path.replace(/\W+/g, "-")}-${Date.now()}`)
      .send(body);

    expect(res.status).toBe(200);
  });
});

describe("payroll-payout RBAC — 200 for permitted caller (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  it("GET /payroll/runs/1/approvals → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/runs/1/approvals")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("POST /payroll/runs/1/submit-approval → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/runs/1/submit-approval")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/payout/batches → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/payout/batches")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/runs/1/payslips → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/runs/1/payslips")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/payslip-templates → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/payslip-templates")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/employees/u1/bank → 200 with payroll:bank:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/employees/u1/bank")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accountNumber: expect.any(String), ifsc: expect.any(String) });
  });

  it("POST /payroll/runs/1/lock → 200 with payroll:runs:manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/runs/1/lock")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("POST /payroll/runs/1/reopen → 200 with valid reason", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/runs/1/reopen")
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "correction required" });
    expect(res.status).toBe(200);
  });

  it("POST /payroll/runs/1/reopen → 400 when reason missing", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/runs/1/reopen")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("POST /payroll/runs/1/approvals/1/reject → 400 when comment missing", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/runs/1/approvals/1/reject")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
