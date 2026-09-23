import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { Db } from "../../db/drizzle.module";
import type { AccessService } from "../access/access.service";
import type { DataScope } from "../access/access.types";
import { bulkSubmissionsSchema, type BulkSubmissionsInput } from "./feedbucket.schemas";

export const BULK_ORG = "org-owner";
export const BULK_ACTOR = "user-actor";
export const BULK_MEMBERSHIP = 42;

export function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (value instanceof Date) return [value.toISOString()];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

export interface BulkHarness {
  db: Db;
  transaction: jest.Mock;
  selectWhere: jest.Mock;
  selectOrderBy: jest.Mock;
  selectLimit: jest.Mock;
  forUpdate: jest.Mock;
  update: jest.Mock;
  set: jest.Mock;
  updateWhere: jest.Mock;
  membershipFindFirst: jest.Mock;
}

export function makeBulkHarness(visibleIds: number[]): BulkHarness {
  const forUpdate = jest.fn().mockResolvedValue(visibleIds.map((id) => ({ id })));
  const selectLimit = jest.fn().mockReturnValue({ for: forUpdate });
  const selectOrderBy = jest.fn().mockReturnValue({ limit: selectLimit });
  const selectWhere = jest.fn().mockReturnValue({ orderBy: selectOrderBy });
  const from = jest.fn().mockReturnValue({ where: selectWhere });
  const select = jest.fn().mockReturnValue({ from });

  const returning = jest.fn().mockResolvedValue(visibleIds.map((id) => ({ id })));
  const updateWhere = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where: updateWhere });
  const update = jest.fn().mockReturnValue({ set });

  const tx = { select, update };
  const transaction = jest.fn(async (callback: (t: typeof tx) => unknown) => callback(tx));
  const membershipFindFirst = jest.fn().mockResolvedValue({ id: 77 });

  const db = {
    transaction,
    query: { organizationMembers: { findFirst: membershipFindFirst } },
  } as unknown as Db;

  return {
    db,
    transaction,
    selectWhere,
    selectOrderBy,
    selectLimit,
    forUpdate,
    update,
    set,
    updateWhere,
    membershipFindFirst,
  };
}

export function makeBulkAccess(scopes: Record<string, DataScope> = {}): AccessService {
  return {
    scopeFor: jest.fn(async (_actor: CurrentUserContext, key: string) => scopes[key] ?? "all"),
  } as unknown as AccessService;
}

export const bulkActor = {
  orgId: BULK_ORG,
  userId: BULK_ACTOR,
} as unknown as CurrentUserContext;

export function bulkBody(raw: Record<string, unknown>): BulkSubmissionsInput {
  const parsed = bulkSubmissionsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`bulk fixture is invalid: ${parsed.error.message}`);
  return parsed.data;
}

export function unvalidatedBulkBody(raw: unknown): BulkSubmissionsInput {
  return raw as BulkSubmissionsInput;
}
