import { Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../../../common/audit/audit.service";
import { StorageService } from "../../storage/storage.service";
import { isOwnOrgStorageKey, parseStorageKey } from "../../storage/storage-key";
import { KbLinkedDocumentQueryService, type LinkedDocumentCaller } from "./kb-linked-document-query.service";

/** The folders an HR document's file may live under; anything else is not an HR document file and is not signed. */
const HR_DOCUMENT_FOLDERS: ReadonlySet<string> = new Set(["documents", "hr-documents", "hr"]);

/** How long a signed URL lives. Short on purpose: it is a bearer credential for an employee document. */
export const LINKED_DOCUMENT_URL_TTL_SECONDS = 300;

/**
 * Opens the file behind a knowledge-base entry. The entry is authorised again here (visibility is decided in
 * SQL by the query service), then the storage path is the same one the HR file route uses: the key must be this
 * organisation's, must sit under an HR document folder, and is signed for 300 seconds. The URL is returned to the
 * caller and to nobody else: it goes into no log line and no audit row, only the fact that it was issued.
 */
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
