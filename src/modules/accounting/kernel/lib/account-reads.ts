/**
 * Reading the chart of accounts: the rows of the tree, the postable list, one
 * account, the system-role mappings, one account's balance, and the parent
 * check that walks up the tree.
 *
 * Split out of `accounts.service.ts`, which delegates here. `getAccount`
 * scopes by org and book, so an account from another tenant or book is a 404
 * rather than a 403, and the parent check starts from an account it returned.
 */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { glAccounts, glJournalLines, glJournals } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import { assertIsoDate } from "../fiscal-calendar";
import {
  ALL_SYSTEM_TAGS,
  INVENTORY_SEAM_ROLES,
  INVENTORY_SEAM_ROLES_PENDING,
  SYSTEM_TAG_ACCOUNT_TYPES,
} from "../system-tag-roles";
import type { AccountBalance } from "../account-ledger";

/** The chart's rows, in code order, for `AccountsService.list` to fold into a tree. */
export async function readAccountRows(
  db: Db,
  orgId: string,
  bookId: string,
  options: { includeInactive?: boolean } = {},
) {
  return db
    .select({
      id: glAccounts.id,
      code: glAccounts.code,
      name: glAccounts.name,
      accountType: glAccounts.accountType,
      parentAccountId: glAccounts.parentAccountId,
      isHeader: glAccounts.isHeader,
      isActive: glAccounts.isActive,
      isCash: glAccounts.isCash,
      systemTag: glAccounts.systemTag,
      currencyRestriction: glAccounts.currencyRestriction,
      description: glAccounts.description,
    })
    .from(glAccounts)
    .where(
      and(
        eq(glAccounts.orgId, orgId),
        eq(glAccounts.bookId, bookId),
        isNull(glAccounts.deletedAt),
        options.includeInactive ? undefined : eq(glAccounts.isActive, true),
      ),
    )
    .orderBy(asc(glAccounts.code));
}

/** Flat listing — what a posting dropdown wants (no headers). */
export async function listPostableAccounts(db: Db, orgId: string, bookId: string) {
  return db
    .select({
      id: glAccounts.id,
      code: glAccounts.code,
      name: glAccounts.name,
      accountType: glAccounts.accountType,
      isCash: glAccounts.isCash,
      systemTag: glAccounts.systemTag,
      currencyRestriction: glAccounts.currencyRestriction,
    })
    .from(glAccounts)
    .where(
      and(
        eq(glAccounts.orgId, orgId),
        eq(glAccounts.bookId, bookId),
        eq(glAccounts.isHeader, false),
        eq(glAccounts.isActive, true),
        isNull(glAccounts.deletedAt),
      ),
    )
    .orderBy(asc(glAccounts.code));
}

export async function getAccount(db: Db, orgId: string, bookId: string, accountId: string) {
  const [row] = await db
    .select()
    .from(glAccounts)
    .where(
      and(
        eq(glAccounts.orgId, orgId),
        eq(glAccounts.bookId, bookId),
        eq(glAccounts.id, accountId),
        isNull(glAccounts.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundException("Account not found");
  return row;
}

/**
 * Every system role and the account filling it, for the mapping screen.
 *
 * Returns all roles rather than only the mapped ones: the screen's job is to
 * show what is *not* mapped, and a list that omits the unmapped shows an
 * operator nothing to do.
 */
export async function readSystemTagMappings(db: Db, orgId: string, bookId: string) {
  const rows = await db
    .select({
      id: glAccounts.id,
      code: glAccounts.code,
      name: glAccounts.name,
      accountType: glAccounts.accountType,
      systemTag: glAccounts.systemTag,
    })
    .from(glAccounts)
    .where(
      and(
        eq(glAccounts.orgId, orgId),
        eq(glAccounts.bookId, bookId),
        eq(glAccounts.isActive, true),
        isNull(glAccounts.deletedAt),
      ),
    );

  const byTag = new Map(rows.filter((r) => r.systemTag).map((r) => [r.systemTag, r]));
  const required = new Set<string>(INVENTORY_SEAM_ROLES);
  const pending = new Set<string>(INVENTORY_SEAM_ROLES_PENDING);

  return ALL_SYSTEM_TAGS.map((tag) => {
    const account = byTag.get(tag);
    return {
      tag,
      allowedAccountTypes: SYSTEM_TAG_ACCOUNT_TYPES[tag],
      account: account
        ? { id: account.id, code: account.code, name: account.name, accountType: account.accountType }
        : null,
      /* Inventory refuses a movement without this one, today. */
      requiredByInventory: required.has(tag),
      /*
        Seeded by the chart and resolved by nothing yet. Shown so the screen
        can say so, rather than presenting it as a gap the operator caused.
      */
      awaitingInventorySupport: pending.has(tag),
    };
  });
}

/** Balance of one account from the lines, for a drill-down. */
export async function readAccountBalance(
  db: Db,
  orgId: string,
  bookId: string,
  accountId: string,
  asOf: string,
): Promise<AccountBalance> {
  const [row] = await db
    .select({
      debitMinor: sql<string>`coalesce(sum(${glJournalLines.debitMinor}), 0)`,
      creditMinor: sql<string>`coalesce(sum(${glJournalLines.creditMinor}), 0)`,
    })
    .from(glJournalLines)
    .innerJoin(glJournals, eq(glJournalLines.journalId, glJournals.id))
    .where(
      and(
        eq(glJournalLines.orgId, orgId),
        eq(glJournalLines.bookId, bookId),
        eq(glJournalLines.accountId, accountId),
        lte(glJournals.journalDate, assertIsoDate(asOf)),
      ),
    );

  const debitMinor = Number(row?.debitMinor ?? 0);
  const creditMinor = Number(row?.creditMinor ?? 0);
  return { debitMinor, creditMinor, balanceMinor: debitMinor - creditMinor };
}

export async function assertParentUsable(
  db: Db,
  orgId: string,
  bookId: string,
  parentId: string,
  childId?: string,
): Promise<void> {
  if (childId && parentId === childId) {
    throw new BadRequestException("An account cannot be its own parent");
  }
  const parent = await getAccount(db, orgId, bookId, parentId);
  if (!parent.isHeader) {
    throw new BadRequestException(
      `${parent.code} is a posting account, so it cannot have children. Use a header account.`,
    );
  }
  if (childId) {
    // Walk up to the root; a cycle here would make the tree query never end.
    let cursor: string | null = parent.parentAccountId;
    const seen = new Set<string>([childId, parentId]);
    while (cursor) {
      if (seen.has(cursor)) throw new BadRequestException("That would create a cycle");
      seen.add(cursor);
      const [row] = await db
        .select({ parentAccountId: glAccounts.parentAccountId })
        .from(glAccounts)
        .where(eq(glAccounts.id, cursor))
        .limit(1);
      cursor = row?.parentAccountId ?? null;
    }
  }
}
