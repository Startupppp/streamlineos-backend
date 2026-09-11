/**
 * The chart's pure rules: which account types a system role may sit on, what a
 * unique violation on `gl_accounts` means to the caller, and folding flat rows
 * into a tree. Nothing here reads a row.
 *
 * Split out of `accounts.service.ts`.
 */
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { GlAccountType, GlSystemTag } from "../../../../db/schema";
import { getPostgresErrorDetails } from "../../../../common/db/postgres-error";
import { SYSTEM_TAG_ACCOUNT_TYPES, accountTypeFitsRole } from "../system-tag-roles";
import type { AccountNode } from "./account-types";

/**
 * A role has a shape. `cogs` on an equity account balances perfectly well and
 * is still wrong — the journal is fine and the P&L is quietly missing its
 * cost of sales, which is the kind of error that survives until an auditor
 * finds it. See `system-tag-roles.ts` for why this is checked when a tag is
 * assigned and never when a journal is posted.
 */
export function assertRoleFitsType(tag: GlSystemTag, accountType: GlAccountType): void {
  if (accountTypeFitsRole(tag, accountType)) return;
  const allowed = SYSTEM_TAG_ACCOUNT_TYPES[tag];
  throw new BadRequestException(
    `The "${tag}" role belongs on ${allowed.join(" or ")} account, not ${accountType}. ` +
      "Documents resolve accounts by role, so this mapping would classify every posting " +
      "that uses it onto the wrong side of the statements.",
  );
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
export function translateUniqueViolation(error: unknown, code: string, tag: GlSystemTag | null): Error {
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

export function toTree(rows: Omit<AccountNode, "children">[]): AccountNode[] {
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
