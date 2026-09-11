import {
  BadRequestException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { OnboardingDocumentsController } from "./storage-onboarding.controller";
import type { StorageService } from "./storage.service";
import type { AvScanner } from "../../common/security/av-scan";
import { MediaTransformRunner } from "./media-transform.runner";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeUser(orgId = "org-1"): CurrentUserContext {
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

function makeFile(partial?: Partial<Express.Multer.File>): Express.Multer.File {
  return {
    buffer: Buffer.from("%PDF-1.4"),
    originalname: "id-doc.pdf",
    mimetype: "application/pdf",
    size: 8,
    ...partial,
  } as Express.Multer.File;
}

function buildTxMock(onboardingStepResult: object | null = null) {
  const insertBuilder = {
    values: jest.fn().mockResolvedValue([]),
  };
  const updateBuilder = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
  };
  return {
    insert: jest.fn().mockReturnValue(insertBuilder),
    update: jest.fn().mockReturnValue(updateBuilder),
    execute: jest.fn().mockResolvedValue([]),
    query: {
      onboardingSteps: {
        findFirst: jest.fn().mockResolvedValue(onboardingStepResult),
      },
    },
  };
}

function buildRelocationSelect() {
  const targets = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  return jest.fn().mockReturnValue(targets);
}

describe("OnboardingDocumentsController.upload — the object write leaves the request thread", () => {
  const callOrder: string[] = [];
  let codec: { promise: Promise<void>; resolve: () => void };

  let mockStorage: jest.Mocked<Pick<StorageService, "isConfigured" | "planUpload" | "compressToKey" | "deleteFileIfPresent">>;
  let mockAvScanner: jest.Mocked<Pick<AvScanner, "scan">>;
  let mockDb: { transaction: jest.Mock; select: jest.Mock };
  let transforms: MediaTransformRunner;
  let controller: OnboardingDocumentsController;

  beforeEach(() => {
    callOrder.length = 0;
    codec = deferred();
    codec.resolve();

    mockStorage = {
      isConfigured: jest.fn().mockReturnValue(true),
      planUpload: jest.fn().mockResolvedValue({
        key: "onboarding/uuid-id-doc.pdf",
        plannedMimeType: "application/pdf",
      }),
      compressToKey: jest.fn().mockImplementation(async () => {
        await codec.promise;
        callOrder.push("upload");
        return { size: 10, mimeType: "application/pdf", sha256: "aa" };
      }),
      deleteFileIfPresent: jest.fn().mockResolvedValue(true),
    };

    mockAvScanner = {
      scan: jest.fn().mockResolvedValue({ status: "clean" }),
    };

    transforms = new MediaTransformRunner();
    const tx = buildTxMock();
    mockDb = {
      select: buildRelocationSelect(),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const result = await fn(tx);
        callOrder.push("db-committed");
        return result;
      }),
    };

    controller = new OnboardingDocumentsController(
      mockDb as never,
      mockStorage as never,
      mockAvScanner as never,
      transforms,
    );
  });

  it("commits the database row before the object is written", async () => {
    await controller.upload(makeFile(), "ID_PROOF", makeUser());
    await transforms.drain();

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["db-committed", "upload"]);
  });

  it("returns the pre-generated tenant-private key without waiting for the object write", async () => {
    codec = deferred();

    const result = await controller.upload(makeFile(), "ID_PROOF", makeUser());

    expect(result).toEqual({ url: "onboarding/uuid-id-doc.pdf" });
    expect(callOrder).toEqual(["db-committed"]);

    codec.resolve();
    await transforms.drain();

    expect(callOrder).toEqual(["db-committed", "upload"]);
  });

  it("deletes the object when the write fails, so a half-written blob never outlives the attempt", async () => {
    mockStorage.compressToKey.mockRejectedValue(new Error("sharp died"));

    const result = await controller.upload(makeFile(), "ID_PROOF", makeUser());
    await transforms.drain();

    expect(result).toEqual({ url: "onboarding/uuid-id-doc.pdf" });
    expect(mockStorage.deleteFileIfPresent).toHaveBeenCalledWith(
      "org-1",
      "onboarding/uuid-id-doc.pdf",
    );
  });

  it("rejects when storage is not configured", async () => {
    mockStorage.isConfigured.mockReturnValue(false);

    await expect(controller.upload(makeFile(), "ID_PROOF", makeUser())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("rejects when no file is provided", async () => {
    await expect(controller.upload(undefined, "ID_PROOF", makeUser())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects a disallowed mime type", async () => {
    const file = makeFile({ mimetype: "text/plain", buffer: Buffer.from("hello") });

    await expect(controller.upload(file, "ID_PROOF", makeUser())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects a document type outside the schema enum", async () => {
    await expect(controller.upload(makeFile(), "NATIONAL_ID", makeUser())).rejects.toThrow(
      "Invalid document type",
    );
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});

describe("OnboardingDocumentsController.upload — AV scan gate", () => {
  let mockStorage: jest.Mocked<Pick<StorageService, "isConfigured" | "planUpload" | "compressToKey" | "deleteFileIfPresent">>;
  let mockAvScanner: jest.Mocked<Pick<AvScanner, "scan">>;
  let mockDb: { transaction: jest.Mock; select: jest.Mock };
  let transforms: MediaTransformRunner;
  let controller: OnboardingDocumentsController;

  beforeEach(() => {
    mockStorage = {
      isConfigured: jest.fn().mockReturnValue(true),
      planUpload: jest.fn().mockResolvedValue({
        key: "onboarding/uuid-id-doc.pdf",
        plannedMimeType: "application/pdf",
      }),
      compressToKey: jest.fn().mockResolvedValue({ size: 10, mimeType: "application/pdf", sha256: "aa" }),
      deleteFileIfPresent: jest.fn().mockResolvedValue(true),
    };

    mockAvScanner = { scan: jest.fn().mockResolvedValue({ status: "clean" }) };

    transforms = new MediaTransformRunner();
    const tx = buildTxMock();
    mockDb = {
      select: buildRelocationSelect(),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    };

    controller = new OnboardingDocumentsController(
      mockDb as never,
      mockStorage as never,
      mockAvScanner as never,
      transforms,
    );
  });

  it("scans the file buffer before any S3 write — clean file proceeds", async () => {
    mockAvScanner.scan.mockResolvedValue({ status: "clean" });

    await controller.upload(makeFile(), "ID_PROOF", makeUser());

    expect(mockAvScanner.scan).toHaveBeenCalledWith(
      expect.any(Buffer),
      "id-doc.pdf",
      "application/pdf",
    );
    expect(mockStorage.planUpload).toHaveBeenCalled();
  });

  it("rejects infected files with 422 and never writes to S3", async () => {
    mockAvScanner.scan.mockResolvedValue({ status: "infected", threat: "Eicar-Test-Signature" });

    await expect(controller.upload(makeFile(), "ID_PROOF", makeUser())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );

    expect(mockStorage.planUpload).not.toHaveBeenCalled();
    expect(mockStorage.compressToKey).not.toHaveBeenCalled();
  });

  it("rejects scanner errors with 503 and never writes to S3", async () => {
    mockAvScanner.scan.mockResolvedValue({ status: "error", reason: "clamd-unreachable" });

    await expect(controller.upload(makeFile(), "ID_PROOF", makeUser())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(mockStorage.planUpload).not.toHaveBeenCalled();
    expect(mockStorage.compressToKey).not.toHaveBeenCalled();
  });

  it("scan happens before the DB transaction — no orphaned rows on infected files", async () => {
    mockAvScanner.scan.mockResolvedValue({ status: "infected", threat: "Eicar-Test-Signature" });

    await expect(controller.upload(makeFile(), "ID_PROOF", makeUser())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
