import { Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../../../common/audit/audit.service";
import { StorageService } from "../../storage/storage.service";
import { isOwnOrgStorageKey, parseStorageKey } from "../../storage/storage-key";
import { KbLinkedDocumentQueryService, type LinkedDocumentCaller } from "./kb-linked-document-query.service";

const HR_DOCUMENT_FOLDERS: ReadonlySet<string> = new Set(["documents", "hr-documents", "hr"]);

export const LINKED_DOCUMENT_URL_TTL_SECONDS = 300;

@Injectable()
export class KbLinkedDocumentFileService {
  constructor(
    private readonly query: KbLinkedDocumentQueryService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async open(caller: LinkedDocumentCaller, linkedDocumentId: number) {
    const target = await this.query.resolveFile(caller, linkedDocumentId);
    const fileKey = this.storage.getFileKeyFromUrl(target.fileKey);
    if (!this.storage.isValidFileKey(fileKey) || !isOwnOrgStorageKey(fileKey, caller.orgId)) throw new NotFoundException();
    if (!HR_DOCUMENT_FOLDERS.has(parseStorageKey(fileKey, caller.orgId).folderRoot)) throw new NotFoundException();

    const url = await this.storage.getFileUrl(caller.orgId, fileKey, LINKED_DOCUMENT_URL_TTL_SECONDS, undefined, {
      preauthorized: true,
      attachmentName: target.fileName,
    });
    await this.audit.logCriticalOutsideTransaction({
      action: "kb.hr_link.document_opened",
      userId: caller.userId,
      orgId: caller.orgId,
      targetId: String(linkedDocumentId),
      targetType: "kb_linked_document",
      metadata: { fileName: target.fileName },
    });
    return { url, fileName: target.fileName, expiresIn: LINKED_DOCUMENT_URL_TTL_SECONDS };
  }
}
