import { NotFoundException } from "@nestjs/common";
import { KbLinkedDocumentFileService, LINKED_DOCUMENT_URL_TTL_SECONDS } from "./kb-linked-document-file.service";
import type { LinkedDocumentCaller } from "./kb-linked-document-query.service";

const ORG = "org-open";
const caller: LinkedDocumentCaller = { orgId: ORG, userId: "u-reader", canPublish: false };
const SIGNED = "https://bucket.example/signed?X-Amz-Signature=abc123";

function build(fileKey: string | Promise<never>) {
  const query = {
    resolveFile: jest.fn().mockImplementation(() => (typeof fileKey === "string" ? Promise.resolve({ fileKey, fileName: "Code of Conduct.pdf" }) : fileKey)),
  };
  const storage = {
    getFileKeyFromUrl: jest.fn((key: string) => key),
    isValidFileKey: jest.fn().mockReturnValue(true),
    getFileUrl: jest.fn().mockResolvedValue(SIGNED),
  };
  const audit = { logCriticalOutsideTransaction: jest.fn().mockResolvedValue(undefined) };
  const service = new KbLinkedDocumentFileService(query as never, storage as never, audit as never);
  return { service, query, storage, audit };
}

describe("KbLinkedDocumentFileService.open", () => {
  it("signs the entry's own file for exactly 300 seconds and says only that it did", async () => {
    const { service, storage, audit } = build(`${ORG}/hr-documents/coc.pdf`);

    const result = await service.open(caller, 5);

    expect(result).toEqual({ url: SIGNED, fileName: "Code of Conduct.pdf", expiresIn: 300 });
    expect(LINKED_DOCUMENT_URL_TTL_SECONDS).toBe(300);
    expect(storage.getFileUrl).toHaveBeenCalledWith(ORG, `${ORG}/hr-documents/coc.pdf`, 300, undefined, { preauthorized: true, attachmentName: "Code of Conduct.pdf" });
    expect(audit.logCriticalOutsideTransaction).toHaveBeenCalledTimes(1);
    const entry = JSON.stringify(audit.logCriticalOutsideTransaction.mock.calls[0]?.[0]);
    expect(entry).toContain("kb.hr_link.document_opened");
    expect(entry).not.toContain("X-Amz-Signature");
    expect(entry).not.toContain("hr-documents/coc.pdf");
  });

  it.each([
    ["another tenant's key", "org-other/hr-documents/x.pdf"],
    ["a payroll folder", `${ORG}/payslips/x.pdf`],
    ["a folder that is not an HR document folder", `${ORG}/kb-media/x.pdf`],
    ["a key with no organisation at all", "hr-documents"],
  ])("does not sign %s, and issues no URL and no audit row", async (_label, key) => {
    const { service, storage, audit } = build(key);

    await expect(service.open(caller, 5)).rejects.toBeInstanceOf(NotFoundException);

    expect(storage.getFileUrl).not.toHaveBeenCalled();
    expect(audit.logCriticalOutsideTransaction).not.toHaveBeenCalled();
  });

  it("does not sign a key the storage layer calls invalid", async () => {
    const { service, storage } = build(`${ORG}/hr-documents/x.pdf`);
    storage.isValidFileKey.mockReturnValue(false);

    await expect(service.open(caller, 5)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.getFileUrl).not.toHaveBeenCalled();
  });

  it("signs nothing when the reader may not see the entry", async () => {
    const { service, storage, audit } = build(Promise.reject(new NotFoundException()));

    await expect(service.open(caller, 5)).rejects.toBeInstanceOf(NotFoundException);

    expect(storage.getFileUrl).not.toHaveBeenCalled();
    expect(audit.logCriticalOutsideTransaction).not.toHaveBeenCalled();
  });
});
