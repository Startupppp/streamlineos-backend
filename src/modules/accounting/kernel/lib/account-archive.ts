/**
 * Archiving an account: a soft delete, or a deactivation when postings
 * reference it.
 *
 * Split out of `accounts.service.ts`, whose `archive` delegates here.
 * `postingCount` stays private to this file: it counts by account id alone, and
 * is only asked after `getAccount` has placed the account in the caller's org
 * and book.
 */
import { ConflictException } from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import { glAccounts, glJournalLines } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { DbOrTx } from "../sequence.service";
import { getAccount } from "./account-reads";

/**
 * Archive rather than delete. An account with postings can never be removed —
 * the journals that reference it are immutable, so removing it would orphan
 * history. Deactivating stops new postings and keeps the audit trail whole.
 */
export async function archiveAccount(
  db: Db,
  audit: AuditService,
  orgId: string,
  userId: string,
  bookId: string,
  accountId: string,
) {
  const account = await getAccount(db, orgId, bookId, accountId);
  const postings = await postingCount(accountId, db);

  if (postings > 0) {
    const [updated] = await db
      .update(glAccounts)
      .set({ isActive: false })
      .where(and(eq(glAccounts.orgId, orgId), eq(glAccounts.id, accountId)))
      .returning();
    audit.log({
      action: "accounting.account.deactivated",
      userId,
      orgId,
      resourceType: "gl_accounts",
      resourceId: accountId,
      after: { reason: "has postings", postings },
    });
    return { ...updated, deactivatedInsteadOfDeleted: true, postings };
  }

  const children = await db
    .select({ n: count() })
    .from(glAccounts)
    .where(and(eq(glAccounts.parentAccountId, accountId), isNull(glAccounts.deletedAt)));
  if (Number(children[0]?.n ?? 0) > 0) {
    throw new ConflictException("Move or archive the child accounts first");
  }
  if (account.systemTag) {
    throw new ConflictException(
      `${account.code} is the book's "${account.systemTag}" account and documents resolve to it. ` +
        "Point that role at another account before archiving this one.",
    );
  }

  const [deleted] = await db
    .update(glAccounts)
    .set({ deletedAt: new Date(), isActive: false })
    .where(and(eq(glAccounts.orgId, orgId), eq(glAccounts.id, accountId)))
    .returning();

  audit.log({
    action: "accounting.account.archived",
    userId,
    orgId,
    resourceType: "gl_accounts",
    resourceId: accountId,
    before: { code: account.code, name: account.name },
  });
  return { ...deleted, deactivatedInsteadOfDeleted: false, postings: 0 };
}

async function postingCount(accountId: string, tx: DbOrTx): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(glJournalLines)
    .where(eq(glJournalLines.accountId, accountId));
  return Number(row?.n ?? 0);
}
