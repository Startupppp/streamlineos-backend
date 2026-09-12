/**
 * The shapes the tenant recorder speaks in: a recorded statement, a per-table
 * fixture and the handle a spec holds. They sit in their own file so the SQL
 * walker (`tenant-recorder-sql.ts`), the recording chain
 * (`tenant-recorder-chain.ts`) and the factory can all name them without
 * importing one another. `tenant-recorder.ts` re-exports every one; import from
 * there.
 */
import type { Column, Table } from "drizzle-orm";

export type Row = Record<string, unknown>;

export type Op = "select" | "insert" | "update" | "delete" | "execute" | "query";

export interface Statement {
  readonly op: Op;
  /** `from(t)`, `insert(t)`, `update(t)`, `delete(t)`; the relational key for `query`. */
  table: unknown;
  /** The arguments of the call that opened the statement. */
  readonly args: readonly unknown[];
  readonly calls: Array<{ method: string; args: unknown[] }>;
  readonly where: unknown[];
  /** The ON condition of every join, in order. */
  readonly joins: unknown[];
  readonly values: unknown[];
  readonly set: unknown[];
}

export interface TenantFixture {
  readonly table: Table;
  /** The tenant column, spelled however this table spells it (`org_id` / `organization_id`). */
  readonly org: Column;
  /**
   * Rows as the service's projection will read them, each carrying its tenant
   * under the org column's property name (`orgId` or `organizationId`).
   */
  readonly rows: Row[];
}

export interface TenantDbOptions {
  readonly fixtures?: readonly TenantFixture[];
  /** Answers a statement before the fixtures are consulted. Return `undefined` to fall through. */
  readonly script?: (statement: Statement) => unknown;
}

export interface TenantDb {
  /** Cast to whatever `Db` type the service's constructor names. */
  readonly db: never;
  readonly statements: Statement[];
  /** Statements against one table, optionally of one kind, in the order they were issued. */
  on(table: unknown, op?: Op): Statement[];
  /** The values a statement's WHERE binds to `orgColumn` by equality. */
  orgBound(statement: Statement | undefined, orgColumn: Column): unknown[];
  /** Every row handed to `insert(table).values(...)`, flattened. */
  inserted(table: unknown): Row[];
}
