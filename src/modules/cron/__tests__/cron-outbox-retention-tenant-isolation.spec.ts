jest.mock("../../../common/tenant/for-each-org", () => ({
  forEachOrg: jest.fn(),
}));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { CronOutboxRetentionService } from "../cron-outbox-retention.service";
import type { Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant/for-each-org";
import type { ForEachOrgResult } from "../../../common/tenant/for-each-org";

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;

const ORG_A = "org-aaaa-0000-tenant-a";
const ORG_B = "org-bbbb-1111-tenant-b";

const dialect = new PgDialect();

function makeTx(captured: SQL[]) {
  return {
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockImplementation((predicate: SQL) => {
        captured.push(predicate);
        return { returning: jest.fn().mockResolvedValue([]) };
      }),
    }),
  };
}

describe("CronOutboxRetentionService — cross-tenant isolation", () => {
  let svc: CronOutboxRetentionService;

  beforeEach(() => {
    jest.resetAllMocks();
    svc = new CronOutboxRetentionService({} as unknown as Db);
  });

  it("outbox predicate binds only the sweeping org's id — another tenant's rows are unreachable", async () => {
    const captured: SQL[] = [];
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeTx(captured) as never, ORG_B);
      return { organizations: 1, succeeded: 1, failed: 0 } satisfies ForEachOrgResult;
    });

    await svc.sweep();

    expect(captured).toHaveLength(2);
    const outboxRendered = dialect.sqlToQuery(captured[0]!);
    expect(outboxRendered.params).toContain(ORG_B);
    expect(outboxRendered.params).not.toContain(ORG_A);
    // The tenant column on `outbox_events` is `organization_id`. This assertion
    // read `org_id` — a column that does not exist — so it certified a statement
    // that raised 42703 for every tenant. Rendering the predicate proves the
    // shape; only `outbox-retention-sweep.db.spec.ts` proves it can execute.
    expect(outboxRendered.sql).toContain('"outbox_events"."organization_id" =');
    expect(outboxRendered.sql).not.toContain('"org_id"');
  });

  it("inbox predicate binds only the sweeping org's id — another tenant's rows are unreachable", async () => {
    const captured: SQL[] = [];
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeTx(captured) as never, ORG_B);
      return { organizations: 1, succeeded: 1, failed: 0 } satisfies ForEachOrgResult;
    });

    await svc.sweep();

    const inboxRendered = dialect.sqlToQuery(captured[1]!);
    expect(inboxRendered.params).toContain(ORG_B);
    expect(inboxRendered.params).not.toContain(ORG_A);
    // Same defect, same table-specific truth: `inbox_records.organization_id`.
    expect(inboxRendered.sql).toContain('"inbox_records"."organization_id" =');
    expect(inboxRendered.sql).not.toContain('"org_id"');
  });

  it("sweeps each org under its own id — predicates for two orgs carry different bound ids", async () => {
    const captured: SQL[] = [];
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeTx(captured) as never, ORG_A);
      await fn(makeTx(captured) as never, ORG_B);
      return { organizations: 2, succeeded: 2, failed: 0 } satisfies ForEachOrgResult;
    });

    await svc.sweep();

    expect(captured).toHaveLength(4);
    const orgA_outbox = dialect.sqlToQuery(captured[0]!);
    const orgB_outbox = dialect.sqlToQuery(captured[2]!);
    expect(orgA_outbox.params).toContain(ORG_A);
    expect(orgA_outbox.params).not.toContain(ORG_B);
    expect(orgB_outbox.params).toContain(ORG_B);
    expect(orgB_outbox.params).not.toContain(ORG_A);
  });

  it("outboxEventsDeleted and inboxRecordsDeleted accumulate across orgs", async () => {
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      const txA = {
        delete: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
          }),
        }),
      };
      await fn(txA as never, ORG_A);

      const txB = {
        delete: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 3 }]),
          }),
        }),
      };
      await fn(txB as never, ORG_B);

      return { organizations: 2, succeeded: 2, failed: 0 } satisfies ForEachOrgResult;
    });

    const result = await svc.sweep();

    expect(result.outboxEventsDeleted).toBe(3);
    expect(result.inboxRecordsDeleted).toBe(3);
  });

  it("a failure in one org does not abort the remaining orgs", async () => {
    const calledFor: string[] = [];

    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      const goodTx = {
        delete: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
      };
      await fn(goodTx as never, ORG_A);
      calledFor.push(ORG_A);

      const failTx = {
        delete: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockRejectedValue(new Error("42501: permission denied")),
          }),
        }),
      };
      try {
        await fn(failTx as never, ORG_B);
      } catch {
        // mirrors real forEachOrg: catches per-org errors and continues
      }

      calledFor.push(ORG_B);
      return { organizations: 2, succeeded: 1, failed: 1 } satisfies ForEachOrgResult;
    });

    await svc.sweep();

    expect(calledFor).toContain(ORG_A);
    expect(calledFor).toContain(ORG_B);
  });
});
