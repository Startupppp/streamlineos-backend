import { BadRequestException, PayloadTooLargeException, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { StorageController } from "./storage.controller";
import type { StorageService } from "./storage.service";
import type { AuditService } from "../../common/audit/audit.service";
import type { AccessService } from "../access/access.service";
import type { AvScanner } from "../../common/security/av-scan";
import { MediaTransformRunner } from "./media-transform.runner";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);

const PLAN_RESULT = {
  key: "org-1/uploads/uuid-file.webp",
  plannedMimeType: "image/webp",
};

const STORED_RESULT = { size: 100, mimeType: "image/webp", sha256: "aabbccdd" };

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

describe("StorageController — malware scan gate", () => {
  let controller: StorageController;
  let mockStorage: {
    isConfigured: jest.Mock;
    planUpload: jest.Mock;
    compressToKey: jest.Mock;
    deleteFileIfPresent: jest.Mock;
  };
  let mockAudit: { log: jest.Mock };
  let mockAccess: { resolveUserPermissions: jest.Mock };
  let mockScanner: { scan: jest.Mock };
  let mockQuarantine: {
    isKeyBlocked: jest.Mock;
    getTotalUsageBytes: jest.Mock;
    getTotalUsageBytesForUser: jest.Mock;
    begin: jest.Mock;
    markClean: jest.Mock;
    markInfected: jest.Mock;
    markError: jest.Mock;
    recordMeasuredObject: jest.Mock;
    softDelete: jest.Mock;
  };
  let transforms: MediaTransformRunner;
  let mockDb: { query: Record<string, unknown> };

  beforeEach(() => {
    jest.resetAllMocks();

    mockStorage = {
      isConfigured: jest.fn().mockReturnValue(true),
      planUpload: jest.fn().mockResolvedValue(PLAN_RESULT),
      compressToKey: jest.fn().mockResolvedValue(STORED_RESULT),
      deleteFileIfPresent: jest.fn().mockResolvedValue(true),
    };
    mockAudit = { log: jest.fn() };
    mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) };
    mockScanner = { scan: jest.fn().mockResolvedValue({ status: "clean" }) };
    mockQuarantine = {
      isKeyBlocked: jest.fn().mockResolvedValue(false),
      getTotalUsageBytes: jest.fn().mockResolvedValue(0),
      getTotalUsageBytesForUser: jest.fn().mockResolvedValue(0),
      begin: jest.fn().mockResolvedValue("qr-1"),
      markClean: jest.fn(),
      markInfected: jest.fn(),
      markError: jest.fn(),
      recordMeasuredObject: jest.fn(),
      softDelete: jest.fn(),
    };
    transforms = new MediaTransformRunner();
    mockDb = { query: {} };

    controller = new StorageController(
      mockDb as never,
      mockStorage as unknown as StorageService,
      mockAudit as unknown as AuditService,
      mockAccess as unknown as AccessService,
      mockScanner as unknown as AvScanner,
      mockQuarantine as never,
      transforms,
    );
  });

  it("rejects infected files with 422 and never plans a key", async () => {
    mockScanner.scan.mockResolvedValue({ status: "infected", threat: "Eicar-Test-Signature" });
    const file = makeFile("image/jpeg", JPEG_MAGIC);

    await expect(
      controller.upload(file, "uploads", makeUser()),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(mockStorage.planUpload).not.toHaveBeenCalled();
  });

  it("rejects scanner errors with 503 and never plans a key", async () => {
    mockScanner.scan.mockResolvedValue({ status: "error", reason: "clamd-unreachable" });
    const file = makeFile("image/jpeg", JPEG_MAGIC);

    await expect(
      controller.upload(file, "uploads", makeUser()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(mockStorage.planUpload).not.toHaveBeenCalled();
  });

  it("proceeds with upload when scanner returns clean", async () => {
    mockScanner.scan.mockResolvedValue({ status: "clean" });
    const file = makeFile("image/jpeg", JPEG_MAGIC);

    const result = await controller.upload(file, "uploads", makeUser());
    await transforms.drain();

    expect(mockStorage.compressToKey).toHaveBeenCalled();
    expect(mockQuarantine.markClean).toHaveBeenCalledWith("qr-1");
    expect(result).toMatchObject({ status: "pending_scan", mimeType: "image/webp" });
  });

  it("scans the uploaded buffer and passes filename and mime type", async () => {
    const file = makeFile("image/jpeg", JPEG_MAGIC, "photo.jpg");
    await controller.upload(file, "uploads", makeUser());

    expect(mockScanner.scan).toHaveBeenCalledWith(JPEG_MAGIC, "photo.jpg", "image/jpeg");
  });

  it("rejects a disallowed mime type before scanning (no unnecessary scan)", async () => {
    const file = makeFile("application/x-executable", Buffer.alloc(12), "malware.exe");
    await expect(
      controller.upload(file, "uploads", makeUser()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockScanner.scan).not.toHaveBeenCalled();
  });

  it("rejects when user quota is exceeded", async () => {
    mockQuarantine.getTotalUsageBytesForUser.mockResolvedValue(500 * 1024 * 1024);
    const file = makeFile("image/jpeg", JPEG_MAGIC);
    file.size = 1024;

    await expect(
      controller.upload(file, "uploads", makeUser()),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(mockScanner.scan).not.toHaveBeenCalled();
  });

  it("cross-tenant: org-A upload does not leak org-B key", async () => {
    mockScanner.scan.mockResolvedValue({ status: "clean" });
    const fileA = makeFile("image/jpeg", JPEG_MAGIC, "a.jpg");
    const fileB = makeFile("image/jpeg", JPEG_MAGIC, "b.jpg");
    mockStorage.planUpload
      .mockResolvedValueOnce({ ...PLAN_RESULT, key: "org-a/uploads/a.jpg" })
      .mockResolvedValueOnce({ ...PLAN_RESULT, key: "org-b/uploads/b.jpg" });

    const resultA = await controller.upload(fileA, "uploads", makeUser("org-a"));
    const resultB = await controller.upload(fileB, "uploads", makeUser("org-b"));

    expect(resultA.key).toContain("org-a");
    expect(resultB.key).toContain("org-b");
    expect(resultA.key).not.toBe(resultB.key);
  });

  it("storage not configured → 503 before scanning", async () => {
    mockStorage.isConfigured.mockReturnValue(false);
    const file = makeFile("image/jpeg", JPEG_MAGIC);
    await expect(controller.upload(file, "uploads", makeUser())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mockScanner.scan).not.toHaveBeenCalled();
  });

  it("mismatched magic bytes → 400 before scanning", async () => {
    const file = makeFile("image/jpeg", PNG_MAGIC, "fake.jpg");
    await expect(controller.upload(file, "uploads", makeUser())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockScanner.scan).not.toHaveBeenCalled();
  });
});
