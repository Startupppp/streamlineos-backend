import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { StorageMultipartController } from "./storage-multipart.controller";
import type { StorageService } from "./storage.service";
import type { StorageMultipartService } from "./storage-multipart.service";
import type {
  FileQuarantineService,
  QuarantineRecord,
} from "./file-quarantine.service";
import type { AuditService } from "../../common/audit/audit.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";

const KEY = "org-1/video/uuid-clip.mp4";
const UPLOAD_ID = "upload-id-abc";
const MP4_PREFIX = Buffer.from([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function pendingRecord(overrides: Partial<QuarantineRecord> = {}): QuarantineRecord {
  return {
    id: "qr-uuid-1",
    orgId: "org-1",
    storageKey: KEY,
    filename: "clip.mp4",
    mimeType: "video/mp4",
    fileSizeBytes: 4_000_000,
    sha256: "",
    status: "pending_scan",
    threatName: null,
    idempotencyKey: UPLOAD_ID,
    uploadedBy: "user-1",
    createdAt: new Date(),
    ...overrides,
  };
}

function buildController(options: {
  existing?: QuarantineRecord | null;
  completion?: "completed" | "already-completed" | "unknown-upload";
  described?: { contentLength: number; contentType: string } | null;
  prefix?: Buffer | null;
} = {}) {
  const storage = {
    isConfigured: jest.fn().mockReturnValue(true),
    isValidFileKey: jest.fn().mockReturnValue(true),
    describeObject: jest
      .fn()
      .mockResolvedValue(
        options.described === undefined
          ? { contentLength: 4_000_000, contentType: "video/mp4" }
          : options.described,
      ),
    readObjectPrefix: jest
      .fn()
      .mockResolvedValue(options.prefix === undefined ? MP4_PREFIX : options.prefix),
    deleteFileIfPresent: jest.fn().mockResolvedValue(true),
  };
  const multipart = {
    initiate: jest
      .fn()
      .mockResolvedValue({ uploadId: UPLOAD_ID, key: KEY, partUrls: [] }),
    complete: jest.fn().mockResolvedValue(options.completion ?? "completed"),
    abort: jest.fn().mockResolvedValue(undefined),
  };
  const quarantine = {
    getTotalUsageBytes: jest.fn().mockResolvedValue(0),
    getTotalUsageBytesForUser: jest.fn().mockResolvedValue(0),
    begin: jest.fn().mockResolvedValue("qr-uuid-1"),
    markClean: jest.fn().mockResolvedValue(undefined),
    softDelete: jest.fn().mockResolvedValue(undefined),
    recordMeasuredObject: jest.fn().mockResolvedValue(undefined),
    findByIdempotencyKey: jest
      .fn()
      .mockResolvedValue(options.existing === undefined ? null : options.existing),
  };
  const audit: Pick<AuditService, "log"> = { log: jest.fn() };

  const controller = new StorageMultipartController(
    storage as unknown as StorageService,
    multipart as unknown as StorageMultipartService,
    quarantine as unknown as FileQuarantineService,
    audit as never,
  );
  return { controller, storage, multipart, quarantine, audit };
}

const COMPLETE_BODY = {
  key: KEY,
  uploadId: UPLOAD_ID,
  parts: [{ partNumber: 1, eTag: '"abc123"' }],
};

describe("StorageMultipartController.initiate — quarantine before the object exists", () => {
  it("opens the quarantine record at initiate, keyed to the upload id", async () => {
    const { controller, quarantine } = buildController();

    const result = await controller.initiate(
      {
        folder: "video",
        fileName: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 4_000_000,
        partCount: 1,
      },
      makeUser(),
    );

    expect(quarantine.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        storageKey: KEY,
        idempotencyKey: UPLOAD_ID,
        fileSizeBytes: 4_000_000,
      }),
    );
    expect(result.quarantineId).toBe("qr-uuid-1");
  });

  it("refuses a declared size that would breach the organization quota", async () => {
    const { controller, quarantine, multipart } = buildController();
    quarantine.getTotalUsageBytes.mockResolvedValue(5 * 1024 * 1024 * 1024);

    await expect(
      controller.initiate(
        {
          folder: "video",
          fileName: "clip.mp4",
          mimeType: "video/mp4",
          sizeBytes: 4_000_000,
          partCount: 1,
        },
        makeUser(),
      ),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(multipart.initiate).not.toHaveBeenCalled();
  });
});

describe("StorageMultipartController.complete — AV quarantine gate", () => {
  it("does NOT call markClean on complete — multipart bytes bypass the backend scanner", async () => {
    const { controller, quarantine } = buildController({ existing: pendingRecord() });

    const result = await controller.complete(COMPLETE_BODY, makeUser());

    expect(quarantine.markClean).not.toHaveBeenCalled();
    expect(result.status).toBe("pending_scan");
  });

  it("reuses the quarantine record opened at initiate instead of writing a second one", async () => {
    const { controller, quarantine } = buildController({ existing: pendingRecord() });

    const result = await controller.complete(COMPLETE_BODY, makeUser());

    expect(quarantine.begin).not.toHaveBeenCalled();
    expect(result.quarantineId).toBe("qr-uuid-1");
  });

  it("opens a quarantine record when completion arrives without one", async () => {
    const { controller, quarantine } = buildController({ existing: null });

    const result = await controller.complete(COMPLETE_BODY, makeUser());

    expect(quarantine.begin).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", storageKey: KEY }),
    );
    expect(result.quarantineId).toBe("qr-uuid-1");
  });

  it("rejects a key that does not belong to the caller's org", async () => {
    const { controller } = buildController();
    const crossTenantBody = { ...COMPLETE_BODY, key: "org-other/video/file.mp4" };

    await expect(controller.complete(crossTenantBody, makeUser())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects when storage is not configured", async () => {
    const { controller, storage } = buildController();
    storage.isConfigured.mockReturnValue(false);

    await expect(controller.complete(COMPLETE_BODY, makeUser())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe("StorageMultipartController.complete — idempotent retry", () => {
  it("replays the first result instead of duplicating the record", async () => {
    const { controller, quarantine, multipart } = buildController({
      existing: pendingRecord({ status: "clean" }),
    });

    const result = await controller.complete(COMPLETE_BODY, makeUser());

    expect(result).toEqual(
      expect.objectContaining({ quarantineId: "qr-uuid-1", replayed: true }),
    );
    expect(quarantine.begin).not.toHaveBeenCalled();
    expect(multipart.complete).not.toHaveBeenCalled();
  });

  it("treats a provider NoSuchUpload with a stored object as an already-completed retry", async () => {
    const { controller, quarantine } = buildController({
      existing: pendingRecord(),
      completion: "already-completed",
    });

    const result = await controller.complete(COMPLETE_BODY, makeUser());

    expect(result.replayed).toBe(true);
    expect(quarantine.begin).not.toHaveBeenCalled();
  });

  it("404s a completion for an upload id nothing knows about", async () => {
    const { controller } = buildController({
      existing: null,
      completion: "unknown-upload",
    });

    await expect(controller.complete(COMPLETE_BODY, makeUser())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("StorageMultipartController.complete — the stored object is measured, not trusted", () => {
  it("rejects and removes an object whose bytes do not match the declared type", async () => {
    const { controller, storage, quarantine } = buildController({
      existing: pendingRecord(),
      prefix: Buffer.from("MZ  not-a-video"),
    });

    await expect(controller.complete(COMPLETE_BODY, makeUser())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(storage.deleteFileIfPresent).toHaveBeenCalledWith("org-1", KEY);
    expect(quarantine.softDelete).toHaveBeenCalledWith("qr-uuid-1");
  });

  it("records the measured size rather than the declared one", async () => {
    const { controller, quarantine } = buildController({
      existing: pendingRecord({ fileSizeBytes: 1 }),
      described: { contentLength: 9_000_000, contentType: "video/mp4" },
    });

    await controller.complete(COMPLETE_BODY, makeUser());

    expect(quarantine.recordMeasuredObject).toHaveBeenCalledWith("qr-uuid-1", {
      fileSizeBytes: 9_000_000,
      mimeType: "video/mp4",
    });
  });

  it("rejects and removes an object that breaches the organization quota once measured", async () => {
    const { controller, storage } = buildController({
      existing: pendingRecord(),
      described: { contentLength: 4_000_000, contentType: "video/mp4" },
    });
    (
      controller as unknown as {
        quarantine: { getTotalUsageBytes: jest.Mock };
      }
    ).quarantine.getTotalUsageBytes.mockResolvedValue(5 * 1024 * 1024 * 1024);

    await expect(controller.complete(COMPLETE_BODY, makeUser())).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
    expect(storage.deleteFileIfPresent).toHaveBeenCalledWith("org-1", KEY);
  });
});

describe("StorageMultipartController.abort — cancellation cleans both halves", () => {
  it("removes the object and the quarantine row", async () => {
    const { controller, storage, multipart, quarantine } = buildController({
      existing: pendingRecord(),
    });

    await controller.abort({ key: KEY, uploadId: UPLOAD_ID }, makeUser());

    expect(multipart.abort).toHaveBeenCalledWith("org-1", KEY, UPLOAD_ID);
    expect(storage.deleteFileIfPresent).toHaveBeenCalledWith("org-1", KEY);
    expect(quarantine.softDelete).toHaveBeenCalledWith("qr-uuid-1");
  });

  it("refuses to abort a key belonging to another organization", async () => {
    const { controller, multipart } = buildController();

    await expect(
      controller.abort({ key: "org-other/video/f.mp4", uploadId: UPLOAD_ID }, makeUser()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(multipart.abort).not.toHaveBeenCalled();
  });
});
