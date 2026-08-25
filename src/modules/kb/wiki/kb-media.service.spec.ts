jest.mock("sharp", () => ({ __esModule: true, default: jest.fn() }));

import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { KbMediaService } from "./kb-media.service";
import type { StorageService, UploadResult } from "../../storage/storage.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { KbIndexingService } from "../retrieval/kb-indexing.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { validateEnv } from "../../../config/env.validation";

const kbConfig = validateEnv({
  DATABASE_URL: "postgres://test",
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
  url: "https://cdn.example.com/kb-media/org-1/file.webp",
  key: "kb-media/org-1/file.webp",
  size: COMPRESSED.length,
  mimeType: "image/webp",
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
  let mockStorage: { isConfigured: jest.Mock; uploadFile: jest.Mock };
  let mockAudit: { log: jest.Mock };
  let mockSharp: jest.Mock;
  let mockChain: MockChain;

  beforeEach(() => {
    jest.clearAllMocks();

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
    };
    mockAudit = { log: jest.fn() };

    const mockIndexing = {} as unknown as KbIndexingService;

    service = new KbMediaService(
      mockStorage as unknown as StorageService,
      mockAudit as unknown as AuditService,
      mockIndexing,
      kbConfig,
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
      expect(mockSharp).toHaveBeenCalledWith(JPEG_BUF);
      expect(mockChain.rotate).toHaveBeenCalled();
      expect(mockChain.resize).toHaveBeenCalledWith({ width: 1920, withoutEnlargement: true });
      expect(mockChain.webp).toHaveBeenCalledWith({ quality: 82 });
      expect(mockStorage.uploadFile).toHaveBeenCalledWith(
        COMPRESSED,
        expect.stringContaining("kb-media/"),
        "photo.webp",
        "image/webp",
        undefined,
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
  });

  describe("image compression (PNG)", () => {
    it("compresses PNG to webp and renames extension", async () => {
      await service.upload(makeFile("image/png", PNG_BUF, "banner.png"), makeUser());
      expect(mockSharp).toHaveBeenCalledWith(PNG_BUF);
      expect(mockStorage.uploadFile).toHaveBeenCalledWith(
        COMPRESSED,
        expect.any(String),
        "banner.webp",
        "image/webp",
        undefined,
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
        GIF_BUF,
        expect.any(String),
        "anim.gif",
        "image/gif",
        undefined,
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
        MP4_BUF,
        expect.any(String),
        "clip.mp4",
        "video/mp4",
        undefined,
        undefined,
      );
    });
  });

  describe("org-scoped folder", () => {
    it("uploads to kb-media/<orgId>", async () => {
      await service.upload(makeFile("image/jpeg", JPEG_BUF, "pic.jpg"), makeUser("tenant-xyz"));
      expect(mockStorage.uploadFile).toHaveBeenCalledWith(
        expect.any(Buffer),
        "kb-media/tenant-xyz",
        expect.any(String),
        expect.any(String),
        undefined,
        undefined,
      );
    });

    it("different org gets a different folder", async () => {
      await service.upload(makeFile("image/jpeg", JPEG_BUF), makeUser("org-other"));
      expect(mockStorage.uploadFile).toHaveBeenCalledWith(
        expect.any(Buffer),
        "kb-media/org-other",
        expect.any(String),
        expect.any(String),
        undefined,
        undefined,
      );
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
      expect(mockSharp).toHaveBeenCalledWith(WEBP_BUF);
      expect(mockStorage.uploadFile).toHaveBeenCalledWith(
        COMPRESSED,
        expect.any(String),
        "img.webp",
        "image/webp",
        undefined,
        undefined,
      );
    });
  });
});
