import type { Logger } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import {
  CRM_ASSIGNMENT_BATCH_SIZE,
  runCrmAssignments,
  tryBackfill,
  type ClientAccountBackfillDeps,
} from "./client-account-backfill";

const ORG = "org-1";
const MEMBERS = ["cs-a", "cs-b", "cs-c"];
const HALF_BATCH = Math.floor(CRM_ASSIGNMENT_BATCH_SIZE / 2);
const UNOWNED = 2 * CRM_ASSIGNMENT_BATCH_SIZE + HALF_BATCH;

const dialect = new PgDialect();
const render = (fragment: unknown) => dialect.sqlToQuery(fragment as SQL);

interface Account {
  id: number;
  createdAt: number;
  status: "ACCOUNT_OPENING" | "INVESTED";
  assignedCrmId: string | null;
}

interface Chain extends PromiseLike<unknown[]> {
  from(): Chain;
  where(): Chain;
  groupBy(): Chain;
  orderBy(...cols: unknown[]): Chain;
  limit(n: number): Chain;
}

/**
 * `client_accounts`, answering the statements the round-robin issues the way
 * Postgres would. It sorts the unowned read newest-first itself (the ordering
 * test pins the real query to that), but it applies only the limit the code
 * passes, so a read that loses its `.limit()` gets the whole backlog back.
 */
function fakeClientAccounts(accounts: Account[]) {
  const batchesRead: number[] = [];
  const orderBys: unknown[][] = [];
  const updateWheres: SQL[] = [];
  const unowned = () => accounts.filter((a) => a.assignedCrmId === null);

  function select(projection: Record<string, unknown>): Chain {
    let grouped = false;
    let limit: number | undefined;
    const answer = (): unknown[] => {
      if (grouped) {
        return MEMBERS.map((userId) => {
          const owned = accounts.filter((a) => a.assignedCrmId === userId);
          const activeCount = owned.filter((a) => a.status !== "INVESTED").length;
          return { userId, totalCount: owned.length, activeCount };
        }).filter((row) => row.totalCount > 0);
      }
      if ("name" in projection) return MEMBERS.map((userId) => ({ userId, name: userId, image: null }));
      if ("count" in projection) return [{ count: unowned().length }];
      const batch = unowned()
        .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
        .slice(0, limit);
      batchesRead.push(batch.length);
      return batch.map((a) => ({ id: a.id }));
    };
    const chain: Chain = {
      from: () => chain,
      where: () => chain,
      groupBy: () => {
        grouped = true;
        return chain;
      },
      orderBy: (...cols) => {
        orderBys.push(cols);
        return chain;
      },
      limit: (n) => {
        limit = n;
        return chain;
      },
      then: (onfulfilled, onrejected) => Promise.resolve().then(answer).then(onfulfilled, onrejected),
    };
    return chain;
  }

  function update() {
    return {
      set: (values: { assignedCrmId: string }) => ({
        where: (condition: SQL) => {
          updateWheres.push(condition);
          const ids = new Set(render(condition).params.filter((p): p is number => typeof p === "number"));
          for (const a of accounts) if (ids.has(a.id)) a.assignedCrmId = values.assignedCrmId;
          return Promise.resolve();
        },
      }),
    };
  }

  const db = { select, update, execute: jest.fn().mockResolvedValue(undefined) } as unknown as Db;
  return { db, batchesRead, orderBys, updateWheres };
}

function depsFor(db: Db) {
  const warn = jest.fn();
  const members = MEMBERS.map((userId, i) => ({ userId, membershipId: i + 1 }));
  const deps: ClientAccountBackfillDeps = {
    db,
    redis: null,
    access: { membersWithPermission: jest.fn().mockResolvedValue(members) } as unknown as AccessService,
    logger: { warn } as unknown as Logger,
  };
  return { deps, warn };
}

/**
 * 2.5 batches of unowned accounts, in runs of 100 sharing one `created_at` as
 * a conversion backfill writes them, over a starting load of 3, 0 and 1.
 */
function backlog(): Account[] {
  const accounts: Account[] = [];
  for (let id = 1; id <= UNOWNED; id++) {
    accounts.push({ id, createdAt: Math.floor(id / 100), status: "ACCOUNT_OPENING", assignedCrmId: null });
  }
  let id = UNOWNED;
  for (const [owner, n] of [["cs-a", 3], ["cs-c", 1]] as const) {
    for (let i = 0; i < n; i++) {
      accounts.push({ id: ++id, createdAt: 0, status: "ACCOUNT_OPENING", assignedCrmId: owner });
    }
  }
  return accounts;
}

describe("backfillCrmAssignments — one batch per run", () => {
  it("reads newest first with id breaking ties, and writes only rows still unowned", async () => {
    const table = fakeClientAccounts(backlog());
    const { deps } = depsFor(table.db);

    await tryBackfill(deps, ORG, "user-1");

    expect(table.orderBys[0]?.map((col) => render(col).sql)).toEqual([
      expect.stringMatching(/"created_at" desc$/),
      expect.stringMatching(/"id" desc$/),
    ]);
    expect(table.updateWheres.length).toBeGreaterThan(0);
    for (const where of table.updateWheres) {
      expect(render(where).sql).toContain('"assigned_crm_id" is null');
    }
  });

  it("drains a backlog larger than a batch over repeated runs and levels the load", async () => {
    const accounts = backlog();
    const table = fakeClientAccounts(accounts);
    const { deps, warn } = depsFor(table.db);

    for (let run = 0; run < 4; run++) await tryBackfill(deps, ORG, "user-1");

    expect(warn).not.toHaveBeenCalled();
    expect(table.batchesRead).toEqual([CRM_ASSIGNMENT_BATCH_SIZE, CRM_ASSIGNMENT_BATCH_SIZE, HALF_BATCH, 0]);
    expect(accounts.filter((a) => a.assignedCrmId === null)).toHaveLength(0);

    // Each run re-counts load from the table, so batching must not skew the
    // least-loaded rule: 3 + 0 + 1 + the backlog ends within one of level.
    const loads = MEMBERS.map((m) => accounts.filter((a) => a.assignedCrmId === m).length);
    expect(loads.reduce((sum, n) => sum + n, 0)).toBe(UNOWNED + 4);
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1);
  });

  it("a forced run hands out one batch and reports the rest as unassignedCount", async () => {
    const table = fakeClientAccounts(backlog());
    const { deps } = depsFor(table.db);

    const stats = await runCrmAssignments(deps, ORG);

    expect(stats.unassignedCount).toBe(UNOWNED - CRM_ASSIGNMENT_BATCH_SIZE);
  });
});
