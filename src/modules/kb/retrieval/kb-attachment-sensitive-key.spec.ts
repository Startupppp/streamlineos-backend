import { KbAttachmentIndexingService } from "./kb-attachment-indexing.service";
import type { Db } from "../../../db/drizzle.module";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { StorageService } from "../../storage/storage.service";
import type { KbIngestionCheckpointService } from "./kb-ingestion-checkpoint.service";
import { stubService } from "../../../test/service-stub.spec-fixtures";

const ORG = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = 9;

/**
 * `StorageService.getFileStream` applies no sensitive-folder check (only `getFileUrl` does), and the
 * indexer read an attachment row's `file_key` with it. The support-article attachment route used to
 * accept any key inside the caller's own organisation, so a key under `hr-documents/` was read,
 * text-extracted and embedded as KB text. The route now refuses such keys; this is the second lock,
 * for rows that predate the fix or arrive by another route.
 */
function harness(fileKey: string) {
  const row = {
    pageId: 5,
    fileKey,
    mimeType: "application/pdf",
    fileName: "scan.pdf",
    deletedAt: null,
    pageAclRevision: 1,
    pageDeletedAt: null,
  };
  const selectChain: Record<string, jest.Mock> = {
    from: jest.fn(() => selectChain),
    leftJoin: jest.fn(() => selectChain),
    where: jest.fn(() => selectChain),
    limit: jest.fn().mockResolvedValue([row]),
  };
  const remove = jest.fn(() => Promise.resolve(undefined));
  const db = {
    select: jest.fn(() => selectChain),
    delete: jest.fn(() => ({ where: remove })),
  } as unknown as Db;
  const getFileStream = jest.fn().mockRejectedValue(new Error("stream not wired"));
  const service = new KbAttachmentIndexingService(
    db,
    stubService<AiGatewayService>({ isEmbeddingConfigured: jest.fn().mockReturnValue(true) }),
    stubService<StorageService>({ getFileStream }),
    stubService<KbIngestionCheckpointService>({}),
  );
  return { service, getFileStream, remove };
}

describe("the KB indexer refuses to read a key inside a protected folder", () => {
  it.each([
    `${ORG}/hr-documents/0b9c1c62-offer-letter.pdf`,
    `${ORG}/documents/0b9c1c62-aadhaar.pdf`,
    `${ORG}/payslips/0b9c1c62-jan.pdf`,
    `${ORG}/onboarding/0b9c1c62-pan.pdf`,
    `eu/${ORG}/hr-documents/0b9c1c62-offer-letter.pdf`,
  ])("does not open %s, and reports why", async (fileKey) => {
    const { service, getFileStream } = harness(fileKey);

    const result = await service.indexAttachment(ORG, ATTACHMENT_ID);

    expect(getFileStream).not.toHaveBeenCalled();
    expect(result.chunks).toBe(0);
    expect(result.warning).toContain("protected folder");
  });

  it("leaves chunks that already exist alone: removing them is an operator decision, not a reindex side effect", async () => {
    const { service, remove } = harness(`${ORG}/hr-documents/0b9c1c62-offer-letter.pdf`);

    await service.indexAttachment(ORG, ATTACHMENT_ID);

    expect(remove).not.toHaveBeenCalled();
  });

  it("still opens an ordinary KB attachment, so the refusal above is the folder check and not a guard that rejects everything", async () => {
    const { service, getFileStream } = harness(`${ORG}/kb-attachments/0b9c1c62-runbook.pdf`);

    const result = await service.indexAttachment(ORG, ATTACHMENT_ID);

    expect(getFileStream).toHaveBeenCalledWith(ORG, `${ORG}/kb-attachments/0b9c1c62-runbook.pdf`);
    expect(result.warning).toContain("could not read file");
  });
});
