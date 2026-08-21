import { ForbiddenException } from "@nestjs/common";
import { StorageController } from "./storage.controller";
import { StorageService } from "./storage.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function ctx(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "EMPLOYEE",
    permissions: [],
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
  };
}

function mockRes() {
  return {
    setHeader: jest.fn(),
    json: jest.fn(),
  } as unknown as import("express").Response;
}

describe("StorageController.download — cross-org file isolation", () => {
  function buildDb(records: {
    documents?: { orgId: string };
    onboardingDocuments?: { orgId: string };
    expenses?: { orgId: string };
    reimbursements?: { orgId: string };
    handbookVersions?: { orgId: string };
    payslipPublications?: { orgId: string };
    candidateDocumentsVault?: { orgId: string };
  }) {
    return {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ orgId: "org-A" }) },
        documents: { findFirst: jest.fn().mockResolvedValue(records.documents ?? null) },
        onboardingDocuments: { findFirst: jest.fn().mockResolvedValue(records.onboardingDocuments ?? null) },
        expenses: { findFirst: jest.fn().mockResolvedValue(records.expenses ?? null) },
        reimbursements: { findFirst: jest.fn().mockResolvedValue(records.reimbursements ?? null) },
        handbookVersions: { findFirst: jest.fn().mockResolvedValue(records.handbookVersions ?? null) },
        payslipPublications: { findFirst: jest.fn().mockResolvedValue(records.payslipPublications ?? null) },
        candidateDocumentsVault: {
          findFirst: jest.fn().mockResolvedValue(records.candidateDocumentsVault ?? null),
        },
      },
    };
  }

  function buildStorage() {
    return {
      isConfigured: jest.fn().mockReturnValue(true),
      isValidFileKey: jest.fn().mockReturnValue(true),
      getFileKeyFromUrl: jest.fn((v: string) => v),
      getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/file"),
    };
  }

  const audit = { log: jest.fn() };
  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) };

  it("403s a cross-org download of an onboarding document not tracked in the generic documents table", async () => {
    const db = buildDb({ onboardingDocuments: { orgId: "org-B" } });
    const controller = new StorageController(
      db as never,
      buildStorage() as never,
      audit as never,
      access as never,
    );

    await expect(
      controller.download(undefined, "key123", undefined, undefined, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("403s a cross-org download of an expense receipt", async () => {
    const db = buildDb({ expenses: { orgId: "org-B" } });
    const controller = new StorageController(
      db as never,
      buildStorage() as never,
      audit as never,
      access as never,
    );

    await expect(
      controller.download(undefined, "key123", undefined, undefined, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("requires the dedicated scoped endpoint for a same-org onboarding document", async () => {
    const db = buildDb({ onboardingDocuments: { orgId: "org-A" } });
    const controller = new StorageController(
      db as never,
      buildStorage() as never,
      audit as never,
      access as never,
    );

    await expect(
      controller.download(undefined, "key123", undefined, undefined, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows a download when a NON-sensitive key isn't tracked in any known table", async () => {
    const db = buildDb({});
    const controller = new StorageController(
      db as never,
      buildStorage() as never,
      audit as never,
      access as never,
    );
    const res = mockRes();

    await controller.download(undefined, "key123", undefined, undefined, ctx("org-A"), res);

    expect(res.json).toHaveBeenCalledWith({ url: "https://signed.example.com/file" });
  });

  it("403s a cross-org payslip download", async () => {
    const db = buildDb({ payslipPublications: { orgId: "org-B" } });
    const controller = new StorageController(
      db as never,
      buildStorage() as never,
      audit as never,
      access as never,
    );

    await expect(
      controller.download(undefined, "payroll/run-9/payslip.pdf", undefined, undefined, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("403s a cross-org candidate-vault download", async () => {
    const db = buildDb({ candidateDocumentsVault: { orgId: "org-B" } });
    const controller = new StorageController(
      db as never,
      buildStorage() as never,
      audit as never,
      access as never,
    );

    await expect(
      controller.download(undefined, "candidates/cv.pdf", undefined, undefined, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("403s an UNTRACKED sensitive key instead of failing open", async () => {
    const db = buildDb({});
    const controller = new StorageController(
      db as never,
      buildStorage() as never,
      audit as never,
      access as never,
    );

    await expect(
      controller.download(undefined, "payroll/unregistered.pdf", undefined, undefined, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("requires the dedicated scoped endpoint for a same-org payslip", async () => {
    const db = buildDb({ payslipPublications: { orgId: "org-A" } });
    const controller = new StorageController(
      db as never,
      buildStorage() as never,
      audit as never,
      access as never,
    );

    await expect(
      controller.download(
        undefined,
        "payroll/run-9/payslip.pdf",
        undefined,
        undefined,
        ctx("org-A"),
        mockRes(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects a protected-folder upload without its feature permission", async () => {
    const db = buildDb({});
    const storage = buildStorage();
    const controller = new StorageController(
      db as never,
      storage as never,
      audit as never,
      access as never,
    );
    const file = {
      size: 4,
      mimetype: "application/pdf",
      originalname: "identity.pdf",
      buffer: Buffer.from("%PDF"),
    } as Express.Multer.File;

    await expect(
      controller.upload(file, "onboarding-docs", ctx("org-A")),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(storage.getFileUrl).not.toHaveBeenCalled();
  });
});

describe("StorageService private file references", () => {
  const originalPublicUrl = process.env.NEXT_PUBLIC_R2_PUBLIC_URL;

  afterEach(() => {
    if (originalPublicUrl === undefined) delete process.env.NEXT_PUBLIC_R2_PUBLIC_URL;
    else process.env.NEXT_PUBLIC_R2_PUBLIC_URL = originalPublicUrl;
  });

  it("extracts only keys belonging to the configured storage base", () => {
    process.env.NEXT_PUBLIC_R2_PUBLIC_URL = "https://files.example.com";
    const storage = new StorageService({} as never);

    expect(storage.getFileKeyFromUrl("https://files.example.com/onboarding-docs/a.pdf"))
      .toBe("onboarding-docs/a.pdf");
    expect(storage.getFileKeyFromUrl("https://attacker.example/onboarding-docs/a.pdf"))
      .toBe("");
  });

  it("rejects absolute URLs and traversal as object keys", () => {
    const storage = new StorageService({} as never);

    expect(storage.isValidFileKey("onboarding-docs/a.pdf")).toBe(true);
    expect(storage.isValidFileKey("https://attacker.example/a.pdf")).toBe(false);
    expect(storage.isValidFileKey("onboarding-docs/../secret.pdf")).toBe(false);
  });
});
