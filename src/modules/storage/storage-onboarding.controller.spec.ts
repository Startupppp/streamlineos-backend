import {
  BadRequestException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { OnboardingDocumentsController } from "./storage-onboarding.controller";
import type { StorageService } from "./storage.service";
import type { AvScanner } from "../../common/security/av-scan";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import * as tenantContext from "../../common/tenant/tenant-context";

jest.mock("../../common/tenant/tenant-context", () => ({
  registerAfterCommit: jest.fn().mockReturnValue(false),
}));

const mockRegisterAfterCommit = tenantContext.registerAfterCommit as jest.MockedFunction<
  typeof tenantContext.registerAfterCommit
>;

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
    query: {
      onboardingSteps: {
        findFirst: jest.fn().mockResolvedValue(onboardingStepResult),
      },
    },
  };
}

describe("OnboardingDocumentsController.upload — connection decoupling", () => {
  const callOrder: string[] = [];

  let mockStorage: jest.Mocked<Pick<StorageService, "isConfigured" | "compressAndPreGenerateKey" | "uploadToKey">>;
  let mockAvScanner: jest.Mocked<Pick<AvScanner, "scan">>;
  let mockDb: { transaction: jest.Mock };
  let controller: OnboardingDocumentsController;

  beforeEach(() => {
    callOrder.length = 0;
    mockRegisterAfterCommit.mockClear();
    mockRegisterAfterCommit.mockReturnValue(false);

    mockStorage = {
      isConfigured: jest.fn().mockReturnValue(true),
      compressAndPreGenerateKey: jest.fn().mockResolvedValue({
        key: "onboarding/uuid-id-doc.pdf",
        compressedBuffer: Buffer.from("compressed"),
        compressedMimeType: "application/pdf",
        size: 10,
      }),
      uploadToKey: jest.fn().mockImplementation(async () => {
        callOrder.push("upload");
      }),
    };

    mockAvScanner = {
      scan: jest.fn().mockResolvedValue({ status: "clean" }),
    };

    const tx = buildTxMock();
    mockDb = {
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
    );
  });

  it("commits the database row before the upload is attempted when no ambient tenant context exists", async () => {
    mockRegisterAfterCommit.mockReturnValue(false);

    await controller.upload(makeFile(), "ID_PROOF", makeUser());

    expect(callOrder).toEqual(["db-committed", "upload"]);
  });

  it("defers the upload to after the transaction when an ambient context is present", async () => {
    let capturedHook: (() => Promise<unknown>) | null = null;
    mockRegisterAfterCommit.mockImplementation((hook) => {
      capturedHook = hook;
      return true;
    });

    const result = await controller.upload(makeFile(), "ID_PROOF", makeUser());

    expect(callOrder).toEqual(["db-committed"]);
    expect(capturedHook).not.toBeNull();
    expect(mockStorage.uploadToKey).not.toHaveBeenCalled();

    await capturedHook!();

    expect(callOrder).toEqual(["db-committed", "upload"]);
    expect(result.url).toBe("onboarding/uuid-id-doc.pdf");
  });

  it("returns the pre-generated tenant-private key immediately without waiting for the upload", async () => {
    mockRegisterAfterCommit.mockReturnValue(true);

    const result = await controller.upload(makeFile(), "ID_PROOF", makeUser());

    expect(result).toEqual({ url: "onboarding/uuid-id-doc.pdf" });
    expect(mockStorage.uploadToKey).not.toHaveBeenCalled();
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
  let mockStorage: jest.Mocked<Pick<StorageService, "isConfigured" | "compressAndPreGenerateKey" | "uploadToKey">>;
  let mockAvScanner: jest.Mocked<Pick<AvScanner, "scan">>;
  let mockDb: { transaction: jest.Mock };
  let controller: OnboardingDocumentsController;

  beforeEach(() => {
    mockRegisterAfterCommit.mockClear();
    mockRegisterAfterCommit.mockReturnValue(false);

    mockStorage = {
      isConfigured: jest.fn().mockReturnValue(true),
      compressAndPreGenerateKey: jest.fn().mockResolvedValue({
        key: "onboarding/uuid-id-doc.pdf",
        compressedBuffer: Buffer.from("compressed"),
        compressedMimeType: "application/pdf",
        size: 10,
      }),
      uploadToKey: jest.fn().mockResolvedValue(undefined),
    };

    mockAvScanner = { scan: jest.fn().mockResolvedValue({ status: "clean" }) };

    const tx = buildTxMock();
    mockDb = {
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    };

    controller = new OnboardingDocumentsController(
      mockDb as never,
      mockStorage as never,
      mockAvScanner as never,
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
    expect(mockStorage.compressAndPreGenerateKey).toHaveBeenCalled();
  });

  it("rejects infected files with 422 and never writes to S3", async () => {
    mockAvScanner.scan.mockResolvedValue({ status: "infected", threat: "Eicar-Test-Signature" });

    await expect(controller.upload(makeFile(), "ID_PROOF", makeUser())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );

    expect(mockStorage.compressAndPreGenerateKey).not.toHaveBeenCalled();
    expect(mockStorage.uploadToKey).not.toHaveBeenCalled();
  });

  it("rejects scanner errors with 503 and never writes to S3", async () => {
    mockAvScanner.scan.mockResolvedValue({ status: "error", reason: "clamd-unreachable" });

    await expect(controller.upload(makeFile(), "ID_PROOF", makeUser())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(mockStorage.compressAndPreGenerateKey).not.toHaveBeenCalled();
    expect(mockStorage.uploadToKey).not.toHaveBeenCalled();
  });

  it("scan happens before the DB transaction — no orphaned rows on infected files", async () => {
    mockAvScanner.scan.mockResolvedValue({ status: "infected", threat: "Eicar-Test-Signature" });

    await expect(controller.upload(makeFile(), "ID_PROOF", makeUser())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
