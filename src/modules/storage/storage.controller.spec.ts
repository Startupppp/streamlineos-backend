import { ForbiddenException } from "@nestjs/common";
import { StorageController } from "./storage.controller";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function ctx(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    branchId: null,
    role: "EMPLOYEE",
    permissions: [],
    enabledModules: ["HR"],
    plan: "PROFESSIONAL",
    isPlatformAdmin: false,
    isOrgOwner: false,
    sessionId: "sess-1",
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
  }) {
    return {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ orgId: "org-A" }) },
        documents: { findFirst: jest.fn().mockResolvedValue(records.documents ?? null) },
        onboardingDocuments: { findFirst: jest.fn().mockResolvedValue(records.onboardingDocuments ?? null) },
        expenses: { findFirst: jest.fn().mockResolvedValue(records.expenses ?? null) },
        reimbursements: { findFirst: jest.fn().mockResolvedValue(records.reimbursements ?? null) },
        handbookVersions: { findFirst: jest.fn().mockResolvedValue(records.handbookVersions ?? null) },
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

  it("403s a cross-org download of an onboarding document not tracked in the generic documents table", async () => {
    const db = buildDb({ onboardingDocuments: { orgId: "org-B" } });
    const controller = new StorageController(db as never, buildStorage() as never, audit as never);

    await expect(
      controller.download(undefined, "key123", undefined, undefined, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("403s a cross-org download of an expense receipt", async () => {
    const db = buildDb({ expenses: { orgId: "org-B" } });
    const controller = new StorageController(db as never, buildStorage() as never, audit as never);

    await expect(
      controller.download(undefined, "key123", undefined, undefined, ctx("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows a same-org onboarding document download", async () => {
    const db = buildDb({ onboardingDocuments: { orgId: "org-A" } });
    const controller = new StorageController(db as never, buildStorage() as never, audit as never);
    const res = mockRes();

    await controller.download(undefined, "key123", undefined, undefined, ctx("org-A"), res);

    expect(res.json).toHaveBeenCalledWith({ url: "https://signed.example.com/file" });
  });

  it("allows a download when the key isn't tracked in any known table (unchanged prior behavior)", async () => {
    const db = buildDb({});
    const controller = new StorageController(db as never, buildStorage() as never, audit as never);
    const res = mockRes();

    await controller.download(undefined, "key123", undefined, undefined, ctx("org-A"), res);

    expect(res.json).toHaveBeenCalledWith({ url: "https://signed.example.com/file" });
  });
});
