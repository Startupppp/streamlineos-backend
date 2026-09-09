import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, eq, isNull, lte, ne, sql } from "drizzle-orm";
import {
  glAccounts,
  glJournalLines,
  glJournals,
  type GlAccountType,
  type GlSystemTag,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { getPostgresErrorDetails } from "../../../common/db/postgres-error";
import { AuditService } from "../../../common/audit/audit.service";
import { addDays, assertIsoDate, compareDates } from "./fiscal-calendar";
import {
  readAccountLedger,
  type AccountBalance,
  type AccountLedgerPage,
  type AccountLedgerQuery,
} from "./account-ledger";
import type { DbOrTx } from "./sequence.service";

export interface CreateAccountInput {
  code: string;
  name: string;
  accountType: GlAccountType;
  parentAccountId?: string | null;
  isHeader?: boolean;
  isCash?: boolean;
  systemTag?: GlSystemTag | null;
  currencyRestriction?: string | null;
  description?: string | null;
}

export interface UpdateAccountInput {
  name?: string;
  parentAccountId?: string | null;
  isActive?: boolean;
  isCash?: boolean;
  currencyRestriction?: string | null;
  description?: string | null;
}

export interface AccountNode {
  id: string;
  code: string;
  name: string;
  accountType: GlAccountType;
  parentAccountId: string | null;
  isHeader: boolean;
  isActive: boolean;
  isCash: boolean;
  systemTag: GlSystemTag | null;
  currencyRestriction: string | null;
  description: string | null;
  children: AccountNode[];
}

/**
 * The chart of accounts.
 *
 * The rules here exist to protect the ledger from its own configuration: an
 * account that has postings cannot become a header, cannot change type, and
 * cannot be deleted. Those are the edits that silently break a trial balance.
 */
@Injectable()
export class AccountsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(
    orgId: string,
    bookId: string,
    options: { includeInactive?: boolean } = {},
  ): Promise<AccountNode[]> {
    const rows = await this.db
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

    return this.toTree(rows);
  }

  /** Flat listing — what a posting dropdown wants (no headers). */
  async listPostable(orgId: string, bookId: string) {
    return this.db
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

  async get(orgId: string, bookId: string, accountId: string) {
    const [row] = await this.db
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

  async create(orgId: string, userId: string, bookId: string, input: CreateAccountInput) {
    if (input.isHeader && input.isCash) {
      throw new BadRequestException("A header account cannot also be a cash account");
    }
    if (input.parentAccountId) {
      await this.assertParentUsable(orgId, bookId, input.parentAccountId);
    }

    try {
      const [created] = await this.db
        .insert(glAccounts)
        .values({
          orgId,
          bookId,
          code: input.code.trim(),
          name: input.name.trim(),
          accountType: input.accountType,
          parentAccountId: input.parentAccountId ?? null,
          isHeader: input.isHeader ?? false,
          isCash: input.isCash ?? false,
          systemTag: input.systemTag ?? null,
          currencyRestriction: input.currencyRestriction ?? null,
          description: input.description ?? null,
        })
        .returning();

      this.audit.log({
        action: "accounting.account.created",
        userId,
        orgId,
        resourceType: "gl_accounts",
        resourceId: created.id,
        after: { code: created.code, name: created.name, accountType: created.accountType },
      });
      return created;
    } catch (error) {
      throw this.translateUniqueViolation(error, input.code, input.systemTag ?? null);
    }
  }

  async update(
    orgId: string,
    userId: string,
    bookId: string,
    accountId: string,
    input: UpdateAccountInput,
  ) {
    const before = await this.get(orgId, bookId, accountId);

    // Deactivating an account is fine; it stops new postings without touching
    // history. Turning a posted-to account into a header is not — the trial
    // balance would carry a total nobody can drill into.
    if (input.parentAccountId !== undefined && input.parentAccountId !== null) {
      await this.assertParentUsable(orgId, bookId, input.parentAccountId, accountId);
    }
    if (input.isCash === true && before.isHeader) {
      throw new BadRequestException("A header account cannot be a cash account");
    }

    const [updated] = await this.db
      .update(glAccounts)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.parentAccountId !== undefined ? { parentAccountId: input.parentAccountId } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.isCash !== undefined ? { isCash: input.isCash } : {}),
        ...(input.currencyRestriction !== undefined
          ? { currencyRestriction: input.currencyRestriction }
          : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      })
      .where(and(eq(glAccounts.orgId, orgId), eq(glAccounts.id, accountId)))
      .returning();

    this.audit.log({
      action: "accounting.account.updated",
      userId,
      orgId,
      resourceType: "gl_accounts",
      resourceId: accountId,
      before: { name: before.name, isActive: before.isActive },
      after: { name: updated.name, isActive: updated.isActive },
    });
    return updated;
  }

  /**
   * Archive rather than delete. An account with postings can never be removed —
   * the journals that reference it are immutable, so removing it would orphan
   * history. Deactivating stops new postings and keeps the audit trail whole.
   */
  async archive(orgId: string, userId: string, bookId: string, accountId: string) {
    const account = await this.get(orgId, bookId, accountId);
    const postings = await this.postingCount(accountId);

    if (postings > 0) {
      const [updated] = await this.db
        .update(glAccounts)
        .set({ isActive: false })
        .where(and(eq(glAccounts.orgId, orgId), eq(glAccounts.id, accountId)))
        .returning();
      this.audit.log({
        action: "accounting.account.deactivated",
        userId,
        orgId,
        resourceType: "gl_accounts",
        resourceId: accountId,
        after: { reason: "has postings", postings },
      });
      return { ...updated, deactivatedInsteadOfDeleted: true, postings };
    }

    const children = await this.db
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

    const [deleted] = await this.db
      .update(glAccounts)
      .set({ deletedAt: new Date(), isActive: false })
      .where(and(eq(glAccounts.orgId, orgId), eq(glAccounts.id, accountId)))
      .returning();

    this.audit.log({
      action: "accounting.account.archived",
      userId,
      orgId,
      resourceType: "gl_accounts",
      resourceId: accountId,
      before: { code: account.code, name: account.name },
    });
    return { ...deleted, deactivatedInsteadOfDeleted: false, postings: 0 };
  }

  /** Reassign which account fills a system role (`ar_control`, `bank`, …). */
  async setSystemTag(
    orgId: string,
    userId: string,
    bookId: string,
    accountId: string,
    tag: GlSystemTag | null,
  ) {
    const account = await this.get(orgId, bookId, accountId);
    if (tag && account.isHeader) {
      throw new BadRequestException("A header account cannot fill a posting role");
    }

    return this.db.transaction(async (tx) => {
      if (tag) {
        // The unique index allows one account per tag per book, so release the
        // incumbent before claiming it.
        await tx
          .update(glAccounts)
          .set({ systemTag: null })
          .where(
            and(
              eq(glAccounts.bookId, bookId),
              eq(glAccounts.systemTag, tag),
              ne(glAccounts.id, accountId),
            ),
          );
      }
      const [updated] = await tx
        .update(glAccounts)
        .set({ systemTag: tag })
        .where(and(eq(glAccounts.orgId, orgId), eq(glAccounts.id, accountId)))
        .returning();

      this.audit.log({
        action: "accounting.account.system_tag_set",
        userId,
        orgId,
        resourceType: "gl_accounts",
        resourceId: accountId,
        before: { systemTag: account.systemTag },
        after: { systemTag: tag },
      });
      return updated;
    });
  }

  private async postingCount(accountId: string, tx: DbOrTx = this.db): Promise<number> {
    const [row] = await tx
      .select({ n: count() })
      .from(glJournalLines)
      .where(eq(glJournalLines.accountId, accountId));
    return Number(row?.n ?? 0);
  }

  private async assertParentUsable(
    orgId: string,
    bookId: string,
    parentId: string,
    childId?: string,
  ): Promise<void> {
    if (childId && parentId === childId) {
      throw new BadRequestException("An account cannot be its own parent");
    }
    const parent = await this.get(orgId, bookId, parentId);
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
        const [row] = await this.db
          .select({ parentAccountId: glAccounts.parentAccountId })
          .from(glAccounts)
          .where(eq(glAccounts.id, cursor))
          .limit(1);
        cursor = row?.parentAccountId ?? null;
      }
    }
  }

  /**
   * Both halves of this read were looking in the wrong place.
   *
   * The SQLSTATE was taken off the value Drizzle threw, and Drizzle throws a
   * `DrizzleQueryError` that keeps the driver error on `.cause` — so the
   * comparison was always false and creating an account with a code the book
   * already uses answered 500 rather than 409. And the constraint was matched
   * against `error.message`, which on that wrapper is the SQL text
   * ("Failed query: insert into …"), never the constraint name; even a correct
   * SQLSTATE read would have fallen through to the generic message.
   *
   * `getPostgresErrorDetails` answers both from the cause chain.
   * `uniq_gl_accounts_book_code` is (book_id, code) WHERE deleted_at IS NULL
   * and `uniq_gl_accounts_book_system_tag` is (book_id, system_tag) WHERE the
   * tag is set — both reachable from `create` with caller-supplied values.
   */
  private translateUniqueViolation(error: unknown, code: string, tag: GlSystemTag | null): Error {
    const { code: sqlstate, constraint } = getPostgresErrorDetails(error);
    if (sqlstate === "23505") {
      if (constraint === "uniq_gl_accounts_book_code") {
        return new ConflictException(`Account code ${code} is already used in this book`);
      }
      if (constraint === "uniq_gl_accounts_book_system_tag" && tag) {
        return new ConflictException(`Another account already fills the "${tag}" role`);
      }
      return new ConflictException("That account already exists");
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private toTree(rows: Omit<AccountNode, "children">[]): AccountNode[] {
    const byId = new Map<string, AccountNode>();
    for (const row of rows) byId.set(row.id, { ...row, children: [] });

    const roots: AccountNode[] = [];
    for (const node of byId.values()) {
      const parent = node.parentAccountId ? byId.get(node.parentAccountId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  /** Balance of one account from the lines, for a drill-down. */
  async balance(
    orgId: string,
    bookId: string,
    accountId: string,
    asOf: string,
  ): Promise<AccountBalance> {
    const [row] = await this.db
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

  /**
   * Every posting on one account across a window, page by page.
   *
   * The account is resolved through `get`, so an id from another tenant or
   * another book is a 404 rather than a 403 — a 403 would confirm it exists.
   */
  async ledger(
    orgId: string,
    bookId: string,
    accountId: string,
    query: AccountLedgerQuery,
  ): Promise<AccountLedgerPage> {
    const account = await this.get(orgId, bookId, accountId);

    const from = assertIsoDate(query.from);
    const to = assertIsoDate(query.to);
    if (compareDates(to, from) < 0) {
      throw new BadRequestException("The window ends before it starts");
    }

    const opening = await this.balance(orgId, bookId, accountId, addDays(from, -1));
    return readAccountLedger(this.db, { orgId, bookId, account, from, to }, query, opening);
  }
}
