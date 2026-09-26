import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  auditLogs,
  externalEffectLedger,
  hrDataRequests,
  hrLegalHolds,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { bustMembershipAfterIdentityErasure } from "../../common/org/membership-bust";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { ExternalEffectLedger } from "../../common/outbox/external-effect-ledger";
import { SessionsService } from "../sessions/sessions.service";
import { anonymiseSubjectSupportTickets } from "../support/core/support-ticket-erasure";
import {
  eraseSubjectDocumentDerivatives,
  type DocumentReindexPort,
} from "../kb/core/kb-subject-erasure";
import { KbPageWriterService } from "../kb/wiki/kb-page-writer.service";
import {
  GdprStoragePurgeService,
  type PurgeManifest,
} from "./gdpr-storage-purge.service";
import {
  collectSubjectExportArtifactKeys,
  retireSubjectExportArtifacts,
} from "./gdpr-subject-erasure-export-artifacts";
import {
  anonymiseGlobalIdentity,
  anonymiseSubjectProfile,
  hashSubjectId,
  subjectHasSurvivingMembership,
} from "./gdpr-subject-erasure-identity";
import { anonymiseSubjectConversations } from "./gdpr-subject-erasure-authored-content";
import { purgeSubjectChatAttachments } from "./gdpr-subject-erasure-chat-attachments";

export interface SubjectErasureStorageResult {
  manifestSize: number;
  deleted: number;
  skipped: number;
  failed: number;
}

export interface SubjectErasureResult {
  blocked: boolean;
  blockReason?: string;
  holdId?: number;
  dryRun: boolean;
  tablesAnonymised: string[];
  globalIdentityAnonymised: boolean;
  storage: SubjectErasureStorageResult;
}

const NO_STORAGE_WORK: SubjectErasureStorageResult = {
  manifestSize: 0,
  deleted: 0,
  skipped: 0,
  failed: 0,
};

const DRY_RUN_TABLES = [
  "organization_people",
  "hr_employee_sensitive_fields",
  "hr_dependents",
  "ai_chat_conversations",
  "ai_chat_messages",
  "chat_messages",
  "chat_attachments",
  "support_tickets",
  "support_ticket_embeddings",
  "gdpr_export_jobs",
  "kb_chat_messages",
  "kb_chat_conversations",
  "kb_article_chunks",
  "kb_ingestion_checkpoints",
];

@Injectable()
export class GdprSubjectErasureService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly sessionsService: SessionsService,
    private readonly storagePurge: GdprStoragePurgeService,
    private readonly effectLedger: ExternalEffectLedger,
    @Inject(KbPageWriterService)
    private readonly documentWriter: DocumentReindexPort,
  ) {}

  async eraseSubject(
    subjectUserId: string,
    orgId: string,
    actorUserId: string,
    options: { dryRun: boolean },
  ): Promise<SubjectErasureResult> {
    const [membership] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, subjectUserId),
        ),
      )
      .limit(1);
    if (!membership)
      throw new NotFoundException("Subject not found in this organization");

    const hold = await this.findActiveLegalHold(subjectUserId, orgId);
    if (hold) {
      return {
        blocked: true,
        blockReason: hold.reason,
        holdId: hold.id,
        dryRun: options.dryRun,
        tablesAnonymised: [],
        globalIdentityAnonymised: false,
        storage: NO_STORAGE_WORK,
      };
    }

    const storageManifest: PurgeManifest =
      await this.storagePurge.buildManifest(subjectUserId, [orgId]);

    if (!storageManifest.blocked)
      storageManifest.keys.push(
        ...(await collectSubjectExportArtifactKeys(this.db, {
          orgId,
          subjectUserId,
        })),
      );

    if (options.dryRun) {
      return {
        blocked: false,
        dryRun: true,
        tablesAnonymised: [...DRY_RUN_TABLES],
        globalIdentityAnonymised: false,
        storage: {
          ...NO_STORAGE_WORK,
          manifestSize: storageManifest.keys.length,
        },
      };
    }

    const tablesAnonymised: string[] = [];
    let globalIdentityAnonymised = false;
    const scope = { orgId, subjectUserId, membershipId: membership.id };

    const hasSurvivingMembership = await subjectHasSurvivingMembership(
      this.db,
      scope,
    );

    let dataRequestId: number | undefined;

    await this.db.transaction(async (tx) => {
      tablesAnonymised.push(...(await anonymiseSubjectProfile(tx, scope)));
      const conversations = await anonymiseSubjectConversations(tx, scope);
      tablesAnonymised.push(...conversations.tables);
      const attachmentKeys = storageManifest.blocked
        ? []
        : await purgeSubjectChatAttachments(
            tx,
            { orgId },
            conversations.chatMessageIds,
          );
      if (attachmentKeys.length > 0) {
        tablesAnonymised.push("chat_attachments");
        storageManifest.keys.push(...attachmentKeys);
      }

      const artifactsRetired = await retireSubjectExportArtifacts(tx, {
        orgId,
        subjectUserId,
      });
      if (artifactsRetired > 0) tablesAnonymised.push("gdpr_export_jobs");

      // Must precede the `users.email` update below: `support_tickets.requester_email`
      // is free text with no FK to the subject, so the live address is the only link.
      const supportErasure = await anonymiseSubjectSupportTickets(tx, {
        orgId,
        subjectUserId,
      });
      if (supportErasure.ticketsAnonymised > 0)
        tablesAnonymised.push("support_tickets");
      if (supportErasure.embeddingsDeleted > 0)
        tablesAnonymised.push("support_ticket_embeddings");

      globalIdentityAnonymised = await anonymiseGlobalIdentity(tx, scope, {
        hasSurvivingMembership,
      });
      if (globalIdentityAnonymised) tablesAnonymised.push("users");

      tablesAnonymised.push(
        ...(await eraseSubjectDocumentDerivatives(
          tx,
          scope,
          this.documentWriter,
        )),
      );

      const [dataReq] = await tx
        .insert(hrDataRequests)
        .values({
          orgId,
          subjectUserId,
          type: "delete",
          status: "processing",
          requestedBy: actorUserId,
        })
        .returning({ id: hrDataRequests.id });
      dataRequestId = dataReq?.id;

      if (dataRequestId !== undefined) {
        await tx
          .insert(externalEffectLedger)
          .values({
            organizationId: orgId,
            producerEventId: String(dataRequestId),
            effectKey: `gdpr:storage-purge:${orgId}:${subjectUserId}:${dataRequestId}`,
            effectType: "GDPR_STORAGE_PURGE",
            providerIdempotency: "NONE",
          })
          .onConflictDoNothing({
            target: [
              externalEffectLedger.organizationId,
              externalEffectLedger.effectKey,
            ],
          });
      }

      await tx.insert(auditLogs).values({
        action: "subject.erasure.started",
        userId: actorUserId,
        orgId,
        targetId: subjectUserId,
        targetType: "user",
        metadata: {
          tablesAnonymised,
          globalIdentityAnonymised,
          subjectUserIdHash: hashSubjectId(subjectUserId),
          storageManifestSize: storageManifest.keys.length,
          storageManifestKeys: storageManifest.keys.map((k) => k.key),
        },
        isPlatformEvent: false,
      });

      await bumpPermissionsVersion(tx, orgId);
    });

    await bustMembershipAfterIdentityErasure(this.cache, subjectUserId);
    await this.sessionsService.revokeAllForUser(subjectUserId);

    let purgeDeleted = 0;
    let purgeSkipped = 0;
    let purgeFailed = 0;

    if (dataRequestId !== undefined) {
      const capturedRequestId = dataRequestId;
      const effectKey = `gdpr:storage-purge:${orgId}:${subjectUserId}:${capturedRequestId}`;
      await this.effectLedger.execute(
        {
          organizationId: orgId,
          producerEventId: String(capturedRequestId),
          effectKey,
          effectType: "GDPR_STORAGE_PURGE",
          providerIdempotency: "NONE",
        },
        async () => {
          const purge = await this.storagePurge.purgeFromManifest(
            storageManifest,
            subjectUserId,
            actorUserId,
            orgId,
            { dryRun: false },
          );
          purgeDeleted = purge.deleted.length;
          purgeSkipped = purge.skipped.length;
          purgeFailed = purge.failed.length;

          if (purgeDeleted > 0) tablesAnonymised.push("object_storage");

          const finalStatus: "completed" | "partial" =
            purgeFailed > 0 ? "partial" : "completed";
          await this.db
            .update(hrDataRequests)
            .set({ status: finalStatus, completedAt: new Date() })
            .where(eq(hrDataRequests.id, capturedRequestId));

          await this.db.insert(auditLogs).values({
            action: "subject.data.erased",
            userId: actorUserId,
            orgId,
            targetId: subjectUserId,
            targetType: "user",
            metadata: {
              finalStatus,
              storageDeleted: purgeDeleted,
              storageFailed: purgeFailed,
            },
            isPlatformEvent: false,
          });
        },
      );
    }

    return {
      blocked: false,
      dryRun: false,
      tablesAnonymised,
      globalIdentityAnonymised,
      storage: {
        manifestSize: storageManifest.keys.length,
        deleted: purgeDeleted,
        skipped: purgeSkipped,
        failed: purgeFailed,
      },
    };
  }

  private async findActiveLegalHold(
    userId: string,
    orgId: string,
  ): Promise<{ id: number; reason: string } | null> {
    const [row] = await this.db
      .select({ id: hrLegalHolds.id, reason: hrLegalHolds.reason })
      .from(hrLegalHolds)
      .where(
        and(
          eq(hrLegalHolds.subjectUserId, userId),
          eq(hrLegalHolds.orgId, orgId),
          eq(hrLegalHolds.status, "active"),
          isNull(hrLegalHolds.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}
