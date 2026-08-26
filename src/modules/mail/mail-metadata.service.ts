import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, ilike, or, sql } from "drizzle-orm";
import { mailMessageMetadata } from "../../db/schema/mail";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { registerAfterCommit } from "../../common/tenant";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { logger } from "../../common/logger/logger.service";
import type { MailFolder, MailMessageSummary } from "./dto/mail-schemas";

const CACHE_FRESH_SECS = 300;

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
    userId: string,
    orgId: string,
    folder: MailFolder,
    messages: MailMessageSummary[],
  ): void {
    this.defer(orgId, "upsertBatch", () =>
      this.upsertBatch(accountId, userId, orgId, folder, messages),
    );
  }

  deferUpdateState(
    accountId: number,
    userId: string,
    orgId: string,
    messageId: string,
    update: { isRead?: boolean; isStarred?: boolean; folder?: string },
  ): void {
    this.defer(orgId, "updateState", () =>
      this.updateState(accountId, userId, orgId, messageId, update),
    );
  }

  async upsertBatch(
    accountId: number,
    userId: string,
    orgId: string,
    folder: MailFolder,
    messages: MailMessageSummary[],
  ): Promise<void> {
    if (messages.length === 0) return;
    const now = new Date();
    const rows = messages.map((m) => ({
      accountId,
      userId,
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

  async listCached(
    userId: string,
    orgId: string,
    accountId: number | null,
    folder: MailFolder,
    limit: number,
    query?: string,
  ): Promise<{ messages: CachedMailMessage[]; hasData: boolean; isFresh: boolean }> {
    const conditions = [
      eq(mailMessageMetadata.orgId, orgId),
      eq(mailMessageMetadata.userId, userId),
      eq(mailMessageMetadata.folder, folder),
    ];
    if (accountId !== null) conditions.push(eq(mailMessageMetadata.accountId, accountId));
    if (query) {
      const term = `%${query}%`;
      const searchClause = or(
        ilike(mailMessageMetadata.subject, term),
        ilike(mailMessageMetadata.senderEmail, term),
        ilike(mailMessageMetadata.senderName, term),
      );
      if (searchClause) conditions.push(searchClause);
    }

    const rows = await this.db
      .select({
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
      .orderBy(desc(mailMessageMetadata.date))
      .limit(limit);

    if (rows.length === 0) return { messages: [], hasData: false, isFresh: false };

    const cutoff = new Date(Date.now() - CACHE_FRESH_SECS * 1000);
    const latestSync = rows.reduce<Date>(
      (latest, r) => (r.syncedAt > latest ? r.syncedAt : latest),
      rows[0]!.syncedAt,
    );
    const isFresh = latestSync > cutoff;

    return {
      messages: rows.map((r) => ({
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
    };
  }

  async isFreshForAccount(accountId: number, folder: MailFolder): Promise<boolean> {
    const cutoff = new Date(Date.now() - CACHE_FRESH_SECS * 1000);
    const [row] = await this.db
      .select({ syncedAt: mailMessageMetadata.syncedAt })
      .from(mailMessageMetadata)
      .where(
        and(
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
    userId: string,
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
          eq(mailMessageMetadata.userId, userId),
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
