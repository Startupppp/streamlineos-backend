import { createHash } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import {
  aiChatConversations,
  aiChatMessages,
  auditLogs,
  chatMessages,
  hrDataRequests,
  hrDependents,
  hrEmployeeSensitiveFields,
  hrEmployments,
  hrLegalHolds,
  hrPeople,
  kbArticleAttachments,
  kbArticleChunks,
  kbArticles,
  kbChatConversations,
  kbChatMessages,
  kbSources,
  organizationMembers,
  organizationPeople,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { bustMembershipStatusCache } from "../../common/auth/membership-state.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { SessionsService } from "../sessions/sessions.service";

const ERASED_NAME = "ERASED";
const ERASED_CONTENT = "[ERASED]";
const ERASURE_ID_PAGE = 200;

/** Drains every page rather than capping, so a partial erasure cannot report as complete. */
async function drainIds<T extends { id: number }>(
  pageSize: number,
  page: (cursor: number | null) => Promise<T[]>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: number | null = null;
  for (;;) {
    const rows = await page(cursor);
    all.push(...rows);
    if (rows.length < pageSize) return all;
    const last = rows[rows.length - 1];
    if (!last || last.id === cursor) return all;
    cursor = last.id;
  }
}

export interface SubjectErasureResult {
  blocked: boolean;
  blockReason?: string;
  holdId?: number;
  dryRun: boolean;
  tablesAnonymised: string[];
  globalIdentityAnonymised: boolean;
}

/**
 * Idempotent, tenant-scoped PII erasure for a single subject.
 * Anonymises: organization_people, hr_employee_sensitive_fields, hr_dependents,
 * ai_chat_conversations (title), ai_chat_messages (content), chat_messages (content),
 * and (when no other org memberships remain) the global users identity row.
 * Hard-deletes: kb_chat_messages, kb_chat_conversations, kb_article_chunks where the
 * subject authored the source page, article, or uploaded source document (embedding +
 * chunk text are a reproduction of the subject's text and must be fully removed).
 */
@Injectable()
export class GdprSubjectErasureService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly sessionsService: SessionsService,
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
      };
    }

    if (options.dryRun) {
      return {
        blocked: false,
        dryRun: true,
        tablesAnonymised: [
          "organization_people",
          "hr_employee_sensitive_fields",
          "hr_dependents",
          "ai_chat_conversations",
          "ai_chat_messages",
          "chat_messages",
          "kb_chat_messages",
          "kb_chat_conversations",
          "kb_article_chunks",
        ],
        globalIdentityAnonymised: false,
      };
    }

    const tablesAnonymised: string[] = [];
    let globalIdentityAnonymised = false;

    await this.db.transaction(async (tx) => {
      const opResult = await tx
        .update(organizationPeople)
        .set({
          firstName: ERASED_NAME,
          lastName: ERASED_NAME,
          displayName: null,
          preferredName: null,
          workEmail: null,
          personalEmail: null,
          phone: null,
          whatsappNumber: null,
          dateOfBirth: null,
          gender: null,
          nationality: null,
          address: null,
          emergencyContact: null,
          bio: null,
          linkedinUrl: null,
          githubUrl: null,
          avatarUrl: null,
        })
        .where(
          and(
            eq(organizationPeople.organizationId, orgId),
            eq(organizationPeople.userId, subjectUserId),
          ),
        )
        .returning({ id: organizationPeople.organizationPersonId });
      if (opResult.length > 0) tablesAnonymised.push("organization_people");

      // A bare `.limit(n)` here would report a partial erasure as a complete one.
      const peopleRows = await drainIds(ERASURE_ID_PAGE, (cursor) =>
        tx
          .select({ id: hrPeople.id })
          .from(hrPeople)
          .where(
            and(
              eq(hrPeople.orgId, orgId),
              eq(hrPeople.userId, subjectUserId),
              isNull(hrPeople.deletedAt),
              ...(cursor === null ? [] : [gt(hrPeople.id, cursor)]),
            ),
          )
          .orderBy(asc(hrPeople.id))
          .limit(ERASURE_ID_PAGE),
      );

      if (peopleRows.length > 0) {
        const personIds = peopleRows.map((p) => p.id);
        const employmentRows = await drainIds(ERASURE_ID_PAGE, (cursor) =>
          tx
            .select({ id: hrEmployments.id })
            .from(hrEmployments)
            .where(
              and(
                eq(hrEmployments.orgId, orgId),
                inArray(hrEmployments.personId, personIds),
                isNull(hrEmployments.deletedAt),
                ...(cursor === null ? [] : [gt(hrEmployments.id, cursor)]),
              ),
            )
            .orderBy(asc(hrEmployments.id))
            .limit(ERASURE_ID_PAGE),
        );

        if (employmentRows.length > 0) {
          const employmentIds = employmentRows.map((e) => e.id);
          const sfResult = await tx
            .update(hrEmployeeSensitiveFields)
            .set({
              bankDetails: null,
              encryptionKeyRef: null,
              taxId: null,
              panNumber: null,
              nationalId: null,
              passportNumber: null,
              passportExpiry: null,
              visaType: null,
              visaExpiry: null,
              medicalNotes: null,
              bloodGroup: null,
              disciplinaryRecords: null,
              grievanceRecords: null,
            })
            .where(
              and(
                eq(hrEmployeeSensitiveFields.orgId, orgId),
                inArray(hrEmployeeSensitiveFields.employmentId, employmentIds),
              ),
            )
            .returning({ id: hrEmployeeSensitiveFields.id });
          if (sfResult.length > 0) tablesAnonymised.push("hr_employee_sensitive_fields");
        }
      }

      const depResult = await tx
        .update(hrDependents)
        .set({ name: ERASED_NAME, dateOfBirth: null })
        .where(
          and(
            eq(hrDependents.orgId, orgId),
            eq(hrDependents.userId, subjectUserId),
          ),
        )
        .returning({ id: hrDependents.id });
      if (depResult.length > 0) tablesAnonymised.push("hr_dependents");

      const aiConvResult = await tx
        .update(aiChatConversations)
        .set({ title: ERASED_CONTENT })
        .where(
          and(
            eq(aiChatConversations.orgId, orgId),
            eq(aiChatConversations.userId, subjectUserId),
          ),
        )
        .returning({ id: aiChatConversations.id });
      if (aiConvResult.length > 0) tablesAnonymised.push("ai_chat_conversations");

      const aiMsgResult = await tx
        .update(aiChatMessages)
        .set({ content: ERASED_CONTENT })
        .where(
          and(
            eq(aiChatMessages.orgId, orgId),
            eq(aiChatMessages.userId, subjectUserId),
          ),
        )
        .returning({ id: aiChatMessages.id });
      if (aiMsgResult.length > 0) tablesAnonymised.push("ai_chat_messages");

      const chatMsgResult = await tx
        .update(chatMessages)
        .set({ content: ERASED_CONTENT })
        .where(
          and(
            eq(chatMessages.orgId, orgId),
            eq(chatMessages.senderMembershipId, membership.id),
          ),
        )
        .returning({ id: chatMessages.id });
      if (chatMsgResult.length > 0) tablesAnonymised.push("chat_messages");

      const [otherMembership] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.userId, subjectUserId),
            ne(organizationMembers.orgId, orgId),
          ),
        )
        .limit(1);

      if (!otherMembership) {
        const erasedEmail = `erased-${this.hashId(subjectUserId)}@erased.invalid`;
        await tx
          .update(users)
          .set({
            name: ERASED_NAME,
            firstName: ERASED_NAME,
            lastName: ERASED_NAME,
            email: erasedEmail,
            phone: null,
            whatsappNumber: null,
            dateOfBirth: null,
            gender: null,
            emergencyContact: null,
            bio: null,
            image: null,
            linkedinUrl: null,
            twitterUrl: null,
            githubUrl: null,
            websiteUrl: null,
            metadata: null,
          })
          .where(eq(users.id, subjectUserId));
        globalIdentityAnonymised = true;
        tablesAnonymised.push("users");
      }

      const kbMsgResult = await tx
        .delete(kbChatMessages)
        .where(
          and(
            eq(kbChatMessages.orgId, orgId),
            eq(kbChatMessages.userMembershipId, membership.id),
          ),
        )
        .returning({ id: kbChatMessages.id });
      if (kbMsgResult.length > 0) tablesAnonymised.push("kb_chat_messages");

      const kbConvResult = await tx
        .delete(kbChatConversations)
        .where(
          and(
            eq(kbChatConversations.orgId, orgId),
            eq(kbChatConversations.userMembershipId, membership.id),
          ),
        )
        .returning({ id: kbChatConversations.id });
      if (kbConvResult.length > 0) tablesAnonymised.push("kb_chat_conversations");

      const pageChunkResult = await tx
        .delete(kbArticleChunks)
        .where(
          and(
            eq(kbArticleChunks.orgId, orgId),
            eq(kbArticleChunks.pageCreatedById, subjectUserId),
          ),
        )
        .returning({ id: kbArticleChunks.id });
      if (pageChunkResult.length > 0) tablesAnonymised.push("kb_article_chunks");

      const authoredArticles = await tx
        .select({ id: kbArticles.id })
        .from(kbArticles)
        .where(
          and(
            eq(kbArticles.orgId, orgId),
            eq(kbArticles.authorId, subjectUserId),
          ),
        );
      if (authoredArticles.length > 0) {
        const articleIds = authoredArticles.map((a) => a.id);
        const articleChunkResult = await tx
          .delete(kbArticleChunks)
          .where(
            and(
              eq(kbArticleChunks.orgId, orgId),
              inArray(kbArticleChunks.articleId, articleIds),
            ),
          )
          .returning({ id: kbArticleChunks.id });
        if (articleChunkResult.length > 0 && !tablesAnonymised.includes("kb_article_chunks"))
          tablesAnonymised.push("kb_article_chunks");
      }

      const ownedSources = await tx
        .select({ id: kbSources.id })
        .from(kbSources)
        .where(
          and(
            eq(kbSources.orgId, orgId),
            eq(kbSources.createdById, subjectUserId),
          ),
        );
      if (ownedSources.length > 0) {
        const sourceIds = ownedSources.map((s) => s.id);
        const sourceChunkResult = await tx
          .delete(kbArticleChunks)
          .where(
            and(
              eq(kbArticleChunks.orgId, orgId),
              inArray(kbArticleChunks.sourceId, sourceIds),
            ),
          )
          .returning({ id: kbArticleChunks.id });
        if (sourceChunkResult.length > 0 && !tablesAnonymised.includes("kb_article_chunks"))
          tablesAnonymised.push("kb_article_chunks");
      }

      const uploadedAttachments = await tx
        .select({ id: kbArticleAttachments.id })
        .from(kbArticleAttachments)
        .where(
          and(
            eq(kbArticleAttachments.orgId, orgId),
            eq(kbArticleAttachments.uploadedBy, subjectUserId),
          ),
        );
      if (uploadedAttachments.length > 0) {
        const attachmentIds = uploadedAttachments.map((a) => a.id);
        const attachmentChunkResult = await tx
          .delete(kbArticleChunks)
          .where(
            and(
              eq(kbArticleChunks.orgId, orgId),
              inArray(kbArticleChunks.attachmentId, attachmentIds),
            ),
          )
          .returning({ id: kbArticleChunks.id });
        if (attachmentChunkResult.length > 0 && !tablesAnonymised.includes("kb_article_chunks"))
          tablesAnonymised.push("kb_article_chunks");
      }

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
          subjectUserIdHash: this.hashId(subjectUserId),
        },
        isPlatformEvent: false,
      });

      await bumpPermissionsVersion(tx, orgId);
    });

    await bustMembershipStatusCache(this.cache, subjectUserId);
    await this.sessionsService.revokeAllForUser(subjectUserId);

    return {
      blocked: false,
      dryRun: false,
      tablesAnonymised,
      globalIdentityAnonymised,
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

  private hashId(id: string): string {
    return createHash("sha256").update(id).digest("hex").slice(0, 16);
  }
}
