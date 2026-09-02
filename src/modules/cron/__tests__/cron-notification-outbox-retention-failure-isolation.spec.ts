/**
 * cron-notification-outbox-retention-failure-isolation.spec.ts
 *
 * Supplements cron-notification-outbox-retention-tenant-isolation.spec.ts with:
 *   - Failure isolation: a DB error in one org's callback does not abort remaining orgs
 *   - rowsDeleted accumulates only from successful orgs
 *   - Idempotency: re-running with 0 rows on the second pass returns 0 deleted
 *   - The service returns the correct organizationsScanned from forEachOrg
 */

jest.mock("../../../common/tenant/for-each-org", () => ({
  forEachOrg: jest.fn(),
}));

import { CronNotificationOutboxRetentionService } from "../cron-notification-outbox-retention.service";
import type { Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant/for-each-org";
import type { ForEachOrgResult } from "../../../common/tenant/for-each-org";

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;

const ORG_A = "org-aaaa-fail-isolation-a";
const ORG_B = "org-bbbb-fail-isolation-b";
const ORG_C = "org-cccc-fail-isolation-c";

function makeSweepTx(rows: Array<{ id: number }>): unknown {
  return {
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

function makeFailTx(): unknown {
  return {
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockRejectedValue(new Error("42501: permission denied by RLS")),
      }),
    }),
  };
}

describe("CronNotificationOutboxRetentionService — failure isolation and idempotency", () => {
  let svc: CronNotificationOutboxRetentionService;

  beforeEach(() => {
    jest.resetAllMocks();
    svc = new CronNotificationOutboxRetentionService({} as unknown as Db);
  });

  it("a failure in one org does not abort the sweep of remaining orgs", async () => {
    const calledFor: string[] = [];

    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeSweepTx([{ id: 1 }]) as never, ORG_A);
      calledFor.push(ORG_A);

      try {
        await fn(makeFailTx() as never, ORG_B);
      } catch {
        // mirrors real forEachOrg: catches per-org failures and continues
      }

      await fn(makeSweepTx([{ id: 2 }, { id: 3 }]) as never, ORG_C);
      calledFor.push(ORG_C);

      return { organizations: 3, succeeded: 2, failed: 1 } satisfies ForEachOrgResult;
    });

    const result = await svc.sweep();

    expect(calledFor).toContain(ORG_C);
    expect(result.rowsDeleted).toBe(3);
    expect(result.organizationsScanned).toBe(3);
  });

  it("rowsDeleted accumulates only from successful orgs, skipping the failed one", async () => {
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(
        makeSweepTx([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]) as never,
        ORG_A,
      );

      try {
        await fn(makeFailTx() as never, ORG_B);
      } catch {
        // swallowed like real forEachOrg
      }

      return { organizations: 2, succeeded: 1, failed: 1 } satisfies ForEachOrgResult;
    });

    const result = await svc.sweep();

    expect(result.rowsDeleted).toBe(5);
  });

  it("organizationsScanned matches what forEachOrg returns, not just the successful count", async () => {
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeSweepTx([]) as never, ORG_A);
      return { organizations: 5, succeeded: 5, failed: 0 } satisfies ForEachOrgResult;
    });

    const result = await svc.sweep();

    expect(result.organizationsScanned).toBe(5);
  });

  it("sweep does not throw when forEachOrg reports all failures (no callbacks invoked)", async () => {
    mockedForEachOrg.mockImplementation(async (_db, _name, _fn) => {
      return { organizations: 2, succeeded: 0, failed: 2 } satisfies ForEachOrgResult;
    });

    const result = await svc.sweep();

    expect(result.organizationsScanned).toBe(2);
    expect(result.rowsDeleted).toBe(0);
  });

  it("idempotency: re-running with 0 rows on the second pass returns 0 deleted", async () => {
    let passCount = 0;

    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      const rows = passCount === 0 ? [{ id: 10 }] : [];
      passCount += 1;
      await fn(makeSweepTx(rows) as never, ORG_A);
      return { organizations: 1, succeeded: 1, failed: 0 } satisfies ForEachOrgResult;
    });

    const first = await svc.sweep();
    const second = await svc.sweep();

    expect(first.rowsDeleted).toBe(1);
    expect(second.rowsDeleted).toBe(0);
  });
});
