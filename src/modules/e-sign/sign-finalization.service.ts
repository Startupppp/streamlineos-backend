import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  organizationMembers,
  organizations,
  signCertificates,
  signDocuments,
  signEnvelopes,
  signFields,
  signRecipients,
  signSignatureAssets,
  signWatermarkPolicies,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { StorageService } from "../storage/storage.service";
import { SignPdfService, type StampField, type CertificateData } from "./sign-pdf.service";
import { SignAuditService } from "./sign-audit.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignIntegrationsService } from "./sign-integrations.service";
import { envelopeIsVisible, type EnvelopeViewScope } from "./sign-envelope-scope";

const SIGNING_RECIPIENT_TYPES = ["signer", "approver", "in_person_host", "internal_reviewer"];
const SIGNED_URL_EXPIRY_SECONDS = 900;

type SignCertificateRow = typeof signCertificates.$inferSelect;

@Injectable()
export class SignFinalizationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly pdf: SignPdfService,
    private readonly audit: SignAuditService,
    private readonly notifications: SignNotificationsService,
    private readonly integrations: SignIntegrationsService,
  ) {}

  private async latestCertificate(orgId: string, envelopeId: number): Promise<SignCertificateRow | undefined> {
    return this.db.query.signCertificates.findFirst({
      where: and(eq(signCertificates.orgId, orgId), eq(signCertificates.envelopeId, envelopeId)),
      orderBy: [desc(signCertificates.generatedAt)],
    });
  }

  private async resolveSenderInfo(orgId: string, membershipId: number | null | undefined): Promise<{ name: string | null; email: string | null }> {
    if (membershipId == null) return { name: null, email: null };
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.id, membershipId)),
      with: { user: { columns: { name: true, email: true } } },
    });
    return { name: member?.user?.name ?? null, email: member?.user?.email ?? null };
  }

  /**
   * Idempotent: safe to call multiple times or concurrently for the same envelope. The first
   * caller to flip finalized_at from null "owns" the finalize attempt; everyone else either gets
   * the certificate that owner produced, or (if that owner is still working) a 409 asking the
   * caller — which is always an internal retry path, not a raw user action — to retry shortly.
   */
  async finalize(orgId: string, envelopeId: number): Promise<SignCertificateRow> {
    const existing = await this.latestCertificate(orgId, envelopeId);
    if (existing) return existing;

    const claimed = await this.db
      .update(signEnvelopes)
      .set({ finalizedAt: new Date() })
      .where(and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId), isNull(signEnvelopes.finalizedAt)))
      .returning();

    if (claimed.length === 0) {
      throw new ConflictException("This envelope is already being finalized. Please retry in a moment.");
    }

    try {
      return await this.buildAndPersist(orgId, envelopeId);
    } catch (error) {
      await this.db.update(signEnvelopes).set({ finalizedAt: null }).where(eq(signEnvelopes.id, envelopeId));
      throw error;
    }
  }

  private async buildAndPersist(orgId: string, envelopeId: number): Promise<SignCertificateRow> {
    const envelope = await this.db.query.signEnvelopes.findFirst({
      where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
    });
    if (!envelope) throw new NotFoundException("Envelope not found");

    const [org, senderInfo, documents, recipients, fields] = await Promise.all([
      this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId) }),
      this.resolveSenderInfo(orgId, envelope.senderMembershipId),
      this.db.query.signDocuments.findMany({
        where: and(eq(signDocuments.orgId, orgId), eq(signDocuments.envelopeId, envelopeId)),
        orderBy: (d, { asc }) => [asc(d.orderIndex), asc(d.id)],
      }),
      this.db.query.signRecipients.findMany({ where: and(eq(signRecipients.orgId, orgId), eq(signRecipients.envelopeId, envelopeId)) }),
      this.db.query.signFields.findMany({ where: and(eq(signFields.orgId, orgId), eq(signFields.envelopeId, envelopeId)) }),
    ]);

    const pageOffsetByDocument = new Map<number, number>();
    let runningOffset = 0;
    for (const doc of documents) {
      pageOffsetByDocument.set(doc.id, runningOffset);
      runningOffset += doc.pageCount ?? 0;
    }

    const buffers: Buffer[] = [];
    for (const doc of documents) {
      const stream = await this.storage.getFileStream(orgId, doc.currentFileKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      buffers.push(Buffer.concat(chunks));
    }
    const mergedPdf = documents.length > 1 ? await this.pdf.mergeDocuments(buffers) : buffers[0];
    if (!mergedPdf) throw new NotFoundException("Envelope has no documents to finalize");

    const assetIds = fields
      .map((f) => (f.valueJson as { signatureAssetId?: number } | null)?.signatureAssetId)
      .filter((id): id is number => typeof id === "number");
    const assets =
      assetIds.length > 0
        ? await this.db.query.signSignatureAssets.findMany({ where: and(eq(signSignatureAssets.orgId, orgId), eq(signSignatureAssets.envelopeId, envelopeId)) })
        : [];
    const assetById = new Map(assets.map((a) => [a.id, a]));

    const stampFields: StampField[] = [];
    for (const field of fields) {
      const pageOffset = pageOffsetByDocument.get(field.documentId) ?? 0;
      const base = {
        pageNumber: pageOffset + field.pageNumber,
        x: field.x,
        y: field.y,
        width: field.width,
        height: field.height,
        fieldType: field.fieldType,
      };

      if (field.fieldType === "signature" || field.fieldType === "initials" || field.fieldType === "stamp") {
        const assetId = (field.valueJson as { signatureAssetId?: number } | null)?.signatureAssetId;
        const asset = assetId ? assetById.get(assetId) : undefined;
        if (!asset) continue;
        if (asset.method === "typed" && asset.typedText) {
          stampFields.push({ ...base, textValue: asset.typedText, fontStyle: "signature" });
        } else if (asset.imageFileKey) {
          const stream = await this.storage.getFileStream(orgId, asset.imageFileKey);
          const chunks: Buffer[] = [];
          for await (const chunk of stream.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          stampFields.push({ ...base, imageBytes: Buffer.concat(chunks), imageFormat: "png" });
        }
        continue;
      }

      if (field.fieldType === "checkbox") {
        const checked = Boolean((field.valueJson as { checked?: boolean } | null)?.checked);
        stampFields.push({ ...base, checked });
        continue;
      }

      const value = (field.valueJson as { value?: string } | null)?.value ?? field.defaultValue ?? undefined;
      if (value) stampFields.push({ ...base, textValue: value });
    }

    let finalPdf = await this.pdf.stampFields(mergedPdf, stampFields);
    let watermarked = false;

    if (envelope.watermarkPolicyId) {
      const policy = await this.db.query.signWatermarkPolicies.findFirst({
        where: and(eq(signWatermarkPolicies.id, envelope.watermarkPolicyId), eq(signWatermarkPolicies.orgId, orgId)),
      });
      if (policy?.enabled && policy.showOnFinalPdf && policy.appliesStates.includes("completed")) {
        let imageBytes: Buffer | undefined;
        if (policy.imageFileKey) {
          const stream = await this.storage.getFileStream(orgId, policy.imageFileKey);
          const chunks: Buffer[] = [];
          for await (const chunk of stream.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          imageBytes = Buffer.concat(chunks);
        }
        finalPdf = await this.pdf.applyWatermark(finalPdf, {
          text: policy.text,
          imageBytes,
          opacity: policy.opacity,
          angle: policy.angle,
          color: policy.color,
          fontSize: policy.fontSize,
          pages: policy.pages,
        });
        watermarked = true;
      }
    }

    const finalPdfHash = this.pdf.computeSha256(finalPdf);
    const finalUpload = await this.storage.uploadFile(orgId, finalPdf, `signos/${orgId}/${envelopeId}`, "final-signed.pdf", "application/pdf");

    await this.audit.record({
      orgId,
      envelopeId,
      actorType: "system",
      eventType: "final_pdf_generated",
      eventMessage: `Final signed PDF generated (${finalPdfHash.slice(0, 12)}...)`,
      documentHash: finalPdfHash,
    });

    const events = await this.audit.listForEnvelope(orgId, envelopeId);
    const certificateNumber = `SGN-${envelopeId}-${randomBytes(4).toString("hex").toUpperCase()}`;
    const completedAt = new Date().toISOString();

    const certificateJson = {
      certificateNumber,
      envelopeId,
      envelopeTitle: envelope.title,
      tenantName: org?.name ?? orgId,
      senderName: senderInfo.name ?? "Unknown sender",
      senderEmail: senderInfo.email ?? "",
      finalPdfHash,
      watermarked,
      completedAt,
      documents: documents.map((d) => ({ fileName: d.fileName, sha256Hash: d.sha256Hash, pageCount: d.pageCount })),
      recipients: recipients.map((r) => ({
        name: r.name,
        email: r.email,
        role: r.roleName,
        authMethod: r.authMethod,
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      })),
      events: events.map((e) => ({
        eventType: e.eventType,
        actorName: e.actorName,
        createdAt: e.createdAt.toISOString(),
        ipAddress: e.ipAddress,
      })),
    };

    const certificatePdf = await this.pdf.generateCertificatePdf(certificateJson);
    const certUpload = await this.storage.uploadFile(orgId, certificatePdf, `signos/${orgId}/${envelopeId}`, "certificate.pdf", "application/pdf");

    const [certificate] = await this.db
      .insert(signCertificates)
      .values({
        orgId,
        envelopeId,
        certificateNumber,
        certificateFileKey: certUpload.key,
        finalPdfFileKey: finalUpload.key,
        finalPdfHash,
        watermarked,
        certificateJson,
      })
      .returning();

    await this.db
      .update(signEnvelopes)
      .set({ finalPdfFileKey: finalUpload.key, finalPdfHash })
      .where(eq(signEnvelopes.id, envelopeId));

    await this.audit.record({
      orgId,
      envelopeId,
      actorType: "system",
      eventType: "certificate_generated",
      eventMessage: `Certificate ${certificateNumber} generated`,
    });

    for (const r of recipients) {
      if (!r.email) continue;
      if (SIGNING_RECIPIENT_TYPES.includes(r.recipientType) || r.recipientType === "cc" || r.recipientType === "viewer") {
        await this.notifications.sendCompletedToRecipient(r.email, r.name, envelopeId, envelope.title);
      }
    }

    this.integrations.emitEnvelopeEvent(
      { ...envelope, status: "completed" },
      "completed",
      { certificateNumber, finalPdfHash, watermarked },
    );

    return certificate;
  }

  async getCertificate(orgId: string, envelopeId: number): Promise<SignCertificateRow> {
    const cert = await this.latestCertificate(orgId, envelopeId);
    if (!cert) throw new NotFoundException("This envelope has not been completed yet");
    return cert;
  }

  /**
   * Out of scope and out of tenant answer the same 404 a missing envelope answers:
   * a 403 here would confirm that the envelope exists and that it is finalized.
   */
  private async mustGetVisibleEnvelope(
    orgId: string,
    envelopeId: number,
    scope: EnvelopeViewScope,
    notFoundMessage: string,
  ) {
    const envelope = await this.db.query.signEnvelopes.findFirst({
      where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
    });
    if (!envelope || !envelopeIsVisible(envelope.senderMembershipId, scope))
      throw new NotFoundException(notFoundMessage);
    return envelope;
  }

  async getFinalPdfUrl(orgId: string, envelopeId: number, actor: { userId?: string; ipAddress?: string }, scope: EnvelopeViewScope) {
    const envelope = await this.mustGetVisibleEnvelope(orgId, envelopeId, scope, "Final PDF is not available yet");
    if (!envelope.finalPdfFileKey) throw new NotFoundException("Final PDF is not available yet");

    const url = await this.storage.getFileUrl(orgId, envelope.finalPdfFileKey, SIGNED_URL_EXPIRY_SECONDS);
    await this.audit.record({
      orgId,
      envelopeId,
      actorType: actor.userId ? "internal_user" : "external_signer",
      actorUserId: actor.userId,
      eventType: "document_downloaded",
      eventMessage: "Final signed PDF downloaded",
      ipAddress: actor.ipAddress,
    });
    return { url, expiresInSeconds: SIGNED_URL_EXPIRY_SECONDS, hash: envelope.finalPdfHash };
  }

  async getCertificateUrl(orgId: string, envelopeId: number, scope: EnvelopeViewScope) {
    await this.mustGetVisibleEnvelope(orgId, envelopeId, scope, "This envelope has not been completed yet");
    const cert = await this.getCertificate(orgId, envelopeId);
    const url = await this.storage.getFileUrl(orgId, cert.certificateFileKey, SIGNED_URL_EXPIRY_SECONDS);
    return { url, expiresInSeconds: SIGNED_URL_EXPIRY_SECONDS, certificate: cert };
  }

  /** Explicit admin/legal recovery path — creates a new certificate row, never mutates the old one. */
  async regenerateCertificate(orgId: string, envelopeId: number, actor: { userId: string; ipAddress?: string }) {
    const previous = await this.getCertificate(orgId, envelopeId);
    const events = await this.audit.listForEnvelope(orgId, envelopeId);
    const certificateNumber = `SGN-${envelopeId}-${randomBytes(4).toString("hex").toUpperCase()}-R`;

    const prevJson = previous.certificateJson;
    const certificateJson: CertificateData = {
      certificateNumber,
      envelopeTitle: String(prevJson["envelopeTitle"] ?? ""),
      tenantName: String(prevJson["tenantName"] ?? ""),
      senderName: String(prevJson["senderName"] ?? ""),
      senderEmail: String(prevJson["senderEmail"] ?? ""),
      finalPdfHash: previous.finalPdfHash,
      watermarked: Boolean(prevJson["watermarked"]),
      completedAt: String(prevJson["completedAt"] ?? new Date().toISOString()),
      documents: Array.isArray(prevJson["documents"]) ? prevJson["documents"].map((d: unknown) => {
        const doc = typeof d === "object" && d !== null ? (d as Record<string, unknown>) : {};
        return {
          fileName: String(doc["fileName"] ?? ""),
          sha256Hash: String(doc["sha256Hash"] ?? ""),
          pageCount: typeof doc["pageCount"] === "number" ? doc["pageCount"] : null,
        };
      }) : [],
      recipients: Array.isArray(prevJson["recipients"]) ? prevJson["recipients"].map((r: unknown) => {
        const rec = typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {};
        return {
          name: String(rec["name"] ?? ""),
          email: rec["email"] != null ? String(rec["email"]) : null,
          role: String(rec["role"] ?? ""),
          authMethod: String(rec["authMethod"] ?? ""),
          completedAt: rec["completedAt"] != null ? String(rec["completedAt"]) : null,
        };
      }) : [],
      events: events.map((e) => ({
        eventType: e.eventType,
        actorName: e.actorName,
        createdAt: e.createdAt.toISOString(),
        ipAddress: e.ipAddress,
      })),
    };
    const certificatePdf = await this.pdf.generateCertificatePdf(certificateJson);
    const certUpload = await this.storage.uploadFile(orgId, certificatePdf, `signos/${orgId}/${envelopeId}`, "certificate.pdf", "application/pdf");
    const storedJson: Record<string, unknown> = { ...certificateJson, regeneratedFrom: previous.certificateNumber };

    const [certificate] = await this.db
      .insert(signCertificates)
      .values({
        orgId,
        envelopeId,
        certificateNumber,
        certificateFileKey: certUpload.key,
        finalPdfFileKey: previous.finalPdfFileKey,
        finalPdfHash: previous.finalPdfHash,
        watermarked: previous.watermarked,
        certificateJson: storedJson,
      })
      .returning();

    await this.audit.record({
      orgId,
      envelopeId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "certificate_regenerated",
      eventMessage: `Certificate regenerated as ${certificateNumber}`,
      ipAddress: actor.ipAddress,
    });

    return certificate;
  }
}
