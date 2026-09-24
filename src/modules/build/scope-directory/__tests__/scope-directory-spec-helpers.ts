import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import { ScopeDirectoryService } from "../scope-directory.service";

const dialect = new PgDialect();

export function renderParams(condition: unknown): unknown[] {
  return dialect.sqlToQuery(condition as SQL).params;
}

export const ORG = "org-1";
export const USER = "user-1";
export const MEMBERSHIP_ID = 42;

export interface RecordedCall {
  table: unknown;
  condition: unknown;
}

export type TableResponses = Map<unknown, unknown[][]>;

export function makeResponses(
  entries: ReadonlyArray<readonly [unknown, unknown[][]]> = [],
): TableResponses {
  return new Map<unknown, unknown[][]>(entries);
}

function makeChainable(p: Promise<unknown[]>) {
  return Object.assign(p, {
    orderBy: (..._args: unknown[]) => makeChainable(p),
    limit: (..._args: unknown[]) => makeChainable(p),
  });
}

export function makeDb(responses: TableResponses) {
  const callCounts = new Map<unknown, number>();
  const calls: RecordedCall[] = [];

  function recordAndResolve(table: unknown, condition: unknown): Promise<unknown[]> {
    calls.push({ table, condition });
    const seq = responses.get(table) ?? [[]];
    const idx = callCounts.get(table) ?? 0;
    callCounts.set(table, idx + 1);
    return Promise.resolve(seq[idx] ?? []);
  }

  const select = jest.fn().mockImplementation(() => ({
    from: jest.fn().mockImplementation((table: unknown) => ({
      where: jest.fn().mockImplementation((condition: unknown) =>
        makeChainable(recordAndResolve(table, condition)),
      ),
      innerJoin: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockImplementation((condition: unknown) =>
          makeChainable(recordAndResolve(table, condition)),
        ),
      })),
    })),
  }));

  const db = { select } as unknown as Db;
  return { db, calls };
}

export function makeAccess(buildManageScope: string | null = "all"): AccessService {
  const perms = buildManageScope !== null
    ? new Map([["build:manage", buildManageScope]])
    : new Map<string, string>();
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(perms),
  } as unknown as AccessService;
}

export function makeSvc(db: Db, access: AccessService = makeAccess()) {
  return new ScopeDirectoryService(db, access);
}

export const PROD_ROW = {
  id: 10,
  name: "Atlas",
  key: "ATL",
  status: "active",
};

export const PROJ_ROW = {
  id: 20,
  name: "Launch",
  key: "LAU",
  status: "ACTIVE",
  managedProductId: 10,
  clientMembershipId: null,
};
