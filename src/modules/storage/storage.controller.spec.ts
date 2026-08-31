import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { StorageController } from "./storage.controller";
import { StorageService } from "./storage.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import type { AppConfig } from "../../config/env.validation";

function makeStorageConfig(publicUrl?: string): AppConfig {
  return {
    NODE_ENV: "test",
    RBAC_MIGRATION_MODE: "off",
    PORT: 1500,
    DATABASE_URL: "postgres://test",
    BACKEND_JWT_SECRET: "x".repeat(44),
    PORTAL_JWT_SECRET: "x".repeat(44),
    CORS_ORIGINS: "http://localhost",
    APP_URL: "http://localhost:3000",
    ENCRYPTION_KEY: "x".repeat(32),
    corsOrigins: ["http://localhost"],
    NEXT_PUBLIC_R2_PUBLIC_URL: publicUrl,
  };
}

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

  it("404s a cross-org download of an onboarding document (existence oracle prevention)", async () => {
    const db = buildDb({ onboardingDocuments: { orgId: "org-B" } });
    const controller = new StorageController(
      db as never,
      buildStorage() as never,
      audit as never,
      access as never,
    );

    await expect(
      controller.download({ key: "key123", expiresIn: 3600 }, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s a cross-org download of an expense receipt (existence oracle prevention)", async () => {
    const db = buildDb({ expenses: { orgId: "org-B" } });
    const controller = new StorageController(
      db as never,
      buildStorage() as never,
      audit as never,
      access as never,
    );

    await expect(
      controller.download({ key: "key123", expiresIn: 3600 }, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
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
      controller.download({ key: "key123", expiresIn: 3600 }, ctx("org-A"), mockRes()),
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

    await controller.download({ key: "key123", expiresIn: 3600 }, ctx("org-A"), res);

    expect(res.json).toHaveBeenCalledWith({ url: "https://signed.example.com/file" });
  });

  it("404s a cross-org payslip download (existence oracle prevention)", async () => {
    const db = buildDb({ payslipPublications: { orgId: "org-B" } });
    const controller = new StorageController(
      db as never,
      buildStorage() as never,
      audit as never,
      access as never,
    );

    await expect(
      controller.download({ key: "payroll/run-9/payslip.pdf", expiresIn: 3600 }, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s a cross-org candidate-vault download (existence oracle prevention)", async () => {
    const db = buildDb({ candidateDocumentsVault: { orgId: "org-B" } });
    const controller = new StorageController(
      db as never,
      buildStorage() as never,
      audit as never,
      access as never,
    );

    await expect(
      controller.download({ key: "candidates/cv.pdf", expiresIn: 3600 }, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s an UNTRACKED sensitive key (fails closed, prevents existence oracle)", async () => {
    const db = buildDb({});
    const controller = new StorageController(
      db as never,
      buildStorage() as never,
      audit as never,
      access as never,
    );

    await expect(
      controller.download({ key: "payroll/unregistered.pdf", expiresIn: 3600 }, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
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
      controller.download({ key: "payroll/run-9/payslip.pdf", expiresIn: 3600 }, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("DENY — JWT org governs file access: org-A actor cannot access org-B expense receipt even if membership lookup would return org-B", async () => {
    const db = {
      query: {
        documents: { findFirst: jest.fn().mockResolvedValue(null) },
        onboardingDocuments: { findFirst: jest.fn().mockResolvedValue(null) },
        expenses: { findFirst: jest.fn().mockResolvedValue({ orgId: "org-B" }) },
        reimbursements: { findFirst: jest.fn().mockResolvedValue(null) },
        handbookVersions: { findFirst: jest.fn().mockResolvedValue(null) },
        payslipPublications: { findFirst: jest.fn().mockResolvedValue(null) },
        candidateDocumentsVault: { findFirst: jest.fn().mockResolvedValue(null) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ orgId: "org-B" }) },
      },
    };
    const controller = new StorageController(
      db as never,
      buildStorage() as never,
      audit as never,
      access as never,
    );

    await expect(
      controller.download({ key: "receipts/expense.pdf", expiresIn: 3600 }, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("ALLOW — same-org generic file download succeeds (control for cross-org denial)", async () => {
    const db = buildDb({ expenses: { orgId: "org-A" } });
    const storage = buildStorage();
    const controller = new StorageController(
      db as never,
      storage as never,
      audit as never,
      access as never,
    );
    const res = mockRes();

    await controller.download({ key: "receipts/expense.pdf", expiresIn: 3600 }, ctx("org-A"), res);

    expect(res.json).toHaveBeenCalledWith({ url: "https://signed.example.com/file" });
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
  it("extracts only keys belonging to the configured storage base", () => {
    const storage = new StorageService({} as never, makeStorageConfig("https://files.example.com"));

    expect(storage.getFileKeyFromUrl("https://files.example.com/onboarding-docs/a.pdf"))
      .toBe("onboarding-docs/a.pdf");
    expect(storage.getFileKeyFromUrl("https://attacker.example/onboarding-docs/a.pdf"))
      .toBe("");
  });

  it("rejects absolute URLs and traversal as object keys", () => {
    const storage = new StorageService({} as never, makeStorageConfig());

    expect(storage.isValidFileKey("onboarding-docs/a.pdf")).toBe(true);
    expect(storage.isValidFileKey("https://attacker.example/a.pdf")).toBe(false);
    expect(storage.isValidFileKey("onboarding-docs/../secret.pdf")).toBe(false);
  });
});
