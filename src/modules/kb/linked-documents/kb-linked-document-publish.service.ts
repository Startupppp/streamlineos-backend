import { ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { documentVersions, kbLinkedDocumentAudiences, kbLinkedDocuments } from "../../../db/schema";
import type { KbLinkedDocumentStatus } from "../../../db/schema/kb/linked-documents";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { AuditService } from "../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { PublishBlocker } from "../../hr/performance/documents-helpers";
import { KbHrLinkFlagsService } from "../core/kb-hr-link-flags.service";
import type { AudienceKey } from "./document-audience-targets";
import { judgeAudience } from "./kb-link-judge";
import { loadLinkState } from "./kb-link-state";
import { MAX_DOCUMENT_AUDIENCES } from "./dto/document-audience-entry.schema";
import type { KbLinkState } from "./dto/kb-link-state-response.schemas";
import type { PublishLinkInput, UnpublishLinkInput, UpdateLinkInput } from "./dto/kb-link-publish.schemas";

type Reader = Pick<TenantTx, "select">;

// Bounded like every other read here; one approved row anywhere in the history is all the check needs.
const MAX_VERSIONS_INSPECTED = 200;

export interface PublishActor {
  userId: string;
  orgId: string;
  membershipId: number | null;
}

/**
 * Publishing, re-scoping and withdrawing a knowledge-base entry for an HR document. This decides nothing about
 * what a document IS (that is the classification, PR 3) and nothing about who may READ an entry (that is the
 * query service, in SQL). It guards the writes: the document must be publishable right now, the entry's audience
 * must sit inside the document's, and every refusal is audited outside the transaction so it survives the
 * rollback. The database refuses the same link again (`trg_kb_linked_documents_guard`), so a caller that skipped
 * this service still could not link a personal document.
 */
@Injectable()
export class KbLinkedDocumentPublishService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly flags: KbHrLinkFlagsService,
  ) {}

  async getState(orgId: string, documentId: number): Promise<KbLinkState> {
    await this.flags.assertEnabled(orgId, "link");
    return loadLinkState(this.db, orgId, documentId);
  }

  async publish(actor: PublishActor, documentId: number, input: PublishLinkInput): Promise<KbLinkState> {
    const { orgId } = actor;
    await this.flags.assertEnabled(orgId, "link");
    await this.refuseAhead(actor, documentId, "publish", async () => judgeAudience(this.db, orgId, documentId, input.audiences));

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const verdict = await judgeAudience(tx, orgId, documentId, input.audiences, true);
        if (verdict.refusal) throw verdict.refusal;
        const [active] = await tx
          .select({ id: kbLinkedDocuments.id })
          .from(kbLinkedDocuments)
          .where(and(eq(kbLinkedDocuments.orgId, orgId), eq(kbLinkedDocuments.documentId, documentId), eq(kbLinkedDocuments.status, "active")))
          .limit(1);
        if (active) throw new ConflictException({ code: "LINK_ALREADY_ACTIVE", message: "This document is already in the knowledge base." });

        const mode = this.modeOf(input);
        await this.assertPinExists(tx, orgId, documentId, mode);
        const [previous] = await tx
          .select({ id: kbLinkedDocuments.id })
          .from(kbLinkedDocuments)
          .where(and(eq(kbLinkedDocuments.orgId, orgId), eq(kbLinkedDocuments.documentId, documentId), inArray(kbLinkedDocuments.status, ["unpublished", "source_removed"])))
          .orderBy(desc(kbLinkedDocuments.id))
          .limit(1)
          .for("update");

        // Bringing back a withdrawn entry keeps its id, so a bookmark to it works again.
        const live: KbLinkedDocumentStatus = "active";
        const values = {
          status: live,
          versionMode: mode.versionMode,
          pinnedVersion: mode.pinnedVersion,
          publishedByMembershipId: actor.membershipId,
          publishedAt: new Date(),
          unpublishedAt: null,
          unpublishedByMembershipId: null,
          unpublishReason: null,
          sourceRemovedAt: null,
          updatedAt: new Date(),
        };
        let linkId: number;
        if (previous) {
          linkId = previous.id;
          await tx.update(kbLinkedDocuments).set(values).where(and(eq(kbLinkedDocuments.orgId, orgId), eq(kbLinkedDocuments.id, linkId)));
          await tx.delete(kbLinkedDocumentAudiences).where(and(eq(kbLinkedDocumentAudiences.orgId, orgId), eq(kbLinkedDocumentAudiences.linkedDocumentId, linkId)));
        } else {
          const [created] = await tx.insert(kbLinkedDocuments).values({ orgId, documentId, ...values }).returning({ id: kbLinkedDocuments.id });
          if (!created) throw new NotFoundException("Document not found.");
          linkId = created.id;
        }
        await this.writeAudiences(tx, orgId, linkId, verdict.audiences);

        await this.audit.logCritical({
          action: "hr.document.kb_published",
          userId: actor.userId,
          orgId,
          targetId: String(documentId),
          targetType: "document",
          metadata: { linkId, reactivated: previous !== undefined, versionMode: mode.versionMode, pinnedVersion: mode.pinnedVersion, audiences: verdict.audiences },
        });
        return loadLinkState(tx, orgId, documentId);
      },
      { orgId },
    );
  }

  async updateLink(actor: PublishActor, documentId: number, input: UpdateLinkInput): Promise<KbLinkState> {
    const { orgId } = actor;
    await this.flags.assertEnabled(orgId, "link");
    await this.refuseAhead(actor, documentId, "update", async () => judgeAudience(this.db, orgId, documentId, input.audiences ?? []));

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const verdict = input.audiences === undefined ? null : await judgeAudience(tx, orgId, documentId, input.audiences, true);
        if (verdict?.refusal) throw verdict.refusal;
        const [link] = await tx
          .select({ id: kbLinkedDocuments.id, versionMode: kbLinkedDocuments.versionMode, pinnedVersion: kbLinkedDocuments.pinnedVersion })
          .from(kbLinkedDocuments)
          .where(and(eq(kbLinkedDocuments.orgId, orgId), eq(kbLinkedDocuments.documentId, documentId), eq(kbLinkedDocuments.status, "active")))
          .limit(1)
          .for("update");
        if (!link) throw new NotFoundException("This document is not in the knowledge base.");

        const before = { versionMode: link.versionMode, pinnedVersion: link.pinnedVersion, audiences: await this.audiencesOfLink(tx, orgId, link.id) };
        if (input.versionMode !== undefined) {
          const mode = this.modeOf(input);
          await this.assertPinExists(tx, orgId, documentId, mode);
          await tx.update(kbLinkedDocuments).set({ versionMode: mode.versionMode, pinnedVersion: mode.pinnedVersion, updatedAt: new Date() }).where(and(eq(kbLinkedDocuments.orgId, orgId), eq(kbLinkedDocuments.id, link.id)));
        }
        if (verdict) {
          await tx.delete(kbLinkedDocumentAudiences).where(and(eq(kbLinkedDocumentAudiences.orgId, orgId), eq(kbLinkedDocumentAudiences.linkedDocumentId, link.id)));
          await this.writeAudiences(tx, orgId, link.id, verdict.audiences);
        }
        const after = { versionMode: input.versionMode ?? link.versionMode, pinnedVersion: input.versionMode === undefined ? link.pinnedVersion : this.modeOf(input).pinnedVersion, audiences: verdict?.audiences ?? before.audiences };
        await this.audit.logCritical({
          action: "hr.document.kb_link_updated",
          userId: actor.userId,
          orgId,
          targetId: String(documentId),
          targetType: "document",
          before,
          after,
          metadata: { linkId: link.id },
        });
        return loadLinkState(tx, orgId, documentId);
      },
      { orgId },
    );
  }

  async unpublish(actor: PublishActor, documentId: number, input: UnpublishLinkInput = {}): Promise<KbLinkState> {
    const { orgId } = actor;
    // "manual" is the code for a withdrawal nobody explained; the audit row says whether a reason was really given.
    const reason = input.reason ?? "manual";
    await this.flags.assertEnabled(orgId, "link");
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const [link] = await tx
          .update(kbLinkedDocuments)
          .set({ status: "unpublished", unpublishedAt: new Date(), unpublishedByMembershipId: actor.membershipId, unpublishReason: reason, updatedAt: new Date() })
          .where(and(eq(kbLinkedDocuments.orgId, orgId), eq(kbLinkedDocuments.documentId, documentId), eq(kbLinkedDocuments.status, "active")))
          .returning({ id: kbLinkedDocuments.id });
        if (!link) throw new NotFoundException("This document is not in the knowledge base.");
        await this.audit.logCritical({
          action: "hr.document.kb_unpublished",
          userId: actor.userId,
          orgId,
          targetId: String(documentId),
          targetType: "document",
          metadata: { linkId: link.id, reason, reasonGiven: input.reason !== undefined },
        });
        return loadLinkState(tx, orgId, documentId);
      },
      { orgId },
    );
  }

  private modeOf(input: { versionMode?: "FOLLOW_LATEST" | "PINNED"; pinnedVersion?: number }) {
    const versionMode = input.versionMode ?? "FOLLOW_LATEST";
    return { versionMode, pinnedVersion: versionMode === "PINNED" ? (input.pinnedVersion ?? null) : null };
  }

  /**
   * Whichever mode the entry is in, it must point at content a reader can actually open.
   *
   * PINNED names its version, so that version has to exist and be approved. FOLLOW_LATEST reads the document's
   * own current file — which normally IS the latest approved version, because approving one is what writes it —
   * except for a document whose file was never set (an external link, or a metadata-only row) and which then had
   * a version uploaded but never approved. That document has version history and no approved content at all, and
   * publishing it put an entry in the knowledge base with nothing behind it (V-151).
   */
  private async assertPinExists(reader: Reader, orgId: string, documentId: number, mode: { versionMode: string; pinnedVersion: number | null }): Promise<void> {
    if (mode.versionMode !== "PINNED" || mode.pinnedVersion === null) return this.assertFollowableVersion(reader, orgId, documentId);
    const [found] = await reader
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(and(eq(documentVersions.orgId, orgId), eq(documentVersions.documentId, documentId), eq(documentVersions.version, mode.pinnedVersion), eq(documentVersions.status, "approved")))
      .limit(1);
    if (found) return;
    throw new HttpException({ code: "PINNED_VERSION_NOT_FOUND", message: "That version of the document does not exist or has not been approved." }, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  /**
   * A document with version history but nothing approved in it has no content anyone may read. A document with
   * no history at all is fine: its file IS the document, and there is no draft to confuse it with.
   */
  private async assertFollowableVersion(reader: Reader, orgId: string, documentId: number): Promise<void> {
    const rows = await reader
      .select({ status: documentVersions.status })
      .from(documentVersions)
      .where(and(eq(documentVersions.orgId, orgId), eq(documentVersions.documentId, documentId)))
      .limit(MAX_VERSIONS_INSPECTED);
    if (rows.length === 0 || rows.some((row) => row.status === "approved")) return;
    throw new HttpException(
      {
        code: "DOCUMENT_VERSION_NOT_APPROVED",
        message: "Every version of this document is still waiting to be approved, so there is nothing for readers to open. Approve one first.",
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  // The refusal is delivered by throwing, which rolls the request transaction back, so its audit row is written on its own connection first.
  private async refuseAhead(actor: PublishActor, documentId: number, attempted: string, judgeNow: () => Promise<{ refusal: HttpException | null; blockers: PublishBlocker[] }>): Promise<void> {
    const verdict = await judgeNow();
    if (!verdict.refusal) return;
    const body = verdict.refusal.getResponse();
    await this.audit.logCriticalOutsideTransaction({
      action: "kb.hr_link.publish_refused",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(documentId),
      targetType: "document",
      result: "FAILURE",
      metadata: { attempted, reason: typeof body === "object" && "code" in body ? body.code : "REFUSED", blockers: verdict.blockers.map((blocker) => blocker.code) },
    });
    throw verdict.refusal;
  }

  private async writeAudiences(tx: TenantTx, orgId: string, linkedDocumentId: number, audiences: readonly AudienceKey[]): Promise<void> {
    if (audiences.length === 0) return;
    await tx.insert(kbLinkedDocumentAudiences).values(audiences.map((audience) => ({ orgId, linkedDocumentId, kind: audience.kind, refId: audience.refId })));
  }

  private async audiencesOfLink(reader: Reader, orgId: string, linkedDocumentId: number): Promise<AudienceKey[]> {
    return reader
      .select({ kind: kbLinkedDocumentAudiences.kind, refId: kbLinkedDocumentAudiences.refId })
      .from(kbLinkedDocumentAudiences)
      .where(and(eq(kbLinkedDocumentAudiences.orgId, orgId), eq(kbLinkedDocumentAudiences.linkedDocumentId, linkedDocumentId)))
      .limit(MAX_DOCUMENT_AUDIENCES);
  }
}
