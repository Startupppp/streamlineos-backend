import type { SQL } from "drizzle-orm";
import type { Db } from "../db/drizzle.module";
import { aggregateWorkflowBacklog } from "./workflow-backlog";

interface OrgRow {
  due: number;
  oldest: number;
  leased: number;
  retrying: number;
  dead_lettered: number;
  cancelled: number;
}

function row(overrides: Partial<OrgRow> = {}): OrgRow {
  return {
    due: 0,
    oldest: 0,
    leased: 0,
    retrying: 0,
    dead_lettered: 0,
    cancelled: 0,
    ...overrides,
  };
}

/**
 * `withTenant` issues exactly one `execute` to set the tenant GUC before the
 * callback runs, so responses alternate: the tenant setting, then the sweep's own
 * query. Serving a distinct row per organisation is what makes a cross-tenant
 * single query — the RLS-blind shape this replaced — impossible to pass.
 */
function makeMockDb(orgIds: string[], rows: OrgRow[]): { db: Db; queries: SQL[] } {
  const queries: SQL[] = [];
  let index = 0;

  interface SelectChain {
    from: () => SelectChain;
    where: () => SelectChain;
    orderBy: () => Promise<{ id: string }[]>;
  }
  const chain: SelectChain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(orgIds.map((id) => ({ id }))),
  };

  const execute = (query: SQL): Promise<unknown[]> => {
    const isTenantSetting = index % 2 === 0;
    index += 1;
    if (isTenantSetting) return Promise.resolve([]);
    queries.push(query);
    return Promise.resolve([rows[queries.length - 1] ?? row()]);
  };

  const db = {
    select: () => chain,
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ execute }),
  };

  return { db: db as unknown as Db, queries };
}

describe("aggregateWorkflowBacklog", () => {
  it("issues one query per organisation instead of one cross-tenant count", async () => {
    const { db, queries } = makeMockDb(["org-a", "org-b", "org-c"], [row(), row(), row()]);

    const backlog = await aggregateWorkflowBacklog(db);

    expect(queries).toHaveLength(3);
    expect(backlog.organizations).toBe(3);
    expect(backlog.failedOrganizations).toBe(0);
  });

  it("sums retry, dead-letter and cancellation counts across tenants", async () => {
    const { db } = makeMockDb(
      ["org-a", "org-b"],
      [
        row({ retrying: 2, dead_lettered: 1, cancelled: 4, leased: 3 }),
        row({ retrying: 5, dead_lettered: 7, cancelled: 0, leased: 1 }),
      ],
    );

    const backlog = await aggregateWorkflowBacklog(db);

    expect(backlog.retrying).toBe(7);
    expect(backlog.deadLettered).toBe(8);
    expect(backlog.cancelled).toBe(4);
    expect(backlog.leased).toBe(4);
  });

  it("reports the oldest due age across tenants, not the last one seen", async () => {
    const { db } = makeMockDb(
      ["org-a", "org-b", "org-c"],
      [row({ due: 1, oldest: 900 }), row({ due: 2, oldest: 4_000 }), row({ due: 1, oldest: 10 })],
    );

    const backlog = await aggregateWorkflowBacklog(db);

    expect(backlog.due).toBe(4);
    expect(backlog.oldestDueSeconds).toBe(4_000);
  });

  it("leaves the oldest age null when nothing is due, however many rows exist", async () => {
    const { db } = makeMockDb(["org-a"], [row({ due: 0, oldest: 12_345, cancelled: 9 })]);

    const backlog = await aggregateWorkflowBacklog(db);

    expect(backlog.due).toBe(0);
    expect(backlog.oldestDueSeconds).toBeNull();
    expect(backlog.cancelled).toBe(9);
  });
});
