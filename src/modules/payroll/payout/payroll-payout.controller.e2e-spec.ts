import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { createE2eApp } from "test/helpers/e2e-app";
import { AccessService } from "../../access/access.service";
import { EntitlementsService } from "../../access/entitlements.service";
import { ApprovalsService } from "./approvals.service";
import { LockingService } from "./locking.service";
import { PayoutBatchesService } from "./payout-batches.service";
import { PayslipTemplatesService } from "./payslip-templates.service";
import { PublishingService } from "./publishing.service";

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

const permittedAccess = {
  resolveUserPermissions: jest.fn().mockResolvedValue(ALL_PAYOUT_PERMS),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
};

const forbiddenAccess = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
};

const approveOnlyAccess = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Map([
    ["payroll:runs:view", "all"],
    ["payroll:runs:approve", "all"],
  ])),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
};

const mockApproval = { id: 1, runId: 1, stage: 1, status: "PENDING" };
const mockBatch = { id: 1, runId: 1, format: "NEFT_CSV", status: "DRAFT", totalAmount: "0.00" };
const mockPublication = { id: 1, runId: 1, userId: "u1", publishedAt: new Date().toISOString() };
const mockTemplate = { id: 1, name: "Default", layout: "CLASSIC" };

const mockApprovalsService = {
  submitApproval: jest.fn().mockResolvedValue({ ok: true }),
  listApprovals: jest.fn().mockResolvedValue([mockApproval]),
  approveStage: jest.fn().mockResolvedValue({ ok: true }),
  rejectStage: jest.fn().mockResolvedValue({ ok: true }),
};

const mockLockingService = {
  lock: jest.fn().mockResolvedValue({ ok: true }),
  reopen: jest.fn().mockResolvedValue({ ok: true }),
  close: jest.fn().mockResolvedValue({ ok: true }),
};

const mockPayoutBatchesService = {
  validatePayout: jest.fn().mockResolvedValue({ valid: true, blockers: [] }),
  createBatch: jest.fn().mockResolvedValue(mockBatch),
  listBatches: jest.fn().mockResolvedValue([mockBatch]),
  getBatch: jest.fn().mockResolvedValue(mockBatch),
  getFile: jest.fn().mockResolvedValue({ content: "", filename: "batch.csv" }),
  markSent: jest.fn().mockResolvedValue({ ok: true }),
  markBatchPaid: jest.fn().mockResolvedValue({ ok: true }),
  markItemPaid: jest.fn().mockResolvedValue({ ok: true }),
  markItemFailed: jest.fn().mockResolvedValue({ ok: true }),
  getBankDetails: jest.fn().mockResolvedValue({ accountNumber: "***1234", ifsc: "SBIN0001" }),
};

const mockPayslipTemplatesService = {
  list: jest.fn().mockResolvedValue([mockTemplate]),
  preview: jest.fn().mockReturnValue("<html>payslip</html>"),
  create: jest.fn().mockResolvedValue(mockTemplate),
  update: jest.fn().mockResolvedValue(mockTemplate),
  delete: jest.fn().mockResolvedValue({ ok: true }),
};

const mockPublishingService = {
  publish: jest.fn().mockResolvedValue({ published: 0, skipped: 0 }),
  listPublications: jest.fn().mockResolvedValue([mockPublication]),
  downloadPdf: jest.fn().mockResolvedValue({ buffer: Buffer.from(""), contentType: "application/pdf" }),
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
      { provide: PayslipTemplatesService, useValue: mockPayslipTemplatesService },
      { provide: PublishingService, useValue: mockPublishingService },
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
