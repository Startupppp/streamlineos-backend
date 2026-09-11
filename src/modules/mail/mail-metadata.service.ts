import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { mailMessageMetadata } from "../../db/schema/mail";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { registerAfterCommit } from "../../common/tenant";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { logger } from "../../common/logger/logger.service";
import { keysetBeforeId } from "../../common/pagination/keyset";
import type { MailMessageSummary } from "./dto/mail-response.schemas";
import type { MailFolder } from "./dto/mail-schemas";
import type { MailMetadataCursor } from "./providers/mail-metadata-cursor";

const CACHE_FRESH_SECS = 300;

const SEARCH_ID_CAP = 500;

export interface CachedMailPage {
  messages: CachedMailMessage[];
  hasData: boolean;
  isFresh: boolean;
  nextCursor: MailMetadataCursor | null;
}

export type CachedMailMessage = {
  messageId: string;
  threadId: string | null;
  accountId: number;
  subject: string;
  senderEmail: string;
  senderName: string | null;
  date: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachment: boolean;
  labels: string[] | null;
  folder: string;
};

@Injectable()
export class MailMetadataService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private defer(orgId: string, label: string, work: () => Promise<void>): void {
    const run = async (): Promise<void> => {
      try {
        await runInNewTenantTransaction(this.db, orgId, () => work());
      } catch (err) {
        logger.warn(`[mail-metadata] ${label} failed`, { orgId, err });
      }
    };
    if (!registerAfterCommit(run)) void run();
  }

  deferUpsertBatch(
    accountId: number,
    membershipId: number,
    orgId: string,
    folder: MailFolder,
    messages: MailMessageSummary[],
  ): void {
    this.defer(orgId, "upsertBatch", () =>
      this.upsertBatch(accountId, membershipId, orgId, folder, messages),
    );
  }

  deferUpdateState(
    accountId: number,
    membershipId: number,
    orgId: string,
    messageId: string,
    update: { isRead?: boolean; isStarred?: boolean; folder?: string },
  ): void {
    this.defer(orgId, "updateState", () =>
      this.updateState(accountId, membershipId, orgId, messageId, update),
    );
  }

  async upsertBatch(
    accountId: number,
    membershipId: number,
    orgId: string,
    folder: MailFolder,
    messages: MailMessageSummary[],
  ): Promise<void> {
    if (messages.length === 0) return;
    const now = new Date();
    const rows = messages.map((m) => ({
      accountId,
      userMembershipId: membershipId,
      orgId,
      messageId: m.id,
      threadId: m.threadId ?? null,
      subject: m.subject,
      senderEmail: m.from.email,
      senderName: m.from.name ?? null,
      date: m.date ? new Date(m.date) : null,
      isRead: m.isRead,
      isStarred: m.isStarred,
      hasAttachment: m.hasAttachments,
      folder,
      syncedAt: now,
    }));

    await this.db
      .insert(mailMessageMetadata)
      .values(rows)
      .onConflictDoUpdate({
        target: [mailMessageMetadata.accountId, mailMessageMetadata.messageId],
        set: {
          subject: sql`excluded.subject`,
          senderEmail: sql`excluded.sender_email`,
          senderName: sql`excluded.sender_name`,
          date: sql`excluded.date`,
          isRead: sql`excluded.is_read`,
          isStarred: sql`excluded.is_starred`,
          hasAttachment: sql`excluded.has_attachment`,
          folder: sql`excluded.folder`,
          syncedAt: sql`excluded.synced_at`,
        },
      });
  }

  private async resolveSearchCondition(
    membershipId: number,
    folder: MailFolder,
    query: string,
  ): Promise<SQL> {
    const term = `%${query}%`;
    const fallback = or(
      ilike(mailMessageMetadata.subject, term),
      ilike(mailMessageMetadata.senderEmail, term),
      ilike(mailMessageMetadata.senderName, term),
    );
    const literal = fallback ?? sql`true`;

    try {
      const rows = await this.db.execute(
        sql`SELECT app.search_mail_message_ids(${query}, ${membershipId}, ${folder}, ${SEARCH_ID_CAP + 1}) AS id`,
      );
      if (rows.length > SEARCH_ID_CAP) return literal;
      if (rows.length === 0) return sql`false`;
      return inArray(
        mailMessageMetadata.id,
        rows.map((r) => Number(r["id"])),
      );
    } catch (err) {
      logger.warn(
        "[mail-metadata] indexed search unavailable, falling back to ILIKE",
        { err },
      );
      return literal;
    }
  }

  private keysetCondition(after: MailMetadataCursor): SQL {
    if (after.d === null) {
      const clause = or(
        and(
          isNull(mailMessageMetadata.date),
          lt(mailMessageMetadata.id, after.i),
        ),
        isNotNull(mailMessageMetadata.date),
      );
      return clause ?? sql`true`;
    }
    return keysetBeforeId(mailMessageMetadata.date, mailMessageMetadata.id, {
      sortValue: after.d,
      id: String(after.i),
    });
  }

  /**
   * `accountId` accepts a set, not just one id.
   *
   * The keyset index is `(org_id, user_membership_id, folder, date DESC,
   * id DESC)` — it does not lead with `account_id`, so ordering the union of a
   * member's mailboxes is the same single index walk as ordering one of them.
   * That is what makes the mirror usable for the default `?accountId=all` view
   * rather than only for a mailbox the reader has singled out.
   *
   * `null` still means "every row this membership has mirrored in this folder",
   * which includes mailboxes since disconnected; a caller that must not show
   * those passes its live account ids instead.
   */
  async listCached(
    membershipId: number,
    orgId: string,
    accountId: number | readonly number[] | null,
    folder: MailFolder,
    limit: number,
    query?: string,
    after?: MailMetadataCursor,
  ): Promise<CachedMailPage> {
    const conditions = [
      eq(mailMessageMetadata.orgId, orgId),
      eq(mailMessageMetadata.userMembershipId, membershipId),
      eq(mailMessageMetadata.folder, folder),
    ];
    if (typeof accountId === "number")
      conditions.push(eq(mailMessageMetadata.accountId, accountId));
    else if (accountId !== null)
      conditions.push(inArray(mailMessageMetadata.accountId, [...accountId]));
    if (query)
      conditions.push(
        await this.resolveSearchCondition(membershipId, folder, query),
      );
    if (after) conditions.push(this.keysetCondition(after));

    const rows = await this.db
      .select({
        id: mailMessageMetadata.id,
        messageId: mailMessageMetadata.messageId,
        threadId: mailMessageMetadata.threadId,
        accountId: mailMessageMetadata.accountId,
        subject: mailMessageMetadata.subject,
        senderEmail: mailMessageMetadata.senderEmail,
        senderName: mailMessageMetadata.senderName,
        date: mailMessageMetadata.date,
        isRead: mailMessageMetadata.isRead,
        isStarred: mailMessageMetadata.isStarred,
        hasAttachment: mailMessageMetadata.hasAttachment,
        labels: mailMessageMetadata.labels,
        folder: mailMessageMetadata.folder,
        syncedAt: mailMessageMetadata.syncedAt,
      })
      .from(mailMessageMetadata)
      .where(and(...conditions))
      .orderBy(desc(mailMessageMetadata.date), desc(mailMessageMetadata.id))
      .limit(limit + 1);

    if (rows.length === 0)
      return { messages: [], hasData: false, isFresh: false, nextCursor: null };

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    const cutoff = new Date(Date.now() - CACHE_FRESH_SECS * 1000);
    const latestSync = page.reduce<Date>(
      (latest, r) => (r.syncedAt > latest ? r.syncedAt : latest),
      page[0]!.syncedAt,
    );
    const isFresh = latestSync > cutoff;

    return {
      messages: page.map((r) => ({
        messageId: r.messageId,
        threadId: r.threadId,
        accountId: r.accountId,
        subject: r.subject,
        senderEmail: r.senderEmail,
        senderName: r.senderName,
        date: r.date ? r.date.toISOString() : new Date(0).toISOString(),
        isRead: r.isRead,
        isStarred: r.isStarred,
        hasAttachment: r.hasAttachment,
        labels: r.labels,
        folder: r.folder,
      })),
      hasData: true,
      isFresh,
      nextCursor:
        hasMore && last
          ? { d: last.date ? last.date.toISOString() : null, i: last.id }
          : null,
    };
  }

  async countUnread(
    orgId: string,
    membershipId: number,
    folder: MailFolder,
    accountIds: readonly number[],
  ): Promise<number> {
    if (accountIds.length === 0) return 0;
    const rows = await this.db
      .select({ cnt: count() })
      .from(mailMessageMetadata)
      .where(
        and(
          eq(mailMessageMetadata.orgId, orgId),
          eq(mailMessageMetadata.userMembershipId, membershipId),
          eq(mailMessageMetadata.folder, folder),
          eq(mailMessageMetadata.isRead, false),
          inArray(mailMessageMetadata.accountId, [...accountIds]),
        ),
      );
    return Number(rows[0]?.cnt ?? 0);
  }

  async freshAccountIds(
    orgId: string,
    accountIds: readonly number[],
    folder: MailFolder,
  ): Promise<number[]> {
    if (accountIds.length === 0) return [];
    const cutoff = new Date(Date.now() - CACHE_FRESH_SECS * 1000);
    const rows = await this.db
      .selectDistinct({ accountId: mailMessageMetadata.accountId })
      .from(mailMessageMetadata)
      .where(
        and(
          eq(mailMessageMetadata.orgId, orgId),
          inArray(mailMessageMetadata.accountId, [...accountIds]),
          eq(mailMessageMetadata.folder, folder),
          gt(mailMessageMetadata.syncedAt, cutoff),
        ),
      );
    return rows.map((r) => r.accountId);
  }

  async isFreshForAccount(
    orgId: string,
    accountId: number,
    folder: MailFolder,
  ): Promise<boolean> {
    const cutoff = new Date(Date.now() - CACHE_FRESH_SECS * 1000);
    const [row] = await this.db
      .select({ syncedAt: mailMessageMetadata.syncedAt })
      .from(mailMessageMetadata)
      .where(
        and(
          eq(mailMessageMetadata.orgId, orgId),
          eq(mailMessageMetadata.accountId, accountId),
          eq(mailMessageMetadata.folder, folder),
          gt(mailMessageMetadata.syncedAt, cutoff),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async updateState(
    accountId: number,
    membershipId: number,
    orgId: string,
    messageId: string,
    update: { isRead?: boolean; isStarred?: boolean; folder?: string },
  ): Promise<void> {
    await this.db
      .update(mailMessageMetadata)
      .set({ ...update })
      .where(
        and(
          eq(mailMessageMetadata.accountId, accountId),
          eq(mailMessageMetadata.messageId, messageId),
          eq(mailMessageMetadata.userMembershipId, membershipId),
          eq(mailMessageMetadata.orgId, orgId),
        ),
      );
  }

  async markStaleForAccount(accountId: number, orgId: string): Promise<void> {
    await this.db
      .update(mailMessageMetadata)
      .set({ syncedAt: new Date(0) })
      .where(
        and(
          eq(mailMessageMetadata.accountId, accountId),
          eq(mailMessageMetadata.orgId, orgId),
        ),
      );
  }
}
