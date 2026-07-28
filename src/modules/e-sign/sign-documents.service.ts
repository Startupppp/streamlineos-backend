import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { signDocuments, signEnvelopes } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { StorageService } from "../storage/storage.service";
import { validateMagicBytes } from "../storage/file-signatures";
import { SignPdfService } from "./sign-pdf.service";
import { SignSettingsService } from "./sign-settings.service";
import { SignAuditService } from "./sign-audit.service";
import { isEnvelopeEditable } from "./sign-state";

const SIGNED_URL_EXPIRY_SECONDS = 900;

export interface UploadedFileInput {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  size: number;
}

export interface UploadDocumentActor {
  orgId: string;
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class SignDocumentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly pdf: SignPdfService,
    private readonly settings: SignSettingsService,
    private readonly audit: SignAuditService,
  ) {}

  private async loadEditableEnvelope(orgId: string, envelopeId: number) {
    const envelope = await this.db.query.signEnvelopes.findFirst({
      where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
    });
    if (!envelope) throw new NotFoundException("Envelope not found");
    if (!isEnvelopeEditable(envelope.status)) {
      throw new ForbiddenException("Documents can only be added to a draft envelope");
    }
    return envelope;
  }

  async upload(envelopeId: number, file: UploadedFileInput, orderIndex: number, actor: UploadDocumentActor) {
    if (!this.storage.isConfigured()) {
      throw new BadRequestException("File storage is not configured for this environment");
    }

    await this.loadEditableEnvelope(actor.orgId, envelopeId);
    const orgSettings = await this.settings.getOrCreate(actor.orgId);

    if (!orgSettings.allowedFileTypes.includes(file.mimeType)) {
      throw new BadRequestException(
        `File type ${file.mimeType} is not allowed. Allowed types: ${orgSettings.allowedFileTypes.join(", ")}`,
      );
    }
    const maxBytes = orgSettings.maxFileSizeMb * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new BadRequestException(`File exceeds the ${orgSettings.maxFileSizeMb}MB limit for this organization`);
    }
    if (!validateMagicBytes(file.buffer, file.mimeType)) {
      throw new BadRequestException("File content does not match its declared type");
    }

    let pageCount: number;
    try {
      pageCount = await this.pdf.getPageCount(file.buffer);
    } catch {
      throw new BadRequestException("Unable to read this PDF. It may be corrupted or password protected.");
    }

    const sha256Hash = this.pdf.computeSha256(file.buffer);
    const uploaded = await this.storage.uploadFile(
      file.buffer,
      `signos/${actor.orgId}/${envelopeId}`,
      file.originalName,
      file.mimeType,
    );

    const [document] = await this.db
      .insert(signDocuments)
      .values({
        orgId: actor.orgId,
        envelopeId,
        originalFileKey: uploaded.key,
        currentFileKey: uploaded.key,
        fileName: file.originalName,
        mimeType: file.mimeType,
        pageCount,
        fileSize: file.size,
        sha256Hash,
        conversionStatus: "not_needed",
        orderIndex,
        createdBy: actor.userId,
      })
      .returning();

    await this.audit.record({
      orgId: actor.orgId,
      envelopeId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "document_uploaded",
      eventMessage: `Uploaded "${file.originalName}" (${pageCount} pages)`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      documentHash: sha256Hash,
      eventPayload: { documentId: document.id, fileName: file.originalName, pageCount },
    });

    return document;
  }

  async list(orgId: string, envelopeId: number) {
    return this.db.query.signDocuments.findMany({
      where: and(eq(signDocuments.orgId, orgId), eq(signDocuments.envelopeId, envelopeId)),
      orderBy: (doc, { asc }) => [asc(doc.orderIndex), asc(doc.id)],
      limit: 100,
    });
  }

  async get(orgId: string, documentId: number) {
    const doc = await this.db.query.signDocuments.findFirst({
      where: and(eq(signDocuments.id, documentId), eq(signDocuments.orgId, orgId)),
    });
    if (!doc) throw new NotFoundException("Document not found");
    return doc;
  }

  async getPreviewUrl(orgId: string, documentId: number) {
    const doc = await this.get(orgId, documentId);
    const url = await this.storage.getFileUrl(doc.currentFileKey, SIGNED_URL_EXPIRY_SECONDS);
    return { document: doc, url, expiresInSeconds: SIGNED_URL_EXPIRY_SECONDS };
  }

  async delete(orgId: string, documentId: number, _actor: UploadDocumentActor) {
    const doc = await this.get(orgId, documentId);
    await this.loadEditableEnvelope(orgId, doc.envelopeId);
    await this.db.delete(signDocuments).where(eq(signDocuments.id, documentId));
    await this.storage.deleteFile(doc.currentFileKey).catch(() => undefined);
  }

  /** Fetches the current (pre-signing) PDF bytes for an envelope's documents, in order. */
  async fetchBuffers(orgId: string, envelopeId: number): Promise<{ documentId: number; buffer: Buffer }[]> {
    const docs = await this.list(orgId, envelopeId);
    const out: { documentId: number; buffer: Buffer }[] = [];
    for (const doc of docs) {
      const stream = await this.storage.getFileStream(doc.currentFileKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      out.push({ documentId: doc.id, buffer: Buffer.concat(chunks) });
    }
    return out;
  }
}
