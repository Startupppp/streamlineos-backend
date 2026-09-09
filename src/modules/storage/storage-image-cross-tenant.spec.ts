import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { StorageController } from "./storage.controller";
import { MediaTransformRunner } from "./media-transform.runner";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";

function ctx(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "EMPLOYEE",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function mockRes() {
  return {
    setHeader: jest.fn(),
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
    end: jest.fn(),
  } as unknown as import("express").Response;
}

function buildDb(records: {
  expenses?: { orgId: string };
  reimbursements?: { orgId: string };
  documents?: { orgId: string };
  onboardingDocuments?: { orgId: string };
  handbookVersions?: { orgId: string };
  payslipPublications?: { orgId: string };
  candidateDocumentsVault?: { orgId: string };
}) {
  return {
    query: {
      documents: { findFirst: jest.fn().mockResolvedValue(records.documents ?? null) },
      onboardingDocuments: { findFirst: jest.fn().mockResolvedValue(records.onboardingDocuments ?? null) },
      expenses: { findFirst: jest.fn().mockResolvedValue(records.expenses ?? null) },
      reimbursements: { findFirst: jest.fn().mockResolvedValue(records.reimbursements ?? null) },
      handbookVersions: { findFirst: jest.fn().mockResolvedValue(records.handbookVersions ?? null) },
      payslipPublications: { findFirst: jest.fn().mockResolvedValue(records.payslipPublications ?? null) },
      candidateDocumentsVault: { findFirst: jest.fn().mockResolvedValue(records.candidateDocumentsVault ?? null) },
    },
  };
}

function buildStorage(streamOk = true) {
  const body = { on: jest.fn(), pipe: jest.fn() };
  return {
    isConfigured: jest.fn().mockReturnValue(true),
    isValidFileKey: jest.fn().mockReturnValue(true),
    getFileKeyFromUrl: jest.fn((v: string) => v),
    getMimeType: jest.fn().mockReturnValue("image/jpeg"),
    getFileStream: streamOk
      ? jest.fn().mockResolvedValue({ body, contentType: "image/jpeg", contentLength: 100 })
      : jest.fn().mockRejectedValue(new Error("not found")),
    getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/file"),
  };
}

const audit = { log: jest.fn() };
const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) };

function build(
  dbRecords: Parameters<typeof buildDb>[0] = {},
  streamOk = true,
) {
  const db = buildDb(dbRecords);
  const storage = buildStorage(streamOk);
  const controller = new StorageController(
    db as never,
    storage as never,
    audit as never,
    access as never,
    { scan: jest.fn() } as never,
    { isKeyBlocked: jest.fn().mockResolvedValue(false), getTotalUsageBytes: jest.fn().mockResolvedValue(0), begin: jest.fn().mockResolvedValue("qr-1"), markClean: jest.fn(), markInfected: jest.fn(), markError: jest.fn() } as never,
    new MediaTransformRunner(),
  );
  return { controller, storage, db };
}

describe("StorageController.image — cross-tenant isolation for tracked non-sensitive keys", () => {
  it("404s a cross-org image request for a tracked expense receipt (non-sensitive prefix, non-namespaced)", async () => {
    const { controller } = build({ expenses: { orgId: "org-A" } });
    await expect(
      controller.image({ key: "uploads/expense-receipt.jpg" }, ctx("org-B"), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s a cross-org image request for a tracked reimbursement receipt", async () => {
    const { controller } = build({ reimbursements: { orgId: "org-A" } });
    await expect(
      controller.image({ key: "uploads/reimb-scan.png" }, ctx("org-B"), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("ALLOW — same-org tracked expense receipt image succeeds", async () => {
    const { controller, storage } = build({ expenses: { orgId: "org-A" } });
    const res = mockRes();
    await controller.image({ key: "uploads/expense-receipt.jpg" }, ctx("org-A"), res);
    expect(storage.getFileStream).toHaveBeenCalledWith("org-A", "uploads/expense-receipt.jpg");
  });

  it("ALLOW — untracked non-sensitive, non-chat, non-namespaced key is served (public profile images etc.)", async () => {
    const { controller, storage } = build({});
    const res = mockRes();
    await controller.image({ key: "avatars/user-profile.jpg" }, ctx("org-A"), res);
    expect(storage.getFileStream).toHaveBeenCalled();
  });

  it("404s an UNTRACKED sensitive-prefix key (fails closed)", async () => {
    const { controller } = build({});
    await expect(
      controller.image({ key: "payroll/unregistered.pdf" }, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("403s a same-org HR document image (requiresDedicatedAccess denies via image path)", async () => {
    const { controller } = build({ documents: { orgId: "org-A" } });
    await expect(
      controller.image({ key: "documents/contract.pdf" }, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("download path: 404s cross-org tracked expense (ensures download parity with image)", async () => {
    const { controller } = build({ expenses: { orgId: "org-A" } });
    await expect(
      controller.download({ key: "uploads/expense-receipt.jpg", expiresIn: 3600 }, ctx("org-B"), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("download path: same-org tracked expense succeeds (control)", async () => {
    const { controller } = build({ expenses: { orgId: "org-A" } });
    const res = mockRes();
    await controller.download({ key: "uploads/expense-receipt.jpg", expiresIn: 3600 }, ctx("org-A"), res);
    expect(res.json).toHaveBeenCalledWith({ url: "https://signed.example.com/file" });
  });
});
