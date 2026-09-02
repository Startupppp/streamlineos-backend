import { ServiceUnavailableException } from "@nestjs/common";
import { MediaTransformRunner, type MediaTransformJob } from "./media-transform.runner";
import { StorageController } from "./storage.controller";
import type { StorageService } from "./storage.service";
import type { AuditService } from "../../common/audit/audit.service";
import type { AccessService } from "../access/access.service";
import type { AvScanner } from "../../common/security/av-scan";
import type { FileQuarantineService } from "./file-quarantine.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function job(overrides: Partial<MediaTransformJob> = {}): MediaTransformJob {
  return {
    name: "test",
    orgId: "org-1",
    run: async () => undefined,
    compensate: async () => undefined,
    ...overrides,
  };
}

describe("MediaTransformRunner — the bound is the point, not the asynchrony", () => {
  it("never runs more than the concurrency ceiling at once", async () => {
    const runner = new MediaTransformRunner();
    let peak = 0;
    let live = 0;
    const gate = deferred();

    for (let i = 0; i < 8; i++) {
      runner.submit(
        job({
          run: async () => {
            live++;
            peak = Math.max(peak, live);
            await gate.promise;
            live--;
          },
        }),
      );
    }

    expect(runner.stats().active).toBe(2);
    gate.resolve();
    await runner.drain();

    expect(peak).toBe(2);
    expect(runner.stats().active).toBe(0);
    expect(runner.stats().queued).toBe(0);
  });

  it("REFUSES submission past the queue depth instead of growing without limit", async () => {
    const runner = new MediaTransformRunner();
    const gate = deferred();
    const accepted: boolean[] = [];

    for (let i = 0; i < 40; i++)
      accepted.push(runner.submit(job({ run: () => gate.promise })));

    const refused = accepted.filter((a) => a === false).length;
    expect(refused).toBeGreaterThan(0);
    expect(runner.stats().rejected).toBe(refused);
    /**
     * The bound is what makes this a job runner rather than a leak: two running
     * plus at most MAX_QUEUED waiting, never forty buffers held at once.
     */
    expect(runner.stats().active + runner.stats().queued).toBeLessThanOrEqual(34);

    gate.resolve();
    await runner.drain();
  });

  it("compensates a failing job rather than swallowing it, and releases the slot", async () => {
    const runner = new MediaTransformRunner();
    const compensated: string[] = [];

    runner.submit(
      job({
        name: "boom",
        run: async () => {
          throw new Error("transform blew up");
        },
        compensate: async (error) => {
          compensated.push(error.message);
        },
      }),
    );

    await runner.drain();

    expect(compensated).toEqual(["transform blew up"]);
    expect(runner.stats().failed).toBe(1);
    expect(runner.stats().active).toBe(0);
  });

  it("a job that never settles is still compensated and does not hold its slot forever", async () => {
    jest.useFakeTimers();
    const runner = new MediaTransformRunner();
    let compensatedWith = "";

    runner.submit(
      job({
        name: "wedged",
        run: () => new Promise<void>(() => undefined),
        compensate: async (error) => {
          compensatedWith = error.message;
        },
      }),
    );

    await Promise.resolve();
    jest.advanceTimersByTime(60_001);
    jest.useRealTimers();
    await runner.drain();

    expect(compensatedWith).toContain("exceeded");
    expect(runner.stats().active).toBe(0);
  });
});

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

function makeFile(): Express.Multer.File {
  return {
    mimetype: "image/jpeg",
    buffer: JPEG_MAGIC,
    originalname: "photo.jpg",
    size: JPEG_MAGIC.length,
    fieldname: "file",
    encoding: "7bit",
  } as unknown as Express.Multer.File;
}

function buildUploadController(
  runner: MediaTransformRunner,
  storageOverrides: Record<string, unknown> = {},
): {
  controller: StorageController;
  storage: Record<string, jest.Mock>;
  quarantine: Record<string, jest.Mock>;
} {
  const storage = {
    isConfigured: jest.fn().mockReturnValue(true),
    planUpload: jest
      .fn()
      .mockResolvedValue({ key: "org-1/uploads/uuid-photo.webp", plannedMimeType: "image/webp" }),
    compressToKey: jest
      .fn()
      .mockResolvedValue({ size: 7, mimeType: "image/webp", sha256: "stored" }),
    deleteFileIfPresent: jest.fn().mockResolvedValue(true),
    uploadToKey: jest.fn(),
    ...storageOverrides,
  } as unknown as Record<string, jest.Mock>;

  const quarantine = {
    begin: jest.fn().mockResolvedValue("qr-1"),
    markClean: jest.fn().mockResolvedValue(undefined),
    markError: jest.fn().mockResolvedValue(undefined),
    markInfected: jest.fn().mockResolvedValue(undefined),
    softDelete: jest.fn().mockResolvedValue(undefined),
    recordMeasuredObject: jest.fn().mockResolvedValue(undefined),
    isKeyBlocked: jest.fn().mockResolvedValue(false),
    getTotalUsageBytes: jest.fn().mockResolvedValue(0),
    getTotalUsageBytesForUser: jest.fn().mockResolvedValue(0),
  } as unknown as Record<string, jest.Mock>;

  const controller = new StorageController(
    { query: {} } as never,
    storage as unknown as StorageService,
    { log: jest.fn() } as unknown as AuditService,
    { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService,
    { scan: jest.fn().mockResolvedValue({ status: "clean" }) } as unknown as AvScanner,
    quarantine as unknown as FileQuarantineService,
    runner,
  );

  return { controller, storage, quarantine };
}

describe("POST /storage/upload — no transform runs on the request thread", () => {
  it("responds while the transform is still running, and finishes it afterwards", async () => {
    const runner = new MediaTransformRunner();
    const codec = deferred();
    const { controller, storage, quarantine } = buildUploadController(runner, {
      compressToKey: jest.fn().mockImplementation(async () => {
        await codec.promise;
        return { size: 7, mimeType: "image/webp", sha256: "stored" };
      }),
    });

    /**
     * The transform is deliberately never allowed to finish before the
     * assertion. If any part of the upload awaited it, this line would hang
     * rather than resolve — which is the whole claim of the box: the caller
     * waits on validation and the malware scan, never on a codec.
     */
    const result = await controller.upload(makeFile(), "uploads", makeUser());

    expect(quarantine.markClean).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "pending_scan", key: "org-1/uploads/uuid-photo.webp" });

    codec.resolve();
    await runner.drain();

    expect(storage.compressToKey).toHaveBeenCalledTimes(1);
    expect(quarantine.recordMeasuredObject).toHaveBeenCalledWith("qr-1", {
      fileSizeBytes: 7,
      mimeType: "image/webp",
    });
    expect(quarantine.markClean).toHaveBeenCalledWith("qr-1");
  });

  it("writes no derived preview object — a thumbnail nothing reads is an orphan erasure cannot reach", async () => {
    const runner = new MediaTransformRunner();
    const { controller, storage } = buildUploadController(runner);

    await controller.upload(makeFile(), "uploads", makeUser());
    await runner.drain();

    const writtenKeys = [
      ...storage.compressToKey.mock.calls.map((call) => String(call[2])),
      ...storage.uploadToKey.mock.calls.map((call) => String(call[2])),
    ];
    expect(writtenKeys).toEqual(["org-1/uploads/uuid-photo.webp"]);
    expect(writtenKeys.some((key) => key.includes("thumb"))).toBe(false);
  });

  it("a failed transform deletes the object BEFORE the row, so nothing is published half-written", async () => {
    const runner = new MediaTransformRunner();
    const order: string[] = [];
    const { controller, storage, quarantine } = buildUploadController(runner, {
      compressToKey: jest.fn().mockRejectedValue(new Error("sharp died")),
      deleteFileIfPresent: jest.fn().mockImplementation(async () => {
        order.push("object-deleted");
        return true;
      }),
    });
    quarantine.softDelete.mockImplementation(async () => {
      order.push("row-soft-deleted");
    });

    await controller.upload(makeFile(), "uploads", makeUser());
    await runner.drain();

    expect(quarantine.markError).toHaveBeenCalledWith("qr-1");
    expect(order).toEqual(["object-deleted", "row-soft-deleted"]);
    expect(quarantine.markClean).not.toHaveBeenCalled();
    expect(storage.deleteFileIfPresent).toHaveBeenCalledWith("org-1", "org-1/uploads/uuid-photo.webp");
  });

  it("refuses the upload with 503 when the runner is saturated, before scanning or writing a row", async () => {
    const runner = new MediaTransformRunner();
    const gate = deferred();
    while (runner.submit(job({ run: () => gate.promise })));

    const { controller, storage, quarantine } = buildUploadController(runner);

    await expect(
      controller.upload(makeFile(), "uploads", makeUser()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(quarantine.begin).not.toHaveBeenCalled();
    expect(storage.planUpload).not.toHaveBeenCalled();

    gate.resolve();
    await runner.drain();
  });
});
