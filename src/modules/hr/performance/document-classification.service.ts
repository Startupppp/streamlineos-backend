import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { documentAudiences, documents, orgUnits } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { AuditService } from "../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { KbHrLinkFlagsService } from "../../kb/core/kb-hr-link-flags.service";
import { KbLinkedDocumentCeilingService } from "../../kb/linked-documents/kb-linked-document-ceiling.service";
import type { ClassifyDocumentInput, SetDocumentAudiencesInput } from "./dto/document-classification.schemas";
import { MAX_DOCUMENT_AUDIENCES } from "./dto/document-classification.schemas";
import type {
  ClassifyDocumentResult,
  DocumentClassificationView,
  SetDocumentAudiencesResult,
} from "./dto/document-classification-response.schemas";
import { isPublishableClassification, publishBlockers, type PublishBlocker } from "./documents-helpers";
import {
  assertAudienceTargetsExist,
  audienceKey,
  dedupeAudiences,
  notPublishableError,
  publishPermissionRequired,
  type AudienceKey,
} from "../../kb/linked-documents/document-audience-targets";

export type ClassificationActor = { userId: string; orgId: string; membershipId: number | null };

type Reader = Pick<TenantTx, "select">;

const DOCUMENT_COLUMNS = {
  id: documents.id,
  orgId: documents.orgId,
  fileUrl: documents.fileUrl,
  type: documents.type,
  userId: documents.userId,
  uploadedBy: documents.uploadedBy,
  classification: documents.classification,
  isActive: documents.isActive,
  metadata: documents.metadata,
  effectiveDate: documents.effectiveDate,
} as const;

type DocumentRow = {
  id: number;
  orgId: string;
  fileUrl: string | null;
  type: string;
  userId: string | null;
  uploadedBy: string | null;
  classification: DocumentClassificationView["classification"];
  isActive: boolean;
  metadata: Record<string, unknown> | null;
  effectiveDate: string | null;
};

/**
 * Classifying HR documents and saying who they are for: the HR-side half of putting a document in the
 * knowledge base. It publishes nothing. A document can only be linked once it is INTERNAL or RESTRICTED, and
 * everything else about that lives in the KB link service; this decides what the document IS.
 *
 * Every route that reaches it answers 404 while `hrms.kb.link` is off, so with the switch off there is no new
 * behaviour to find.
 */
@Injectable()
export class DocumentClassificationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly flags: KbHrLinkFlagsService,
    private readonly ceiling: KbLinkedDocumentCeilingService,
  ) {}

  async get(orgId: string, documentId: number): Promise<DocumentClassificationView> {
    await this.flags.assertEnabled(orgId, "link");
    const row = await this.loadRow(this.db, orgId, documentId);
    return this.view(this.db, orgId, row);
  }

  // `canPublish`: the caller holds `hr:documents:publish`. Moving INTO Internal or Restricted needs it, so classifying is no way round the publish gate; moving OUT never does.
  async classify(
    actor: ClassificationActor,
    documentId: number,
    input: ClassifyDocumentInput,
    canPublish: boolean,
  ): Promise<ClassifyDocumentResult> {
    const { orgId } = actor;
    await this.flags.assertEnabled(orgId, "link");

    const current = await this.loadRow(this.db, orgId, documentId);
    const target = input.classification;
    const intoShareable = isPublishableClassification(target) && target !== current.classification;
    if (intoShareable && !canPublish) {
      await this.refuse(actor, documentId, target, [], "PUBLISH_PERMISSION_REQUIRED");
      throw publishPermissionRequired();
    }
    if (isPublishableClassification(target)) {
      const blockers = publishBlockers({ ...current, classification: target });
      if (blockers.length > 0) {
        await this.refuse(actor, documentId, target, blockers, "DOCUMENT_NOT_PUBLISHABLE");
        throw notPublishableError(blockers);
      }
    }

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        // Re-read under a lock: the checks above were made on an unlocked row, and the document may have been edited since.
        const locked = await this.loadRow(tx, orgId, documentId, true);
        // Whether this is a move INTO the shareable set was judged on the unlocked row too. Someone with the publish permission may have demoted the document in between, which turns "Internal to Internal" into a real promotion.
        if (isPublishableClassification(target) && target !== locked.classification && !canPublish) throw publishPermissionRequired();
        if (isPublishableClassification(target)) {
          const blockers = publishBlockers({ ...locked, classification: target });
          if (blockers.length > 0) throw notPublishableError(blockers);
        }

        const dateChanged = input.effectiveDate !== undefined && input.effectiveDate !== locked.effectiveDate;
        const classificationChanged = target !== locked.classification;
        if (!classificationChanged && !dateChanged) {
          return { ...(await this.view(tx, orgId, locked)), linksTakenDown: 0 };
        }

        const leavesTheKnowledgeBase = classificationChanged && !isPublishableClassification(target);
        const linksTakenDown = leavesTheKnowledgeBase ? await this.ceiling.activeLinkCount(tx, orgId, documentId) : 0;
        const audiencesBefore = leavesTheKnowledgeBase ? await this.audiencesOf(tx, orgId, documentId) : [];

        const [updated] = await tx
          .update(documents)
          .set({
            classification: target,
            ...(input.effectiveDate !== undefined ? { effectiveDate: input.effectiveDate } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(documents.orgId, orgId), eq(documents.id, documentId)))
          .returning(DOCUMENT_COLUMNS);
        if (!updated) throw new NotFoundException("Document not found.");

        // Fail closed: a document that is no longer shareable keeps no audience, so re-classifying it later starts from "HR only" rather than resurrecting an old one. The database trigger has already taken its links down.
        if (leavesTheKnowledgeBase && audiencesBefore.length > 0) {
          await tx
            .delete(documentAudiences)
            .where(and(eq(documentAudiences.orgId, orgId), eq(documentAudiences.documentId, documentId)));
        }

        await this.audit.logCritical({
          action: "hr.document.classified",
          userId: actor.userId,
          orgId,
          targetId: String(documentId),
          targetType: "document",
          before: { classification: locked.classification, effectiveDate: locked.effectiveDate },
          after: { classification: updated.classification, effectiveDate: updated.effectiveDate },
          metadata: { linksTakenDown, audiencesCleared: audiencesBefore.length },
        });

        return { ...(await this.view(tx, orgId, updated)), linksTakenDown };
      },
      { orgId },
    );
  }

  /**
   * Replace who the document is for. The set is the CEILING for any knowledge-base entry of the document:
   * entries may show it to fewer people, never more, so the entries' own audiences are narrowed to fit in the
   * same transaction.
   */
  async setAudiences(
    actor: ClassificationActor,
    documentId: number,
    input: SetDocumentAudiencesInput,
  ): Promise<SetDocumentAudiencesResult> {
    const { orgId } = actor;
    await this.flags.assertEnabled(orgId, "link");

    const wanted = dedupeAudiences(input.audiences);
    const current = await this.loadRow(this.db, orgId, documentId);
    if (wanted.length > 0) {
      const blockers = publishBlockers(current);
      if (blockers.length > 0) {
        await this.refuse(actor, documentId, current.classification, blockers, "DOCUMENT_NOT_PUBLISHABLE");
        throw notPublishableError(blockers);
      }
    }
    await assertAudienceTargetsExist(this.db, orgId, wanted);

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const locked = await this.loadRow(tx, orgId, documentId, true);
        if (wanted.length > 0) {
          const blockers = publishBlockers(locked);
          if (blockers.length > 0) throw notPublishableError(blockers);
        }

        const before = await this.audiencesOf(tx, orgId, documentId);
        const beforeKeys = new Set(before.map(audienceKey));
        const wantedKeys = new Set(wanted.map(audienceKey));
        const unchanged = beforeKeys.size === wantedKeys.size && [...wantedKeys].every((key) => beforeKeys.has(key));
        if (unchanged) return { ...(await this.view(tx, orgId, locked)), linkAudiencesNarrowed: 0 };

        await tx
          .delete(documentAudiences)
          .where(and(eq(documentAudiences.orgId, orgId), eq(documentAudiences.documentId, documentId)));
        if (wanted.length > 0) {
          await tx.insert(documentAudiences).values(
            wanted.map((audience) => ({
              orgId,
              documentId,
              kind: audience.kind,
              refId: audience.refId,
              createdByMembershipId: actor.membershipId,
            })),
          );
        }
        const linkAudiencesNarrowed = await this.ceiling.narrowToCeiling(tx, orgId, documentId);

        await this.audit.logCritical({
          action: "hr.document.audience_changed",
          userId: actor.userId,
          orgId,
          targetId: String(documentId),
          targetType: "document",
          before: { audiences: before },
          after: { audiences: wanted },
          metadata: { linkAudiencesNarrowed },
        });

        return { ...(await this.view(tx, orgId, locked)), linkAudiencesNarrowed };
      },
      { orgId },
    );
  }

  private async loadRow(reader: Reader, orgId: string, documentId: number, lock = false): Promise<DocumentRow> {
    const query = reader
      .select(DOCUMENT_COLUMNS)
      .from(documents)
      .where(and(eq(documents.orgId, orgId), eq(documents.id, documentId)))
      .limit(1);
    const [row] = lock ? await query.for("update") : await query;
    if (!row) throw new NotFoundException("Document not found.");
    return row;
  }

  private async audiencesOf(reader: Reader, orgId: string, documentId: number): Promise<AudienceKey[]> {
    const rows = await reader
      .select({ kind: documentAudiences.kind, refId: documentAudiences.refId })
      .from(documentAudiences)
      .where(and(eq(documentAudiences.orgId, orgId), eq(documentAudiences.documentId, documentId)))
      .limit(MAX_DOCUMENT_AUDIENCES);
    return rows;
  }

  private async view(reader: Reader, orgId: string, row: DocumentRow): Promise<DocumentClassificationView> {
    const audiences = await reader
      .select({
        id: documentAudiences.id,
        kind: documentAudiences.kind,
        refId: documentAudiences.refId,
        label: orgUnits.name,
      })
      .from(documentAudiences)
      .leftJoin(orgUnits, and(eq(orgUnits.orgId, documentAudiences.orgId), eq(orgUnits.id, documentAudiences.refId)))
      .where(and(eq(documentAudiences.orgId, orgId), eq(documentAudiences.documentId, row.id)))
      .orderBy(documentAudiences.id)
      .limit(MAX_DOCUMENT_AUDIENCES);
    const blockers = publishBlockers(row);
    return {
      documentId: row.id,
      classification: row.classification,
      effectiveDate: row.effectiveDate,
      audiences,
      publishable: blockers.length === 0,
      blockers,
    };
  }

  // Outside the request transaction: the refusal is delivered by throwing, which rolls that transaction back, and the record of it would go too.
  private async refuse(
    actor: ClassificationActor,
    documentId: number,
    requested: string,
    blockers: readonly PublishBlocker[],
    reason: string,
  ): Promise<void> {
    await this.audit.logCriticalOutsideTransaction({
      action: "hr.document.classification_refused",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(documentId),
      targetType: "document",
      result: "FAILURE",
      metadata: { requested, reason, blockers: blockers.map((blocker) => blocker.code) },
    });
  }
}
