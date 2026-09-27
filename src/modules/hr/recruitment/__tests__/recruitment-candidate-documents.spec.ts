import { RecruitmentCandidateDocumentsController } from "../recruitment-candidate-documents.controller";
import { RecruitmentCandidateVaultService } from "../recruitment-candidate-vault.service";
/*
  This branch's symbols (quarantine, AV scanner, the two extra exception types)
  at origin/main's depths. Ours were one level short — `src/modules/hr/storage/`
  and `src/modules/common/audit/` do not exist — so this spec could not resolve
  and was not running.
*/
import { StorageService } from "../../../storage/storage.service";
import { FileQuarantineService } from "../../../storage/file-quarantine.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { AvScanner } from "../../../../common/security/av-scan";
import {
  BadRequestException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn((_db, cb) => cb()),
}));

const VALID_PDF = {
  buffer: Buffer.from("%PDF-1.4"),
  originalname: "test.pdf",
  mimetype: "application/pdf",
  size: 1024,
} as Express.Multer.File;

describe("RecruitmentCandidateDocumentsController", () => {
  let controller: RecruitmentCandidateDocumentsController;
  let db: any;
  let vaultService: jest.Mocked<RecruitmentCandidateVaultService>;
  let storage: jest.Mocked<StorageService>;
  let quarantine: jest.Mocked<FileQuarantineService>;
  let audit: jest.Mocked<AuditService>;
  let scanner: jest.Mocked<Pick<AvScanner, "scan">>;

  beforeEach(() => {
    db = {};
    vaultService = {
      addVaultDocument: jest.fn(),
    } as unknown as jest.Mocked<RecruitmentCandidateVaultService>;
    storage = {
      planUpload: jest.fn(),
      compressToKey: jest.fn(),
      getFileUrl: jest.fn(),
    } as unknown as jest.Mocked<StorageService>;
    quarantine = {
      begin: jest.fn(),
      recordMeasuredObject: jest.fn(),
      markClean: jest.fn(),
    } as unknown as jest.Mocked<FileQuarantineService>;
    audit = {
      log: jest.fn(),
    } as unknown as jest.Mocked<AuditService>;
    scanner = { scan: jest.fn().mockResolvedValue({ status: "clean" }) };

    controller = new RecruitmentCandidateDocumentsController(
      db, vaultService, storage, quarantine, scanner as unknown as AvScanner, audit
    );
  });

  it("should upload a valid PDF document", async () => {
    const orgId = "org-1";
    const userId = "user-1";
    const candidateId = 123;
    const file = {
      buffer: Buffer.from("%PDF-1.4"),
      originalname: "test.pdf",
      mimetype: "application/pdf",
      size: 1024,
    } as Express.Multer.File;

    storage.planUpload.mockResolvedValue({ key: "path/to/file", plannedMimeType: "application/pdf" });
    storage.getFileUrl.mockResolvedValue("http://s3.com/file");
    quarantine.begin.mockResolvedValue("quarantine-id");
    vaultService.addVaultDocument.mockResolvedValue({ id: 1 } as unknown as Awaited<ReturnType<typeof vaultService.addVaultDocument>>);

    const result = await controller.upload(
      { orgId, userId } as unknown as CurrentUserContext,
      candidateId.toString(),
      file,
      "resume"
    );

    expect(result).toEqual({ id: 1 });
    expect(storage.planUpload).toHaveBeenCalled();
    expect(quarantine.begin).toHaveBeenCalled();
    expect(vaultService.addVaultDocument).toHaveBeenCalledWith(
      orgId, userId, candidateId, expect.objectContaining({ filename: "test.pdf" })
    );
    expect(audit.log).toHaveBeenCalled();
    expect(scanner.scan).toHaveBeenCalledWith(file.buffer, "test.pdf", "application/pdf");
    expect(quarantine.markClean).toHaveBeenCalledWith("quarantine-id");
  });

  /**
   * This route called `markClean` immediately after storing the bytes, with no
   * scan of any kind, and the vault download then trusted that verdict.
   */
  it("refuses an infected file, stores nothing, and marks nothing clean", async () => {
    scanner.scan.mockResolvedValue({ status: "infected", threat: "EICAR-Test" });

    await expect(
      controller.upload({ orgId: "org-1", userId: "u" } as unknown as CurrentUserContext, "123", VALID_PDF, "resume"),
    ).rejects.toThrow(UnprocessableEntityException);

    expect(storage.planUpload).not.toHaveBeenCalled();
    expect(quarantine.markClean).not.toHaveBeenCalled();
    expect(vaultService.addVaultDocument).not.toHaveBeenCalled();
  });

  it("refuses the upload when no scanner is available rather than storing it unscanned", async () => {
    scanner.scan.mockResolvedValue({ status: "error", reason: "malware-scanning-disabled" });

    await expect(
      controller.upload({ orgId: "org-1", userId: "u" } as unknown as CurrentUserContext, "123", VALID_PDF, "resume"),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(quarantine.markClean).not.toHaveBeenCalled();
  });

  it("should throw BadRequestException if file is missing", async () => {
    await expect(controller.upload({ orgId: "1", userId: "1" } as unknown as CurrentUserContext, "1", undefined as unknown as Express.Multer.File, "resume"))
      .rejects.toThrow(BadRequestException);
  });
});
