import { RecruitmentCandidateDocumentsController } from "../recruitment-candidate-documents.controller";
import { RecruitmentCandidateVaultService } from "../recruitment-candidate-vault.service";
import { StorageService } from "../../../storage/storage.service";
import { FileQuarantineService } from "../../../storage/file-quarantine.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { BadRequestException } from "@nestjs/common";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn((_db, cb) => cb()),
}));

describe("RecruitmentCandidateDocumentsController", () => {
  let controller: RecruitmentCandidateDocumentsController;
  let db: any;
  let vaultService: jest.Mocked<RecruitmentCandidateVaultService>;
  let storage: jest.Mocked<StorageService>;
  let quarantine: jest.Mocked<FileQuarantineService>;
  let audit: jest.Mocked<AuditService>;

  beforeEach(() => {
    db = {};
    vaultService = {
      addVaultDocument: jest.fn(),
    } as any;
    storage = {
      planUpload: jest.fn(),
      compressToKey: jest.fn(),
      getFileUrl: jest.fn(),
    } as any;
    quarantine = {
      begin: jest.fn(),
      recordMeasuredObject: jest.fn(),
      markClean: jest.fn(),
    } as any;
    audit = {
      log: jest.fn(),
    } as any;

    controller = new RecruitmentCandidateDocumentsController(
      db, vaultService, storage, quarantine, audit
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
    vaultService.addVaultDocument.mockResolvedValue({ id: 1 } as any);

    const result = await controller.upload(
      { orgId, userId } as any,
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
  });

  it("should throw BadRequestException if file is missing", async () => {
    await expect(controller.upload({ orgId: "1", userId: "1" } as any, "1", undefined as any, "resume"))
      .rejects.toThrow(BadRequestException);
  });
});
