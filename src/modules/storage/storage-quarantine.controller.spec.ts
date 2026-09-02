import { ConflictException, NotFoundException } from "@nestjs/common";
import { StorageQuarantineController } from "./storage-quarantine.controller";
import type { FileQuarantineService, QuarantineRecord } from "./file-quarantine.service";
import type { AuditService } from "../../common/audit/audit.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";

const RECORD_ID = "a1b2c3d4-0000-4000-8000-000000000001";

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "ORG_ADMIN",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function makeRecord(status: QuarantineRecord["status"]): QuarantineRecord {
  return {
    id: RECORD_ID,
    orgId: "org-1",
    storageKey: "org-1/uploads/uuid-file.pdf",
    filename: "contract.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: 102400,
    sha256: "abc123",
    status,
    threatName: status === "infected" ? "Eicar-Test-Signature" : null,
    idempotencyKey: null,
    uploadedBy: "user-1",
    createdAt: new Date(),
  };
}

function buildController(quarantineOverrides: Partial<jest.Mocked<FileQuarantineService>> = {}) {
  const mockQuarantine: jest.Mocked<
    Pick<FileQuarantineService, "findById" | "markClean" | "markInfected" | "list">
  > = {
    findById: jest.fn(),
    markClean: jest.fn().mockResolvedValue(undefined),
    markInfected: jest.fn().mockResolvedValue(undefined),
    list: jest.fn(),
    ...quarantineOverrides,
  };
  const mockAudit: Pick<AuditService, "log"> = { log: jest.fn() };

  const controller = new StorageQuarantineController(
    mockQuarantine as never,
    mockAudit as never,
  );
  return { controller, mockQuarantine, mockAudit };
}

describe("StorageQuarantineController.release — state guard", () => {
  it("marks a pending_scan record as clean and returns status=clean", async () => {
    const { controller, mockQuarantine } = buildController();
    mockQuarantine.findById.mockResolvedValue(makeRecord("pending_scan"));

    const result = await controller.release({ quarantineId: RECORD_ID }, makeUser());

    expect(mockQuarantine.markClean).toHaveBeenCalledWith(RECORD_ID);
    expect(result).toEqual({ status: "clean" });
  });

  it("throws ConflictException when the record is infected — prevents malware clearance", async () => {
    const { controller, mockQuarantine } = buildController();
    mockQuarantine.findById.mockResolvedValue(makeRecord("infected"));

    await expect(
      controller.release({ quarantineId: RECORD_ID }, makeUser()),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(mockQuarantine.markClean).not.toHaveBeenCalled();
  });

  it("throws ConflictException when the record is in error state", async () => {
    const { controller, mockQuarantine } = buildController();
    mockQuarantine.findById.mockResolvedValue(makeRecord("error"));

    await expect(
      controller.release({ quarantineId: RECORD_ID }, makeUser()),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(mockQuarantine.markClean).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when the record does not exist", async () => {
    const { controller, mockQuarantine } = buildController();
    mockQuarantine.findById.mockResolvedValue(null);

    await expect(
      controller.release({ quarantineId: RECORD_ID }, makeUser()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("StorageQuarantineController.reject — state guard", () => {
  it("marks a pending_scan record as infected and returns status=infected", async () => {
    const { controller, mockQuarantine } = buildController();
    mockQuarantine.findById.mockResolvedValue(makeRecord("pending_scan"));

    const result = await controller.reject(
      { quarantineId: RECORD_ID },
      { reason: "manual-rejection" },
      makeUser(),
    );

    expect(mockQuarantine.markInfected).toHaveBeenCalledWith(RECORD_ID, "manual-rejection");
    expect(result).toEqual({ status: "infected" });
  });

  it("throws ConflictException when the record is already clean — prevents un-cleaning a released file", async () => {
    const { controller, mockQuarantine } = buildController();
    mockQuarantine.findById.mockResolvedValue(makeRecord("clean"));

    await expect(
      controller.reject({ quarantineId: RECORD_ID }, { reason: "bad" }, makeUser()),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(mockQuarantine.markInfected).not.toHaveBeenCalled();
  });

  it("allows rejecting an error record", async () => {
    const { controller, mockQuarantine } = buildController();
    mockQuarantine.findById.mockResolvedValue(makeRecord("error"));

    const result = await controller.reject(
      { quarantineId: RECORD_ID },
      { reason: "suspicious" },
      makeUser(),
    );

    expect(mockQuarantine.markInfected).toHaveBeenCalledWith(RECORD_ID, "suspicious");
    expect(result).toEqual({ status: "infected" });
  });
});
