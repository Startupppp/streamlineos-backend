import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import { glAccounts, type GlSystemTag } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { addDays, assertIsoDate, compareDates } from "./fiscal-calendar";
import {
  readAccountLedger,
  type AccountBalance,
  type AccountLedgerPage,
  type AccountLedgerQuery,
} from "./account-ledger";
import type { AccountNode, CreateAccountInput, UpdateAccountInput } from "./lib/account-types";
import { assertRoleFitsType, toTree, translateUniqueViolation } from "./lib/account-rules";
import {
  assertParentUsable,
  getAccount,
  listPostableAccounts,
  readAccountBalance,
  readAccountRows,
  readSystemTagMappings,
} from "./lib/account-reads";
import { archiveAccount } from "./lib/account-archive";

export type { AccountNode, CreateAccountInput, UpdateAccountInput } from "./lib/account-types";

/**
 * The chart of accounts.
 *
 * The rules here exist to protect the ledger from its own configuration: an
 * account that has postings cannot become a header, cannot change type, and
 * cannot be deleted. Those are the edits that silently break a trial balance.
 *
 * The reads and the archive policy are in `lib/account-reads.ts` and
 * `lib/account-archive.ts`, the pure rules in `lib/account-rules.ts`.
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
    const rows = await readAccountRows(this.db, orgId, bookId, options);
    return toTree(rows);
  }

  /** Flat listing — what a posting dropdown wants (no headers). */
  async listPostable(orgId: string, bookId: string) {
    return listPostableAccounts(this.db, orgId, bookId);
  }

  async get(orgId: string, bookId: string, accountId: string) {
    return getAccount(this.db, orgId, bookId, accountId);
  }

  async create(orgId: string, userId: string, bookId: string, input: CreateAccountInput) {
    if (input.isHeader && input.isCash) {
      throw new BadRequestException("A header account cannot also be a cash account");
    }
    if (input.systemTag) {
      assertRoleFitsType(input.systemTag, input.accountType);
      if (input.isHeader) {
        throw new BadRequestException("A header account cannot fill a posting role");
      }
    }
    if (input.parentAccountId) {
      await assertParentUsable(this.db, orgId, bookId, input.parentAccountId);
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
      throw translateUniqueViolation(error, input.code, input.systemTag ?? null);
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
      await assertParentUsable(this.db, orgId, bookId, input.parentAccountId, accountId);
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
    return archiveAccount(this.db, this.audit, orgId, userId, bookId, accountId);
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
    if (tag) assertRoleFitsType(tag, account.accountType);

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

  /** Every system role and the account filling it, for the mapping screen. */
  async listSystemTagMappings(orgId: string, bookId: string) {
    return readSystemTagMappings(this.db, orgId, bookId);
  }

  /** Balance of one account from the lines, for a drill-down. */
  async balance(
    orgId: string,
    bookId: string,
    accountId: string,
    asOf: string,
  ): Promise<AccountBalance> {
    return readAccountBalance(this.db, orgId, bookId, accountId, asOf);
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
