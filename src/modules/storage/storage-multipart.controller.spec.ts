import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { StorageMultipartController } from "./storage-multipart.controller";
import type { StorageService } from "./storage.service";
import type { StorageMultipartService } from "./storage-multipart.service";
import type { FileQuarantineService } from "./file-quarantine.service";
import type { AuditService } from "../../common/audit/audit.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";

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

function buildController() {
  const mockStorage: Pick<StorageService, "isConfigured" | "isValidFileKey"> = {
    isConfigured: jest.fn().mockReturnValue(true),
    isValidFileKey: jest.fn().mockReturnValue(true),
  };
  const mockMultipart: Pick<StorageMultipartService, "complete"> = {
    complete: jest.fn().mockResolvedValue(undefined),
  };
  const mockQuarantine: Pick<
    FileQuarantineService,
    "getTotalUsageBytes" | "getTotalUsageBytesForUser" | "begin" | "markClean"
  > = {
    getTotalUsageBytes: jest.fn().mockResolvedValue(0),
    getTotalUsageBytesForUser: jest.fn().mockResolvedValue(0),
    begin: jest.fn().mockResolvedValue("qr-uuid-1"),
    markClean: jest.fn().mockResolvedValue(undefined),
  };
  const mockAudit: Pick<AuditService, "log"> = { log: jest.fn() };

  const controller = new StorageMultipartController(
    mockStorage as never,
    mockMultipart as never,
    mockQuarantine as never,
    mockAudit as never,
  );
  return { controller, mockStorage, mockMultipart, mockQuarantine, mockAudit };
}

const COMPLETE_BODY = {
  key: "org-1/video/uuid-clip.mp4",
  uploadId: "upload-id-abc",
  parts: [{ partNumber: 1, eTag: '"abc123"' }],
};

describe("StorageMultipartController.complete — AV quarantine gate", () => {
  it("does NOT call markClean on complete — multipart bytes bypass the backend scanner", async () => {
    const { controller, mockQuarantine } = buildController();

    const result = await controller.complete(COMPLETE_BODY, makeUser());

    expect(mockQuarantine.markClean).not.toHaveBeenCalled();
    expect(result.status).toBe("pending_scan");
  });

  it("records a quarantine record for the completed upload", async () => {
    const { controller, mockQuarantine } = buildController();

    const result = await controller.complete(COMPLETE_BODY, makeUser());

    expect(mockQuarantine.begin).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", storageKey: COMPLETE_BODY.key }),
    );
    expect(result.quarantineId).toBe("qr-uuid-1");
  });

  it("blocks download via pending_scan status — isKeyBlocked will return true", async () => {
    const { controller } = buildController();

    const result = await controller.complete(COMPLETE_BODY, makeUser());

    expect(result.status).toBe("pending_scan");
  });

  it("rejects a key that does not belong to the caller's org", async () => {
    const { controller } = buildController();
    const crossTenantBody = { ...COMPLETE_BODY, key: "org-other/video/file.mp4" };

    await expect(controller.complete(crossTenantBody, makeUser())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects when storage is not configured", async () => {
    const { controller, mockStorage } = buildController();
    (mockStorage.isConfigured as jest.Mock).mockReturnValue(false);

    await expect(controller.complete(COMPLETE_BODY, makeUser())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
