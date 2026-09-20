jest.mock("sharp", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn().mockImplementation(
    async (_db: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

import { BadRequestException, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { KbMediaService } from "./kb-media.service";
import type { StorageService, UploadResult } from "../../storage/storage.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { KbAttachmentIndexingService } from "../retrieval/kb-attachment-indexing.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { validateEnv } from "../../../config/env.validation";
import type { AvScanner } from "../../../common/security/av-scan";
import type { Db } from "../../../db/drizzle.module";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();

interface AttachmentRow {
  orgId: string;
  pageId: number | null;
  fileKey: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string | null;
  uploadedById: string | null;
}

interface MockDb {
  findFirst: jest.Mock;
  values: jest.Mock;
  onConflictDoNothing: jest.Mock;
  db: Db;
}

/**
 * The insert is a three-link chain (`insert().values().onConflictDoNothing()`)
 * and the page lookup is a relational `query.kbPages.findFirst`. Both are real
 * jest mocks rather than a permissive proxy, so a test can assert the row that
 * was actually written and a missing await shows up as an unresolved promise.
 */
function makeDb(): MockDb {
  const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockReturnValue({ onConflictDoNothing });
  const findFirst = jest.fn().mockResolvedValue({ id: 7 });
  const db = {
    query: { kbPages: { findFirst } },
    insert: jest.fn().mockReturnValue({ values }),
  } as unknown as Db;
  return { findFirst, values, onConflictDoNothing, db };
}

const kbConfig = validateEnv({
  DATABASE_URL: "postgres://test@localhost/kb_media_test",
  BACKEND_JWT_SECRET: "x".repeat(44),
  PORTAL_JWT_SECRET: "x".repeat(44),
  CORS_ORIGINS: "http://localhost",
  APP_URL: "http://localhost:3000",
  ENCRYPTION_KEY: "x".repeat(32),
});

interface MockChain {
  rotate: jest.Mock;
  resize: jest.Mock;
  webp: jest.Mock;
  toBuffer: jest.Mock;
}

const COMPRESSED = Buffer.from([0x01, 0x02, 0x03]);

const MOCK_RESULT: UploadResult = {
  key: "kb-media/org-1/file.webp",
  size: COMPRESSED.length,
  mimeType: "image/webp",
  sha256: "aabbccddeeff00112233445566778899",
};

const JPEG_BUF = Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG_BUF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
const GIF_BUF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const WEBP_BUF = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const MP4_BUF = Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]);
const BAD_BUF = Buffer.alloc(12);

function makeUser(orgId = "org-42"): CurrentUserContext {
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
  originalname = "test.jpg",
): Express.Multer.File {
  return { mimetype, buffer, originalname, size: buffer.length } as unknown as Express.Multer.File;
}

describe("KbMediaService", () => {
  let service: KbMediaService;
  let mockStorage: {
    isConfigured: jest.Mock;
    uploadFile: jest.Mock;
    deleteFileIfPresent: jest.Mock;
  };
  let mockAudit: { log: jest.Mock };
  let mockSharp: jest.Mock;
  let mockChain: MockChain;
  let mockScanner: { scan: jest.Mock };
  let mockDb: MockDb;
  let mockAttachmentIndexing: { indexPageDocument: jest.Mock };

  beforeEach(() => {
    jest.resetAllMocks();

    const runInTenantTransactionMock = jest.requireMock<{
      runInTenantTransaction: jest.Mock;
    }>("../../../common/tenant/run-in-tenant-transaction").runInTenantTransaction;
    runInTenantTransactionMock.mockImplementation(
      async (_db: unknown, fn: () => Promise<unknown>) => fn(),
    );

    mockChain = {
      rotate: jest.fn(),
      resize: jest.fn(),
      webp: jest.fn(),
      toBuffer: jest.fn().mockResolvedValue(COMPRESSED),
    };
    mockChain.rotate.mockReturnValue(mockChain);
    mockChain.resize.mockReturnValue(mockChain);
    mockChain.webp.mockReturnValue(mockChain);

    mockSharp = jest.requireMock<{ default: jest.Mock }>("sharp").default;
    mockSharp.mockReturnValue(mockChain);

    mockStorage = {
      isConfigured: jest.fn().mockReturnValue(true),
      uploadFile: jest.fn().mockResolvedValue(MOCK_RESULT),
      deleteFileIfPresent: jest.fn().mockResolvedValue(true),
    };
    mockAudit = { log: jest.fn() };
    mockScanner = { scan: jest.fn().mockResolvedValue({ status: "clean" }) };
    mockAttachmentIndexing = { indexPageDocument: jest.fn().mockResolvedValue(undefined) };

    mockDb = makeDb();

    service = new KbMediaService(
      mockDb.db,
      mockStorage as unknown as StorageService,
      mockAudit as unknown as AuditService,
      mockAttachmentIndexing as unknown as KbAttachmentIndexingService,
      kbConfig,
      mockScanner as unknown as AvScanner,
    );
  });

  describe("storage not configured", () => {
    it("throws ServiceUnavailableException", async () => {
      mockStorage.isConfigured.mockReturnValue(false);
      await expect(
        service.upload(makeFile("image/jpeg", JPEG_BUF), makeUser()),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe("type validation", () => {
    it("rejects SVG", async () => {
      await expect(
        service.upload(makeFile("image/svg+xml", Buffer.alloc(12)), makeUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects video/avi", async () => {
      await expect(
        service.upload(makeFile("video/avi", Buffer.alloc(12)), makeUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects application/octet-stream", async () => {
      await expect(
        service.upload(makeFile("application/octet-stream", Buffer.alloc(12)), makeUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("size cap validation", () => {
    it("rejects image over 10MB", async () => {
      const big = Buffer.alloc(10 * 1024 * 1024 + 1);
      big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
      await expect(
        service.upload(makeFile("image/jpeg", big), makeUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects audio over 25MB", async () => {
      const big = Buffer.alloc(25 * 1024 * 1024 + 1);
      big[0] = 0x49; big[1] = 0x44; big[2] = 0x33;
      await expect(
        service.upload(makeFile("audio/mpeg", big), makeUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects video over 100MB", async () => {
      const big = Buffer.alloc(100 * 1024 * 1024 + 1);
      big[4] = 0x66; big[5] = 0x74; big[6] = 0x79; big[7] = 0x70;
      await expect(
        service.upload(makeFile("video/mp4", big), makeUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects document over 25MB", async () => {
      const big = Buffer.alloc(25 * 1024 * 1024 + 1);
      big[0] = 0x25; big[1] = 0x50; big[2] = 0x44; big[3] = 0x46;
      await expect(
        service.upload(makeFile("application/pdf", big), makeUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("magic byte validation", () => {
    it("rejects a buffer that does not match the declared mime type", async () => {
      await expect(
        service.upload(makeFile("image/jpeg", BAD_BUF), makeUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a PNG buffer claimed as JPEG", async () => {
      await expect(
        service.upload(makeFile("image/jpeg", PNG_BUF), makeUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("image compression (JPEG)", () => {
    it("calls sharp and uploads with image/webp mime", async () => {
      const result = await service.upload(makeFile("image/jpeg", JPEG_BUF, "photo.jpg"), makeUser());
      expect(mockSharp).toHaveBeenCalledWith(JPEG_BUF, { limitInputPixels: 50_000_000 });
      expect(mockChain.rotate).toHaveBeenCalled();
      expect(mockChain.resize).toHaveBeenCalledWith({ width: 1920, withoutEnlargement: true });
      expect(mockChain.webp).toHaveBeenCalledWith({ quality: 82 });
      expect(mockStorage.uploadFile).toHaveBeenCalledWith(
        "org-42",
        COMPRESSED,
        expect.stringContaining("kb-media/"),
        "photo.webp",
        "image/webp",
        undefined,
      );
      expect(result.name).toBe("photo.jpg");
    });

    it("returns BadRequestException when sharp throws", async () => {
      mockChain.toBuffer.mockRejectedValue(new Error("corrupt"));
      await expect(
        service.upload(makeFile("image/jpeg", JPEG_BUF), makeUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("logs the decoder's own reason, so a 400 on a valid-looking image is diagnosable at all", async () => {
      const logged = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      mockChain.toBuffer.mockRejectedValue(new Error("VipsJpeg: Premature end of input file"));

      await expect(
        service.upload(makeFile("image/jpeg", JPEG_BUF, "holiday.jpg"), makeUser()),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining("VipsJpeg: Premature end of input file"),
      );
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("holiday.jpg"));
      logged.mockRestore();
    });

    it("names the megapixel ceiling rather than calling an oversized but valid photo invalid", async () => {
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      mockChain.toBuffer.mockRejectedValue(new Error("Input image exceeds pixel limit"));

      await expect(
        service.upload(makeFile("image/jpeg", JPEG_BUF, "panorama.jpg"), makeUser()),
      ).rejects.toMatchObject({
        message: "Image is larger than the 50 megapixel processing limit",
      });
    });

    it("still calls a genuinely undecodable file invalid", async () => {
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      mockChain.toBuffer.mockRejectedValue(new Error("unsupported image format"));

      await expect(
        service.upload(makeFile("image/jpeg", JPEG_BUF), makeUser()),
      ).rejects.toMatchObject({ message: "Invalid image file" });
    });
  });

  describe("image compression (PNG)", () => {
    it("compresses PNG to webp and renames extension", async () => {
      await service.upload(makeFile("image/png", PNG_BUF, "banner.png"), makeUser());
      expect(mockSharp).toHaveBeenCalledWith(PNG_BUF, { limitInputPixels: 50_000_000 });
      expect(mockStorage.uploadFile).toHaveBeenCalledWith(
        "org-42",
        COMPRESSED,
        expect.any(String),
        "banner.webp",
        "image/webp",
        undefined,
      );
    });
  });

  describe("GIF passthrough (animation preservation)", () => {
    it("does not call sharp for gif", async () => {
      await service.upload(makeFile("image/gif", GIF_BUF, "anim.gif"), makeUser());
      expect(mockSharp).not.toHaveBeenCalled();
    });

    it("uploads GIF with original mime type", async () => {
      mockStorage.uploadFile.mockResolvedValue({ ...MOCK_RESULT, mimeType: "image/gif" });
      await service.upload(makeFile("image/gif", GIF_BUF, "anim.gif"), makeUser());
      expect(mockStorage.uploadFile).toHaveBeenCalledWith(
        "org-42",
        GIF_BUF,
        expect.any(String),
        "anim.gif",
        "image/gif",
        undefined,
      );
    });
  });

  describe("video passthrough", () => {
    it("does not call sharp for mp4", async () => {
      mockStorage.uploadFile.mockResolvedValue({ ...MOCK_RESULT, mimeType: "video/mp4" });
      await service.upload(makeFile("video/mp4", MP4_BUF, "clip.mp4"), makeUser());
      expect(mockSharp).not.toHaveBeenCalled();
      expect(mockStorage.uploadFile).toHaveBeenCalledWith(
        "org-42",
        MP4_BUF,
        expect.any(String),
        "clip.mp4",
        "video/mp4",
        undefined,
      );
    });
  });

  describe("org-scoped folder", () => {
    it("uploads to kb-media/<orgId>", async () => {
      await service.upload(makeFile("image/jpeg", JPEG_BUF, "pic.jpg"), makeUser("tenant-xyz"));
      expect(mockStorage.uploadFile).toHaveBeenCalledWith(
        "tenant-xyz",
        expect.any(Buffer),
        "kb-media/tenant-xyz",
        expect.any(String),
        expect.any(String),
        undefined,
      );
    });

    it("different org gets a different folder", async () => {
      await service.upload(makeFile("image/jpeg", JPEG_BUF), makeUser("org-other"));
      expect(mockStorage.uploadFile).toHaveBeenCalledWith(
        "org-other",
        expect.any(Buffer),
        "kb-media/org-other",
        expect.any(String),
        expect.any(String),
        undefined,
      );
    });
  });

  describe("wire contract", () => {
    it("returns the object key and no field named url", async () => {
      const result = await service.upload(makeFile("image/jpeg", JPEG_BUF, "photo.jpg"), makeUser());
      expect(result.key).toBe(MOCK_RESULT.key);
      expect(result).not.toHaveProperty("url");
    });
  });

  describe("audit logging", () => {
    it("logs kb.media_upload action with file metadata", async () => {
      await service.upload(makeFile("image/jpeg", JPEG_BUF), makeUser("org-log"));
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "kb.media_upload",
          userId: "user-1",
          orgId: "org-log",
        }),
      );
    });
  });

  describe("WEBP passthrough (already webp)", () => {
    it("compresses webp input through sharp pipeline", async () => {
      await service.upload(makeFile("image/webp", WEBP_BUF, "img.webp"), makeUser());
      expect(mockSharp).toHaveBeenCalledWith(WEBP_BUF, { limitInputPixels: 50_000_000 });
      expect(mockStorage.uploadFile).toHaveBeenCalledWith(
        "org-42",
        COMPRESSED,
        expect.any(String),
        "img.webp",
        "image/webp",
        undefined,
      );
    });
  });

  describe("malware scan gate", () => {
    it("rejects infected files with 422 and does NOT upload to storage", async () => {
      mockScanner.scan.mockResolvedValue({ status: "infected", threat: "Eicar-Test-Signature" });
      await expect(
        service.upload(makeFile("image/jpeg", JPEG_BUF), makeUser()),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    });

    it("rejects scanner errors with 503 and does NOT upload to storage", async () => {
      mockScanner.scan.mockResolvedValue({ status: "error", reason: "clamd-unreachable" });
      await expect(
        service.upload(makeFile("image/jpeg", JPEG_BUF), makeUser()),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    });

    it("scans the original buffer before compression", async () => {
      await service.upload(makeFile("image/jpeg", JPEG_BUF, "photo.jpg"), makeUser());
      expect(mockScanner.scan).toHaveBeenCalledWith(JPEG_BUF, "photo.jpg", "image/jpeg");
    });

    it("proceeds with upload when scanner returns clean", async () => {
      mockScanner.scan.mockResolvedValue({ status: "clean" });
      await service.upload(makeFile("image/jpeg", JPEG_BUF, "photo.jpg"), makeUser());
      expect(mockStorage.uploadFile).toHaveBeenCalled();
    });

    it("noop scanner (no AV_SCANNER set) behaves fail-open — upload proceeds", async () => {
      mockScanner.scan.mockResolvedValue({ status: "clean" });
      const result = await service.upload(makeFile("image/jpeg", JPEG_BUF), makeUser());
      expect(result).toBeDefined();
      expect(mockStorage.uploadFile).toHaveBeenCalled();
    });

    it("cross-tenant: org-A cannot receive org-B storage key", async () => {
      const orgA = makeUser("org-a");
      const orgB = makeUser("org-b");
      mockStorage.uploadFile
        .mockResolvedValueOnce({ ...MOCK_RESULT, key: "kb-media/org-a/file.webp" })
        .mockResolvedValueOnce({ ...MOCK_RESULT, key: "kb-media/org-b/file.webp" });

      const resultA = await service.upload(makeFile("image/jpeg", JPEG_BUF), orgA);
      const resultB = await service.upload(makeFile("image/jpeg", JPEG_BUF), orgB);

      expect(resultA.key).toContain("org-a");
      expect(resultB.key).toContain("org-b");
      expect(resultA.key).not.toBe(resultB.key);
    });
  });

  describe("attachment ledger — the row that gives the object an org", () => {
    function writtenRow(): AttachmentRow {
      const [row] = mockDb.values.mock.calls[0] as [AttachmentRow];
      return row;
    }

    it("records the upload with its org, storage key and measured bytes", async () => {
      await service.upload(makeFile("image/jpeg", JPEG_BUF, "photo.jpg"), makeUser("org-42"), 7);

      expect(mockDb.values).toHaveBeenCalledTimes(1);
      expect(writtenRow()).toEqual({
        orgId: "org-42",
        pageId: 7,
        fileKey: MOCK_RESULT.key,
        fileName: "photo.jpg",
        mimeType: MOCK_RESULT.mimeType,
        fileSize: MOCK_RESULT.size,
        sha256: MOCK_RESULT.sha256,
        uploadedById: "user-1",
      });
    });

    it("an upload with no page records page_id null and never looks a page up", async () => {
      await service.upload(makeFile("image/jpeg", JPEG_BUF), makeUser("org-42"));

      expect(mockDb.findFirst).not.toHaveBeenCalled();
      expect(writtenRow().pageId).toBeNull();
    });

    it("BITE — a page id the caller's org does not own is 404, and nothing is uploaded or recorded", async () => {
      mockDb.findFirst.mockResolvedValue(undefined);

      await expect(
        service.upload(makeFile("image/jpeg", JPEG_BUF), makeUser("org-a"), 999),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(mockStorage.uploadFile).not.toHaveBeenCalled();
      expect(mockDb.values).not.toHaveBeenCalled();
    });

    it("BITE — the miss is 404 and never 403, so it cannot confirm the page exists", async () => {
      mockDb.findFirst.mockResolvedValue(undefined);

      await expect(
        service.upload(makeFile("image/jpeg", JPEG_BUF), makeUser("org-a"), 999),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("the page lookup binds the caller org and excludes soft-deleted pages", async () => {
      await service.upload(makeFile("image/jpeg", JPEG_BUF), makeUser("org-42"), 7);

      const [args] = mockDb.findFirst.mock.calls[0] as [{ where: SQL }];
      const query = dialect.sqlToQuery(args.where);
      expect(query.sql).toContain('"org_id"');
      expect(query.sql).toContain('"deleted_at" is null');
      expect(query.params).toContain("org-42");
      expect(query.params).toContain(7);
    });

    it("re-recording the same object key is a no-op, not a second row", async () => {
      await service.upload(makeFile("image/jpeg", JPEG_BUF), makeUser("org-42"), 7);
      expect(mockDb.onConflictDoNothing).toHaveBeenCalledTimes(1);
      const [conflict] = mockDb.onConflictDoNothing.mock.calls[0] as [{ target: unknown[] }];
      expect(conflict.target).toHaveLength(2);
    });

    it("the row is written before the response, so a failed insert fails the upload", async () => {
      mockDb.onConflictDoNothing.mockRejectedValue(new Error("insert failed"));
      await expect(
        service.upload(makeFile("image/jpeg", JPEG_BUF), makeUser("org-42"), 7),
      ).rejects.toThrow("insert failed");
    });
  });

  describe("document indexing — a PDF upload linked to a page triggers attachment indexing even when there is no ambient tenant transaction", () => {
    const PDF_BUF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0, 0, 0]);

    it("indexPageDocument is called with the org, page id, original buffer and mime type", async () => {
      mockStorage.uploadFile.mockResolvedValue({ ...MOCK_RESULT, mimeType: "application/pdf" });

      await service.upload(makeFile("application/pdf", PDF_BUF, "spec.pdf"), makeUser("org-42"), 7);

      expect(mockAttachmentIndexing.indexPageDocument).toHaveBeenCalledTimes(1);
      expect(mockAttachmentIndexing.indexPageDocument).toHaveBeenCalledWith(
        "org-42",
        7,
        PDF_BUF,
        "application/pdf",
        "spec.pdf",
      );
    });

    it("a PDF upload with no pageId does not trigger indexing", async () => {
      mockStorage.uploadFile.mockResolvedValue({ ...MOCK_RESULT, mimeType: "application/pdf" });

      await service.upload(makeFile("application/pdf", PDF_BUF, "spec.pdf"), makeUser("org-42"));

      expect(mockAttachmentIndexing.indexPageDocument).not.toHaveBeenCalled();
    });

    it("an image upload with a pageId does not trigger indexing", async () => {
      await service.upload(makeFile("image/jpeg", JPEG_BUF, "photo.jpg"), makeUser("org-42"), 7);

      expect(mockAttachmentIndexing.indexPageDocument).not.toHaveBeenCalled();
    });
  });
});
