import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { getObservabilityContext } from "../../../common/observability";
import { and, desc, eq } from "drizzle-orm";
import {
  auditLogs,
  candidateDocuments,
  candidateMessages,
  candidates,
  candidateDocumentsVault,
  interviews,
  users,
  vaultAccessLogs,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { storagePendingPurge } from "../../../db/schema/common/storage-pending-purge";
import { FileQuarantineService } from "../../storage/file-quarantine.service";
import { isOwnOrgStorageKey } from "../../storage/storage-key";
import type { AddVaultDocumentInput } from "./dto/candidate-records.schemas";

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
]);
const ALLOWED_EXTENSIONS = /\.(pdf|docx|doc)$/i;

@Injectable()
export class RecruitmentCandidateVaultService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly quarantine: FileQuarantineService,
  ) {}

  async listVault(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId);
    return this.db.query.candidateDocumentsVault.findMany({
      limit: 100,
      where: and(
        eq(candidateDocumentsVault.candidateId, candidateId),
        eq(candidateDocumentsVault.orgId, orgId),
      ),
      orderBy: (d, { desc: dd }) => [dd(d.createdAt)],
    });
  }

  async addVaultDocument(
    orgId: string,
    userId: string,
    candidateId: number,
    input: AddVaultDocumentInput,
  ) {
    await this.ensureCandidate(orgId, candidateId);

    /**
     * Both, not either. Accepting a declared MIME type OR a filename extension
     * means a caller declaring `application/pdf` for `payload.html` is admitted
     * on the MIME alone, and one naming `payload.pdf` is admitted on the
     * extension alone — the pair only constrains anything when both must hold.
     */
    if (!ALLOWED_MIME_TYPES.has(input.fileType.toLowerCase()) || !ALLOWED_EXTENSIONS.test(input.filename)) {
      throw new UnsupportedMediaTypeException(
        "Only PDF and DOCX files are allowed for candidate documents.",
      );
    }

    /**
     * The key is a client string on this route — no bytes pass through it — so
     * the tenant prefix is asserted here or never. Without it the vault row
     * becomes a pointer at any object the caller can spell, and the download
     * route authorises the ROW.
     */
    if (!isOwnOrgStorageKey(input.s3Key, orgId))
      throw new BadRequestException("Invalid file reference");

    const scanStatus = await this.quarantine.getStatusForKey(orgId, input.s3Key);
    if (scanStatus !== null && scanStatus !== "clean") {
      throw new UnprocessableEntityException(
        "File has not cleared malware scanning. Confirm the upload is complete before adding to the vault.",
      );
    }
    const avResult = scanStatus === "clean" ? "CLEAN" : "PENDING";

    const [doc] = await this.db
      .insert(candidateDocumentsVault)
      .values({
        candidateId,
        orgId,
        filename: input.filename,
        s3Key: input.s3Key,
        fileUrl: input.fileUrl,
        fileType: input.fileType,
        fileSize: input.fileSize,
        documentType: input.documentType ?? null,
        uploadedBy: userId,
        avResult,
      })
      .returning();
    return doc;
  }

  async deleteVaultDocument(
    orgId: string,
    candidateId: number,
    documentId: number,
    actorUserId?: string,
  ) {
    await this.ensureCandidate(orgId, candidateId);

    const accessedBy = actorUserId ?? getObservabilityContext()?.actorId;
    if (!accessedBy)
      throw new InternalServerErrorException(
        "Cannot delete a vault document without an identified actor to record against.",
      );

    const existing = await this.db.query.candidateDocumentsVault.findFirst({
      where: and(
        eq(candidateDocumentsVault.id, documentId),
        eq(candidateDocumentsVault.candidateId, candidateId),
        eq(candidateDocumentsVault.orgId, orgId),
      ),
      columns: { id: true, filename: true, documentType: true, s3Key: true },
    });
    if (!existing) throw new NotFoundException("Vault document not found");

    await this.db.transaction(async (tx) => {
      /**
       * The purge row is written inside the same transaction that removes the
       * vault row, so the object can never outlive the only pointer to it. The
       * sweeper owns the delete itself; doing it here would leave a transient
       * storage failure indistinguishable from a permanent orphan.
       */
      if (existing.s3Key.trim().length > 0) {
        await tx
          .insert(storagePendingPurge)
          .values({
            orgId,
            storageKey: existing.s3Key,
            purpose: "recruitment:vault-document:delete",
            bucket: "default",
            status: "pending",
          })
          .onConflictDoUpdate({
            target: [storagePendingPurge.orgId, storagePendingPurge.storageKey],
            set: { status: "pending", lastAttemptedAt: null, failedReason: null },
          });
      }

      await tx.insert(vaultAccessLogs).values({
        orgId,
        candidateId,
        vaultDocumentId: documentId,
        filename: existing.filename,
        documentType: existing.documentType,
        accessedBy,
        action: "DELETE",
      });

      await tx
        .delete(candidateDocumentsVault)
        .where(
          and(
            eq(candidateDocumentsVault.id, documentId),
            eq(candidateDocumentsVault.candidateId, candidateId),
            eq(candidateDocumentsVault.orgId, orgId),
          ),
        );
    });

    return { success: true };
  }

  async listVaultAccessLogs(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId, "Candidate not found");

    const logs = await this.db
      .select({
        id: vaultAccessLogs.id,
        action: vaultAccessLogs.action,
        accessedAt: vaultAccessLogs.accessedAt,
        fileName: vaultAccessLogs.filename,
        documentType: vaultAccessLogs.documentType,
        accessorName: users.name,
        accessorFirstName: users.firstName,
        accessorLastName: users.lastName,
      })
      .from(vaultAccessLogs)
      .leftJoin(users, eq(vaultAccessLogs.accessedBy, users.id))
      .where(
        and(
          eq(vaultAccessLogs.orgId, orgId),
          eq(vaultAccessLogs.candidateId, candidateId),
        ),
      )
      .orderBy(desc(vaultAccessLogs.accessedAt))
      .limit(100);

    return logs.map((l) => ({
      ...l,
      accessorDisplayName:
        l.accessorFirstName && l.accessorLastName
          ? `${l.accessorFirstName} ${l.accessorLastName}`
          : (l.accessorName ?? "Unknown"),
    }));
  }

  async getActivity(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId);

    const [auditEntries, candidateInterviews, messages, documents] =
      await Promise.all([
        this.db
          .select({
            id: auditLogs.id,
            action: auditLogs.action,
            metadata: auditLogs.metadata,
            createdAt: auditLogs.createdAt,
            userName: users.name,
          })
          .from(auditLogs)
          .leftJoin(users, eq(auditLogs.userId, users.id))
          .where(
            and(
              eq(auditLogs.orgId, orgId),
              eq(auditLogs.targetType, "candidate"),
              eq(auditLogs.targetId, String(candidateId)),
            ),
          )
          .orderBy(desc(auditLogs.createdAt))
          .limit(100),
        this.db.query.interviews.findMany({
          limit: 100,
          where: and(
            eq(interviews.candidateId, candidateId),
            eq(interviews.orgId, orgId),
          ),
          columns: { id: true, type: true, scheduledAt: true, result: true },
          orderBy: (t, { desc: d }) => [d(t.scheduledAt)],
        }),
        this.db.query.candidateMessages.findMany({
          limit: 100,
          where: and(
            eq(candidateMessages.candidateId, candidateId),
            eq(candidateMessages.orgId, orgId),
          ),
          columns: {
            id: true,
            direction: true,
            channel: true,
            subject: true,
            sentAt: true,
          },
          orderBy: (t, { desc: d }) => [d(t.sentAt)],
        }),
        this.db.query.candidateDocuments.findMany({
          limit: 100,
          where: and(
            eq(candidateDocuments.candidateId, candidateId),
            eq(candidateDocuments.orgId, orgId),
          ),
          columns: {
            id: true,
            title: true,
            status: true,
            createdAt: true,
            sentAt: true,
          },
          orderBy: (t, { desc: d }) => [d(t.createdAt)],
        }),
      ]);

    const events = [
      ...auditEntries.map((e) => ({
        type: "AUDIT" as const,
        id: `audit-${e.id}`,
        label: e.action,
        detail: e.metadata,
        actor: e.userName,
        at: e.createdAt,
      })),
      ...candidateInterviews.map((i) => ({
        type: "INTERVIEW" as const,
        id: `interview-${i.id}`,
        label: `Interview scheduled (${i.type})`,
        detail: { result: i.result },
        actor: null,
        at: i.scheduledAt,
      })),
      ...messages.map((m) => ({
        type: "MESSAGE" as const,
        id: `message-${m.id}`,
        label:
          m.direction === "OUTBOUND"
            ? `Message sent (${m.channel})`
            : `Message received (${m.channel})`,
        detail: { subject: m.subject },
        actor: null,
        at: m.sentAt,
      })),
      ...documents.map((d) => ({
        type: "DOCUMENT" as const,
        id: `document-${d.id}`,
        label: `Document ${d.status === "SENT" ? "sent" : "generated"}: ${d.title}`,
        detail: { status: d.status },
        actor: null,
        at: d.sentAt ?? d.createdAt,
      })),
    ];

    return events
      .filter((e): e is typeof e & { at: Date } => e.at !== null)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }

  private async ensureCandidate(
    orgId: string,
    candidateId: number,
    message = "Candidate not found.",
  ): Promise<void> {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true },
    });
    if (!candidate) throw new NotFoundException(message);
  }
}
