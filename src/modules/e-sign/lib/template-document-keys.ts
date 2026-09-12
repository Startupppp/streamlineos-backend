import { BadRequestException } from "@nestjs/common";
import { isOwnOrgStorageKey, parseStorageKey } from "../../storage/storage-key";
import type { TemplateSnapshot } from "../sign-template-snapshot";

/** The folder `SignDocumentsService.upload` writes under: `<org>/signos/<org>/<envelope>/…`. */
export const SIGN_DOCUMENT_FOLDER_ROOT = "signos";

/**
 * Every document a template snapshot names must be one of this organisation's
 * own SignOS uploads.
 *
 * `createTemplateSchema.templateJson` is `z.record(z.string(), z.unknown())`,
 * and `parseTemplateSnapshot` copies each `documents[].fileKey` verbatim.
 * `instantiate` then writes that string to `sign_documents.current_file_key`,
 * and finalization reads it back through `StorageService.getFileStream`,
 * which resolves a bucket and fetches — it does not ask whose key it was
 * given. So a holder of `sign:template:manage` could spell another tenant's
 * object key, or this tenant's `hr-documents/…` key, into a template, send the
 * envelope to themselves, sign, and download the bytes merged into the final
 * PDF. The same string also reached `getPreviewUrl` preauthorized.
 *
 * Checked on create, on an update that replaces the snapshot, and again at
 * instantiate — the last because a template written before this check may
 * still hold such a key, and instantiate is where it would be spent.
 */
export function assertSnapshotDocumentsOwned(orgId: string, snapshot: TemplateSnapshot): void {
  for (const document of snapshot.documents) {
    if (!isSignDocumentKeyOf(orgId, document.fileKey)) {
      throw new BadRequestException(
        "Template documents must be files uploaded to SignOS in this organisation",
      );
    }
  }
}

export function isSignDocumentKeyOf(orgId: string, fileKey: string): boolean {
  if (!isOwnOrgStorageKey(fileKey, orgId)) return false;
  return parseStorageKey(fileKey, orgId).folderRoot === SIGN_DOCUMENT_FOLDER_ROOT;
}
