import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { documentVersions, documents } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { AuditService } from "../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { KbHrLinkFlagsService } from "../../kb/core/kb-hr-link-flags.service";
import { isOwnOrgStorageKey, parseStorageKey } from "../../storage/storage-key";
import type { UploadDocumentVersionInput } from "./dto/document-versions.schemas";
import type { DocumentVersionsView } from "./dto/document-versions-response.schemas";
import type { ClassificationActor } from "./document-classification.service";

type Reader = Pick<TenantTx, "select">;

// A document that has been through more revisions than this is being used as a file store, not a document.
const MAX_VERSIONS_LISTED = 200;

const HR_DOCUMENT_FOLDERS: ReadonlySet<string> = new Set(["documents", "hr-documents", "hr"]);

const DOCUMENT_COLUMNS = {
  id: documents.id,
  version: documents.version,
  fileUrl: documents.fileUrl,
  fileName: documents.fileName,
  fileSize: documents.fileSize,
  mimeType: documents.mimeType,
  effectiveDate: documents.effectiveDate,
} as const;

/**
 * The file history of an HR document. `documents` keeps holding the CURRENT APPROVED file, so every reader that
 * exists today is untouched; this adds the pending upload and the past. Uploading a new version changes nothing
 * anyone can see. APPROVING it copies its file onto the document and moves the version number, which is the
 * moment a knowledge-base entry that follows the latest starts showing it, and is therefore publish authority.
 * Everything answers 404 while `hrms.kb.link` is off.
 */
@Injectable()
export class DocumentVersionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly flags: KbHrLinkFlagsService,
  ) {}

  async list(orgId: string, documentId: number): Promise<DocumentVersionsView> {
    await this.flags.assertEnabled(orgId, "link");
    return this.viewIn(this.db, orgId, documentId);
  }

  async upload(actor: ClassificationActor, documentId: number, input: UploadDocumentVersionInput): Promise<DocumentVersionsView> {
    const { orgId } = actor;
    await this.flags.assertEnabled(orgId, "link");
    this.assertStoredFile(orgId, input.fileUrl);

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const doc = await this.lockDocument(tx, orgId, documentId);
        // A document revised for the first time gets its current file recorded as an approved version, so it can be pinned to and rolled back to.
        const [baseline] = await tx.select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.orgId, orgId), eq(documentVersions.documentId, documentId), eq(documentVersions.version, doc.version))).limit(1);
        if (!baseline && doc.fileUrl !== "") {
          await tx.insert(documentVersions).values({
            orgId,
            documentId,
            version: doc.version,
            fileUrl: doc.fileUrl,
            fileName: doc.fileName,
            fileSize: doc.fileSize,
            mimeType: doc.mimeType,
            effectiveDate: doc.effectiveDate,
            status: "approved",
            approvedAt: new Date(),
            uploadedByMembershipId: actor.membershipId,
            approvedByMembershipId: actor.membershipId,
          });
        }
        const [latest] = await tx.select({ version: sql<number>`coalesce(max(${documentVersions.version}), 0)::int` }).from(documentVersions).where(and(eq(documentVersions.orgId, orgId), eq(documentVersions.documentId, documentId))).limit(1);
        const version = Math.max(doc.version, latest?.version ?? 0) + 1;
        await tx.insert(documentVersions).values({
          orgId,
          documentId,
          version,
          fileUrl: input.fileUrl,
          fileName: input.fileName ?? null,
          fileSize: input.fileSize ?? null,
          mimeType: input.mimeType ?? null,
          effectiveDate: input.effectiveDate ?? null,
          status: "pending",
          uploadedByMembershipId: actor.membershipId,
        });
        await this.audit.logCritical({
          action: "hr.document.version_uploaded",
          userId: actor.userId,
          orgId,
          targetId: String(documentId),
          targetType: "document",
          metadata: { version, fileName: input.fileName ?? null },
        });
        return this.viewIn(tx, orgId, documentId);
      },
      { orgId },
    );
  }

  async approve(actor: ClassificationActor, documentId: number, versionNumber: number): Promise<DocumentVersionsView> {
    const { orgId } = actor;
    await this.flags.assertEnabled(orgId, "link");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const doc = await this.lockDocument(tx, orgId, documentId);
        const [pending] = await tx
          .select()
          .from(documentVersions)
          .where(and(eq(documentVersions.orgId, orgId), eq(documentVersions.documentId, documentId), eq(documentVersions.version, versionNumber)))
          .limit(1)
          .for("update");
        if (!pending) throw new NotFoundException("Version not found.");
        if (pending.status !== "pending") throw new ConflictException({ code: "VERSION_NOT_PENDING", message: `Version ${versionNumber} is already ${pending.status}.` });
        if (versionNumber <= doc.version) throw new ConflictException({ code: "VERSION_SUPERSEDED", message: "A newer version is already the current one." });

        await tx
          .update(documentVersions)
          .set({ status: "approved", approvedAt: new Date(), approvedByMembershipId: actor.membershipId })
          .where(and(eq(documentVersions.orgId, orgId), eq(documentVersions.id, pending.id)));
        // The moment the document's file changes for everyone who reads it.
        await tx
          .update(documents)
          .set({
            fileUrl: pending.fileUrl,
            fileName: pending.fileName,
            fileSize: pending.fileSize,
            mimeType: pending.mimeType,
            version: versionNumber,
            ...(pending.effectiveDate !== null ? { effectiveDate: pending.effectiveDate } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(documents.orgId, orgId), eq(documents.id, documentId)));
        await this.audit.logCritical({
          action: "hr.document.version_approved",
          userId: actor.userId,
          orgId,
          targetId: String(documentId),
          targetType: "document",
          metadata: { fromVersion: doc.version, toVersion: versionNumber },
        });
        return this.viewIn(tx, orgId, documentId);
      },
      { orgId },
    );
  }

  // A key the client chose becomes a pointer the read path later signs, so it must name THIS organisation and an HR document folder (which are themselves protected folders, so the allowlist is the whole check).
  private assertStoredFile(orgId: string, fileUrl: string): void {
    if (!isOwnOrgStorageKey(fileUrl, orgId) || !HR_DOCUMENT_FOLDERS.has(parseStorageKey(fileUrl, orgId).folderRoot))
      throw new BadRequestException({ code: "INVALID_DOCUMENT_FILE", message: "The file must be one uploaded to this organisation's document storage." });
  }

  private async lockDocument(tx: TenantTx, orgId: string, documentId: number) {
    const [doc] = await tx.select(DOCUMENT_COLUMNS).from(documents).where(and(eq(documents.orgId, orgId), eq(documents.id, documentId))).limit(1).for("update");
    if (!doc) throw new NotFoundException("Document not found.");
    return doc;
  }

  private async viewIn(reader: Reader, orgId: string, documentId: number): Promise<DocumentVersionsView> {
    const [doc] = await reader.select(DOCUMENT_COLUMNS).from(documents).where(and(eq(documents.orgId, orgId), eq(documents.id, documentId))).limit(1);
    if (!doc) throw new NotFoundException("Document not found.");
    const rows = await reader
      .select({
        version: documentVersions.version,
        status: documentVersions.status,
        fileName: documentVersions.fileName,
        fileSize: documentVersions.fileSize,
        mimeType: documentVersions.mimeType,
        effectiveDate: documentVersions.effectiveDate,
        approvedAt: documentVersions.approvedAt,
      })
      .from(documentVersions)
      .where(and(eq(documentVersions.orgId, orgId), eq(documentVersions.documentId, documentId)))
      .orderBy(asc(documentVersions.version))
      .limit(MAX_VERSIONS_LISTED);
    const versions = rows.map((row) => ({ ...row, isCurrent: row.version === doc.version }));
    // A document nobody has revised has no history rows: its one version is the file it has always had.
    if (!versions.some((version) => version.isCurrent)) {
      versions.push({ version: doc.version, status: "approved", fileName: doc.fileName, fileSize: doc.fileSize, mimeType: doc.mimeType, effectiveDate: doc.effectiveDate, approvedAt: null, isCurrent: true });
      versions.sort((left, right) => left.version - right.version);
    }
    return { documentId, currentVersion: doc.version, versions };
  }
}
