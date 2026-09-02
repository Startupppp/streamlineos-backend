import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { mailMessageMetadata } from "../../db/schema/mail";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { registerAfterCommit } from "../../common/tenant";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { logger } from "../../common/logger/logger.service";
import type { MailFolder, MailMessageSummary } from "./dto/mail-schemas";
import type { MailMetadataCursor } from "./providers/mail-metadata-cursor";

const CACHE_FRESH_SECS = 300;

/**
 * How many message ids `app.search_mail_message_ids` is asked for before the
 * caller gives up on an id list. The caller requests `cap + 1`: getting `cap + 1`
 * back means the term matches too much of the mailbox to be worth materialising,
 * and the plain ILIKE under a LIMIT is the faster plan in exactly that regime
 * (migration 0425 measured 434 ms against 1 ms on the equivalent ticket search).
 */
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

  /**
   * Resolve the search predicate for `query`.
   *
   * `mail_message_metadata` has RLS on (`org_id = app.current_org_id()`), and
   * `texticlike` is not leakproof, so the planner must run the security qual
   * first and refuses the trigram index — a plain ILIKE here is a sequential
   * scan of the tenant's whole mailbox no matter what index exists. Migration
   * 1022 therefore puts the match inside `app.search_mail_message_ids`, a
   * SECURITY DEFINER function owned by the BYPASSRLS role, which returns ids
   * only; the returned ids are then fed back into a query that still runs under
   * RLS with its own org, membership, folder and account predicates, so nothing
   * about who may read what moves into the function.
   *
   * A term that matches more than `SEARCH_ID_CAP` messages falls back to the
   * ILIKE, which is the faster plan once the match is that broad. So does a
   * function that is missing or errors: a slower correct answer beats a 500 on
   * a database whose migrations have not caught up.
   */
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
      if (rows.length === 0 || rows.length > SEARCH_ID_CAP) return literal;
      return inArray(
        mailMessageMetadata.id,
        rows.map((r) => Number(r["id"])),
      );
    } catch (err) {
      logger.warn("[mail-metadata] indexed search unavailable, falling back to ILIKE", { err });
      return literal;
    }
  }

  /**
   * Keyset predicate for `ORDER BY date DESC, id DESC`.
   *
   * Postgres defaults DESC to NULLS FIRST, so rows with no date sort ahead of
   * every dated row. That makes the two branches genuinely different: once the
   * cursor carries a date, every null-dated row has already been served and the
   * row comparison drops them on its own (a comparison against NULL is NULL, so
   * the row is filtered out) — which is the correct behaviour, not an accident.
   * A null-dated cursor is still inside that leading block, so it takes the
   * remaining null-dated rows and then everything dated.
   */
  private keysetCondition(after: MailMetadataCursor): SQL {
    if (after.d === null) {
      const clause = or(
        and(isNull(mailMessageMetadata.date), lt(mailMessageMetadata.id, after.i)),
        isNotNull(mailMessageMetadata.date),
      );
      return clause ?? sql`true`;
    }
    return sql`(${mailMessageMetadata.date}, ${mailMessageMetadata.id}) < (${after.d}::timestamptz, ${after.i})`;
  }

  async listCached(
    membershipId: number,
    orgId: string,
    accountId: number | null,
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
    if (accountId !== null) conditions.push(eq(mailMessageMetadata.accountId, accountId));
    if (query) conditions.push(await this.resolveSearchCondition(membershipId, folder, query));
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

    if (rows.length === 0) return { messages: [], hasData: false, isFresh: false, nextCursor: null };

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

  /**
   * Whether this account's copy of `folder` was synced recently enough to answer
   * a read without going to the provider.
   *
   * `listCached` derives freshness from the rows it returns, which is the wrong
   * question once a search filter is applied: a search matching only old mail
   * returns stale-looking rows from a mailbox that synced seconds ago. This asks
   * about the account instead, so the search path can trust a fresh cache even
   * when the matches themselves are old.
   *
   * The `org_id` predicate is explicit rather than left to RLS — guards and
   * background callers can reach a service without the tenant GUC set.
   */
  async isFreshForAccount(orgId: string, accountId: number, folder: MailFolder): Promise<boolean> {
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
