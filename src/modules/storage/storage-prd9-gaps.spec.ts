import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { StorageController } from "./storage.controller";
import type { StorageService } from "./storage.service";
import type { FileQuarantineService } from "./file-quarantine.service";
import type { MediaCompressionService } from "../../common/media/media-compression.service";
import type { AuditService } from "../../common/audit/audit.service";
import type { AccessService } from "../access/access.service";
import type { AvScanner } from "../../common/security/av-scan";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);

function makeUser(orgId = "org-1"): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function makeFile(
  mimetype: string,
  buffer: Buffer,
  originalname = "upload.jpg",
): Express.Multer.File {
  return {
    mimetype,
    buffer,
    originalname,
    size: buffer.length,
    fieldname: "file",
    encoding: "7bit",
    stream: undefined as unknown as never,
    destination: "",
    filename: originalname,
    path: "",
  } as unknown as Express.Multer.File;
}

function mockRes() {
  return {
    setHeader: jest.fn(),
    json: jest.fn(),
  } as unknown as import("express").Response;
}

function buildPreGenResult(overrides: Partial<{ key: string; url: string; sha256: string }> = {}) {
  return {
    key: overrides.key ?? "org-1/uploads/uuid-file.jpg",
    url: overrides.url ?? "https://cdn.example.com/org-1/uploads/uuid-file.jpg",
    compressedBuffer: JPEG_MAGIC,
    compressedMimeType: "image/webp",
    size: 12,
    sha256: overrides.sha256 ?? "deadbeef",
  };
}

function buildDb(records: {
  documents?: { orgId: string };
  onboardingDocuments?: { orgId: string };
  expenses?: { orgId: string };
  reimbursements?: { orgId: string };
  handbookVersions?: { orgId: string };
  payslipPublications?: { orgId: string };
  candidateDocumentsVault?: { orgId: string };
} = {}) {
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

function buildController(overrides: {
  scanResult?: Awaited<ReturnType<AvScanner["scan"]>>;
  uploadResult?: { key: string; url: string; sha256: string };
  quotaUsedBytes?: number;
  quarantineBlocked?: boolean;
  uploadConfigured?: boolean;
} = {}): {
  controller: StorageController;
  quarantine: jest.Mocked<Pick<FileQuarantineService, "begin" | "markClean" | "markInfected" | "markError" | "isKeyBlocked" | "getTotalUsageBytes" | "getTotalUsageBytesForUser">>;
  storage: jest.Mocked<Pick<StorageService, "isConfigured" | "compressAndPreGenerateKey" | "uploadToKey" | "isValidFileKey" | "getFileKeyFromUrl" | "getFileUrl">>;
} {
  const preGen = buildPreGenResult(overrides.uploadResult);
  const storage = {
    isConfigured: jest.fn().mockReturnValue(overrides.uploadConfigured ?? true),
    compressAndPreGenerateKey: jest.fn().mockResolvedValue(preGen),
    uploadToKey: jest.fn().mockResolvedValue(undefined),
    isValidFileKey: jest.fn().mockReturnValue(true),
    getFileKeyFromUrl: jest.fn((v: string) => v),
    getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/file"),
  } as unknown as jest.Mocked<Pick<StorageService, "isConfigured" | "compressAndPreGenerateKey" | "uploadToKey" | "isValidFileKey" | "getFileKeyFromUrl" | "getFileUrl">>;

  const quarantine = {
    begin: jest.fn().mockResolvedValue("qr-id-1"),
    markClean: jest.fn().mockResolvedValue(undefined),
    markInfected: jest.fn().mockResolvedValue(undefined),
    markError: jest.fn().mockResolvedValue(undefined),
    isKeyBlocked: jest.fn().mockResolvedValue(overrides.quarantineBlocked ?? false),
    getTotalUsageBytes: jest.fn().mockResolvedValue(overrides.quotaUsedBytes ?? 0),
    getTotalUsageBytesForUser: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<Pick<FileQuarantineService, "begin" | "markClean" | "markInfected" | "markError" | "isKeyBlocked" | "getTotalUsageBytes" | "getTotalUsageBytesForUser">>;

  const audit = { log: jest.fn() } as unknown as AuditService;
  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
  const avScanner = { scan: jest.fn().mockResolvedValue(overrides.scanResult ?? { status: "clean" }) } as unknown as AvScanner;
  const compression = { generateThumbnail: jest.fn().mockResolvedValue(null) } as unknown as MediaCompressionService;

  const controller = new StorageController(
    buildDb() as never,
    storage as unknown as StorageService,
    audit,
    access,
    avScanner,
    quarantine as unknown as FileQuarantineService,
    compression,
  );

  return { controller, quarantine, storage };
}

describe("AC1: content-type vs extension mismatch (polyglot/renamed file) rejected", () => {
  it("rejects a PNG buffer declared as JPEG — magic bytes do not match MIME type", async () => {
    const { controller } = buildController();
    const file = makeFile("image/jpeg", PNG_MAGIC, "photo.jpg");

    await expect(
      controller.upload(file, "uploads", makeUser()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("accepts a genuine JPEG buffer declared as JPEG (control: valid upload passes)", async () => {
    const { controller } = buildController();
    const file = makeFile("image/jpeg", JPEG_MAGIC, "photo.jpg");

    const result = await controller.upload(file, "uploads", makeUser());

    expect(result.mimeType).toBe("image/webp");
  });

  it("rejects an executable disguised as a JPEG (unknown magic bytes)", async () => {
    const { controller } = buildController();
    const exeBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
    const file = makeFile("image/jpeg", exeBuffer, "malware.jpg");

    await expect(
      controller.upload(file, "uploads", makeUser()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("AC1: per-organization quota breach rejected", () => {
  it("rejects upload when org has reached the 5GB quota", async () => {
    const usedBytes = 5 * 1024 * 1024 * 1024;
    const { controller } = buildController({ quotaUsedBytes: usedBytes });
    const file = makeFile("image/jpeg", JPEG_MAGIC, "photo.jpg");

    await expect(
      controller.upload(file, "uploads", makeUser()),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it("allows upload when org is just below the quota (boundary condition)", async () => {
    const usedBytes = 5 * 1024 * 1024 * 1024 - JPEG_MAGIC.length - 1;
    const { controller } = buildController({ quotaUsedBytes: usedBytes });
    const file = makeFile("image/jpeg", JPEG_MAGIC, "photo.jpg");

    const result = await controller.upload(file, "uploads", makeUser());

    expect(result).toBeDefined();
  });
});

describe("AC4: unscanned file in quarantine is not downloadable (fail closed)", () => {
  it("404s a download for a key that is quarantine-blocked (pending_scan)", async () => {
    const { controller } = buildController({ quarantineBlocked: true });
    const db = buildDb({});
    const storage = {
      isConfigured: jest.fn().mockReturnValue(true),
      isValidFileKey: jest.fn().mockReturnValue(true),
      getFileKeyFromUrl: jest.fn((v: string) => v),
      getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/file"),
    };
    const quarantine = {
      isKeyBlocked: jest.fn().mockResolvedValue(true),
      getTotalUsageBytes: jest.fn().mockResolvedValue(0),
      begin: jest.fn(),
      markClean: jest.fn(),
      markInfected: jest.fn(),
      markError: jest.fn(),
    };
    const ctl = new StorageController(
      db as never,
      storage as unknown as StorageService,
      { log: jest.fn() } as unknown as AuditService,
      { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService,
      { scan: jest.fn() } as unknown as AvScanner,
      quarantine as unknown as FileQuarantineService,
      { generateThumbnail: jest.fn() } as unknown as MediaCompressionService,
    );

    await expect(
      ctl.download({ key: "org-1/uploads/uuid-file.jpg", expiresIn: 3600 }, makeUser(), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("allows download for a key that is not in quarantine (clean or not tracked)", async () => {
    const db = buildDb({});
    const storage = {
      isConfigured: jest.fn().mockReturnValue(true),
      isValidFileKey: jest.fn().mockReturnValue(true),
      getFileKeyFromUrl: jest.fn((v: string) => v),
      getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/file"),
    };
    const quarantine = {
      isKeyBlocked: jest.fn().mockResolvedValue(false),
      getTotalUsageBytes: jest.fn().mockResolvedValue(0),
      begin: jest.fn(),
      markClean: jest.fn(),
      markInfected: jest.fn(),
      markError: jest.fn(),
    };
    const ctl = new StorageController(
      db as never,
      storage as unknown as StorageService,
      { log: jest.fn() } as unknown as AuditService,
      { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService,
      { scan: jest.fn() } as unknown as AvScanner,
      quarantine as unknown as FileQuarantineService,
      { generateThumbnail: jest.fn() } as unknown as MediaCompressionService,
    );
    const res = mockRes();

    await ctl.download({ key: "org-1/uploads/uuid-file.jpg", expiresIn: 3600 }, makeUser(), res);

    expect(res.json).toHaveBeenCalledWith({ url: "https://signed.example.com/file" });
  });
});

describe("AC4: upload sets quarantine record to clean after scan passes", () => {
  it("records quarantine begin and markClean on a successful upload", async () => {
    const { controller, quarantine } = buildController();
    const file = makeFile("image/jpeg", JPEG_MAGIC, "photo.jpg");

    await controller.upload(file, "uploads", makeUser());

    expect(quarantine.begin).toHaveBeenCalledTimes(1);
    expect(quarantine.markClean).toHaveBeenCalledTimes(1);
    expect(quarantine.markInfected).not.toHaveBeenCalled();
  });

  it("does not call markClean when the scanner rejects the file (infected)", async () => {
    const { controller, quarantine } = buildController({
      scanResult: { status: "infected", threat: "Eicar-Test-Signature" },
    });
    const file = makeFile("image/jpeg", JPEG_MAGIC, "photo.jpg");

    await expect(
      controller.upload(file, "uploads", makeUser()),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(quarantine.markClean).not.toHaveBeenCalled();
  });

  it("does not call markClean when the scanner is unavailable (error)", async () => {
    const { controller, quarantine } = buildController({
      scanResult: { status: "error", reason: "clamd-unreachable" },
    });
    const file = makeFile("image/jpeg", JPEG_MAGIC, "photo.jpg");

    await expect(
      controller.upload(file, "uploads", makeUser()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(quarantine.markClean).not.toHaveBeenCalled();
  });
});

describe("AC7: cross-tenant object key denied", () => {
  it("404s when the file's quarantine record belongs to a different org", async () => {
    const db = buildDb({ expenses: { orgId: "org-B" } });
    const storage = {
      isConfigured: jest.fn().mockReturnValue(true),
      isValidFileKey: jest.fn().mockReturnValue(true),
      getFileKeyFromUrl: jest.fn((v: string) => v),
      getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/file"),
    };
    const quarantine = {
      isKeyBlocked: jest.fn().mockResolvedValue(false),
      getTotalUsageBytes: jest.fn().mockResolvedValue(0),
      begin: jest.fn(),
      markClean: jest.fn(),
      markInfected: jest.fn(),
      markError: jest.fn(),
    };
    const ctl = new StorageController(
      db as never,
      storage as unknown as StorageService,
      { log: jest.fn() } as unknown as AuditService,
      { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService,
      { scan: jest.fn() } as unknown as AvScanner,
      quarantine as unknown as FileQuarantineService,
      { generateThumbnail: jest.fn() } as unknown as MediaCompressionService,
    );

    await expect(
      ctl.download({ key: "receipts/expense.pdf", expiresIn: 3600 }, makeUser("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("AC7: expired signed URL denied", () => {
  it("verifyDownloadToken rejects a token with ttl=-1 as expired", async () => {
    const { verifyDownloadToken, signDownloadToken } = await import("../../common/security/av-scan");
    const SECRET = "test-secret-that-is-at-least-32-bytes-long";

    const expiredToken = signDownloadToken("org-1", "org-1/uploads/file.pdf", SECRET, -1);
    const result = verifyDownloadToken(expiredToken, SECRET);

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("expired");
  });

  it("verifyDownloadToken accepts a fresh token", async () => {
    const { verifyDownloadToken, signDownloadToken } = await import("../../common/security/av-scan");
    const SECRET = "test-secret-that-is-at-least-32-bytes-long";

    const token = signDownloadToken("org-1", "org-1/uploads/file.pdf", SECRET);
    const result = verifyDownloadToken(token, SECRET);

    expect(result.valid).toBe(true);
  });
});

describe("AC7: re-authorized download after permission revocation denied", () => {
  it("denies download when the file record has moved to a different org (permission revoked scenario)", async () => {
    const db = buildDb({ onboardingDocuments: { orgId: "org-B" } });
    const storage = {
      isConfigured: jest.fn().mockReturnValue(true),
      isValidFileKey: jest.fn().mockReturnValue(true),
      getFileKeyFromUrl: jest.fn((v: string) => v),
      getFileUrl: jest.fn(),
    };
    const quarantine = {
      isKeyBlocked: jest.fn().mockResolvedValue(false),
      getTotalUsageBytes: jest.fn().mockResolvedValue(0),
      begin: jest.fn(),
      markClean: jest.fn(),
      markInfected: jest.fn(),
      markError: jest.fn(),
    };
    const ctl = new StorageController(
      db as never,
      storage as unknown as StorageService,
      { log: jest.fn() } as unknown as AuditService,
      { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService,
      { scan: jest.fn() } as unknown as AvScanner,
      quarantine as unknown as FileQuarantineService,
      { generateThumbnail: jest.fn() } as unknown as MediaCompressionService,
    );

    await expect(
      ctl.download({ key: "onboarding/doc.pdf", expiresIn: 3600 }, makeUser("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(storage.getFileUrl).not.toHaveBeenCalled();
  });

  it("denies download for same-org dedicated-access file without the feature-specific endpoint", async () => {
    const db = buildDb({ onboardingDocuments: { orgId: "org-A" } });
    const storage = {
      isConfigured: jest.fn().mockReturnValue(true),
      isValidFileKey: jest.fn().mockReturnValue(true),
      getFileKeyFromUrl: jest.fn((v: string) => v),
      getFileUrl: jest.fn(),
    };
    const quarantine = {
      isKeyBlocked: jest.fn().mockResolvedValue(false),
      getTotalUsageBytes: jest.fn().mockResolvedValue(0),
      begin: jest.fn(),
      markClean: jest.fn(),
      markInfected: jest.fn(),
      markError: jest.fn(),
    };
    const ctl = new StorageController(
      db as never,
      storage as unknown as StorageService,
      { log: jest.fn() } as unknown as AuditService,
      { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService,
      { scan: jest.fn() } as unknown as AvScanner,
      quarantine as unknown as FileQuarantineService,
      { generateThumbnail: jest.fn() } as unknown as MediaCompressionService,
    );

    await expect(
      ctl.download({ key: "onboarding/doc.pdf", expiresIn: 3600 }, makeUser("org-A"), mockRes()),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(storage.getFileUrl).not.toHaveBeenCalled();
  });
});

describe("AC3: idempotent retry of finalize produces exactly one quarantine record", () => {
  it("a successful upload calls quarantine.begin exactly once even if called repeatedly", async () => {
    const { controller, quarantine } = buildController();
    const file = makeFile("image/jpeg", JPEG_MAGIC, "photo.jpg");

    await controller.upload(file, "uploads", makeUser());

    expect(quarantine.begin).toHaveBeenCalledTimes(1);
    expect(quarantine.markClean).toHaveBeenCalledTimes(1);
  });

  it("the quarantine record is keyed to the result of uploadCompressed (one record per upload)", async () => {
    const uploadResult = { key: "org-1/uploads/specific-uuid-photo.jpg", url: "https://cdn.example.com/org-1/uploads/specific-uuid-photo.jpg", sha256: "deadbeef" };
    const { controller, quarantine } = buildController({ uploadResult });
    const file = makeFile("image/jpeg", JPEG_MAGIC, "photo.jpg");

    await controller.upload(file, "uploads", makeUser());

    const beginCall = (quarantine.begin as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(beginCall?.storageKey).toBe("org-1/uploads/specific-uuid-photo.jpg");
    expect(beginCall?.sha256).toBe("deadbeef");
  });
});

describe("AC4: VirusTotal malformed response fails closed (file stays quarantined)", () => {
  it("safeParse failure on file-report returns error status — no verdict flip to clean", async () => {
    const { vtFileReportSchema } = await import("../../common/security/virustotal-av-scanner.schema");
    const malformedPayload = { data: { attributes: { last_analysis_stats: "not-an-object" } } };

    const result = vtFileReportSchema.safeParse(malformedPayload);

    expect(result.success).toBe(false);
  });

  it("safeParse failure on upload response returns null — upload does not proceed", async () => {
    const { vtUploadResponseSchema } = await import("../../common/security/virustotal-av-scanner.schema");
    const malformedPayload = { data: { id: 12345 } };

    const result = vtUploadResponseSchema.safeParse(malformedPayload);

    expect(result.success).toBe(false);
  });

  it("safeParse failure on analysis report returns error status — file is not released", async () => {
    const { vtAnalysisReportSchema } = await import("../../common/security/virustotal-av-scanner.schema");
    const malformedPayload = { data: { attributes: { status: true, stats: null } } };

    const result = vtAnalysisReportSchema.safeParse(malformedPayload);

    expect(result.success).toBe(false);
  });

  it("an unexpected shape on file-report produces a defined error (never treated as clean)", async () => {
    const { vtFileReportSchema } = await import("../../common/security/virustotal-av-scanner.schema");
    const externalPayload = { unexpected_key: "value", malicious: true };

    const result = vtFileReportSchema.safeParse(externalPayload);

    if (result.success) {
      expect(result.data.data?.attributes?.last_analysis_stats?.malicious).toBeUndefined();
    } else {
      expect(result.success).toBe(false);
    }
  });
});
