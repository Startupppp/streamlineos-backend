import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  auditLogs,
  hrDataRequests,
  hrLegalHolds,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { bustMembershipStatusCache } from "../../common/auth/membership-state.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { SessionsService } from "../sessions/sessions.service";
import { anonymiseSubjectSupportTickets } from "../support/core/support-ticket-erasure";
import { GdprStoragePurgeService, type PurgeManifest } from "./gdpr-storage-purge.service";
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
import {
  anonymiseSubjectConversations,
  eraseSubjectKbContent,
} from "./gdpr-subject-erasure-authored-content";
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

/**
 * Idempotent, tenant-scoped PII erasure for a single subject. Sequences the four
 * erasure boundaries inside one transaction — identity redaction
 * (`gdpr-subject-erasure-identity`), authored content
 * (`gdpr-subject-erasure-authored-content`), support tickets and export artifacts —
 * then revokes access and purges object storage.
 *
 * Purges every object-storage file the subject owns using a manifest captured before
 * the database transaction, so a nulled key column cannot orphan its object.
 */
@Injectable()
export class GdprSubjectErasureService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly sessionsService: SessionsService,
    private readonly storagePurge: GdprStoragePurgeService,
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
    if (!membership) throw new NotFoundException("Subject not found in this organization");

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

    // Captured before anything is anonymised: an erased `*_key` column no longer names
    // the object it pointed at, and a manifest built afterwards would leave that object
    // alive in the bucket with its record gone.
    const storageManifest: PurgeManifest = await this.storagePurge.buildManifest(
      subjectUserId,
      [orgId],
    );

    // A sink the catalog cannot reach on its own: `gdpr_export_jobs.subject_user_id` is a
    // bare `text` column with no foreign key to `users`, so `collectSubjectFileKeys...`
    // classifies the table as org-scoped and `purgeFromManifest` deliberately skips
    // org-scoped keys — which left the subject's own export archive, a complete dump of
    // their personal data, alive in the bucket after their erasure.
    if (!storageManifest.blocked)
      storageManifest.keys.push(
        ...(await collectSubjectExportArtifactKeys(this.db, { orgId, subjectUserId })),
      );

    if (options.dryRun) {
      return {
        blocked: false,
        dryRun: true,
        tablesAnonymised: [...DRY_RUN_TABLES],
        globalIdentityAnonymised: false,
        storage: { ...NO_STORAGE_WORK, manifestSize: storageManifest.keys.length },
      };
    }

    const tablesAnonymised: string[] = [];
    let globalIdentityAnonymised = false;
    const scope = { orgId, subjectUserId, membershipId: membership.id };

    // Asked out here, on its own identity-scoped connection, because the transaction
    // below cannot answer it: `organization_members` admits a row only when its org is
    // the tenant GUC's or its user is `app.user_id`, and a tenant transaction never sets
    // the second. Inside, this guard read 0 rows for every subject and the shared `users`
    // row — which has no RLS of its own — was redacted out from under whatever OTHER
    // organisation the subject still belongs to. See `subjectHasSurvivingMembership`.
    const hasSurvivingMembership = await subjectHasSurvivingMembership(this.db, scope);

    await this.db.transaction(async (tx) => {
      tablesAnonymised.push(...(await anonymiseSubjectProfile(tx, scope)));
      const conversations = await anonymiseSubjectConversations(tx, scope);
      tablesAnonymised.push(...conversations.tables);

      // `chat_attachments` hangs off `chat_messages.sender_membership_id` with no foreign
      // key to `users`, so the file-key catalog classifies it org-scoped and the purge
      // skips it. Deleted here with RETURNING, and the keys ride the manifest that is
      // drained after this transaction commits.
      const attachmentKeys = storageManifest.blocked
        ? []
        : await purgeSubjectChatAttachments(tx, { orgId }, conversations.chatMessageIds);
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
      const supportErasure = await anonymiseSubjectSupportTickets(tx, { orgId, subjectUserId });
      if (supportErasure.ticketsAnonymised > 0) tablesAnonymised.push("support_tickets");
      if (supportErasure.embeddingsDeleted > 0) tablesAnonymised.push("support_ticket_embeddings");

      globalIdentityAnonymised = await anonymiseGlobalIdentity(tx, scope, {
        hasSurvivingMembership,
      });
      if (globalIdentityAnonymised) tablesAnonymised.push("users");

      tablesAnonymised.push(...(await eraseSubjectKbContent(tx, scope)));

      await tx.insert(hrDataRequests).values({
        orgId,
        subjectUserId,
        type: "delete",
        status: "completed",
        requestedBy: actorUserId,
        completedAt: new Date(),
      });

      await tx.insert(auditLogs).values({
        action: "subject.data.erased",
        userId: actorUserId,
        orgId,
        targetId: subjectUserId,
        targetType: "user",
        metadata: {
          tablesAnonymised,
          globalIdentityAnonymised,
          subjectUserIdHash: hashSubjectId(subjectUserId),
        },
        isPlatformEvent: false,
      });

      await bumpPermissionsVersion(tx, orgId);
    });

    await bustMembershipStatusCache(this.cache, subjectUserId);
    await this.sessionsService.revokeAllForUser(subjectUserId);

    const purge = await this.storagePurge.purgeFromManifest(
      storageManifest,
      subjectUserId,
      actorUserId,
      orgId,
      { dryRun: false },
    );
    if (purge.deleted.length > 0) tablesAnonymised.push("object_storage");

    return {
      blocked: false,
      dryRun: false,
      tablesAnonymised,
      globalIdentityAnonymised,
      storage: {
        manifestSize: storageManifest.keys.length,
        deleted: purge.deleted.length,
        skipped: purge.skipped.length,
        failed: purge.failed.length,
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
