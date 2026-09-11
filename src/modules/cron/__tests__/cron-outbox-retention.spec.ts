jest.mock("../../../common/tenant/for-each-org", () => ({
  forEachOrg: jest.fn(),
}));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { CronOutboxRetentionService, runBatchedDelete } from "../cron-outbox-retention.service";
import type { Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant/for-each-org";
import type { ForEachOrgResult } from "../../../common/tenant/for-each-org";

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;
const ORG_TEST = "org-test-0000-0000-spec";

const dialect = new PgDialect();

/** What `PgTimestamp.mapToDriverValue` produces: "YYYY-MM-DD HH:MM:SS.mmm". */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

function makeTx(rowsPerDelete: unknown[] = []): { tx: unknown; capturedWheres: SQL[] } {
  const capturedWheres: SQL[] = [];
  const tx = {
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockImplementation((pred: SQL) => {
        capturedWheres.push(pred);
        return {
          returning: jest.fn().mockResolvedValue(rowsPerDelete),
        };
      }),
    }),
  };
  return { tx, capturedWheres };
}

function setupSingleOrg(rowsPerDelete: unknown[] = []): { capturedWheres: SQL[] } {
  const { tx, capturedWheres } = makeTx(rowsPerDelete);
  mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
    await fn(tx as never, ORG_TEST);
    return { organizations: 1, succeeded: 1, failed: 0 } satisfies ForEachOrgResult;
  });
  return { capturedWheres };
}

describe("CronOutboxRetentionService — SQL predicates and batching", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe("outbox_events predicate (capturedWheres[0])", () => {
    it("filters only settled delivery states: DELIVERED, SUPPRESSED", async () => {
      const { capturedWheres } = setupSingleOrg([]);
      const svc = new CronOutboxRetentionService({} as unknown as Db);
      await svc.sweep();

      const rendered = dialect.sqlToQuery(capturedWheres[0]!);
      expect(rendered.sql).toContain(
        `"outbox_events"."delivery_state" IN ('DELIVERED', 'SUPPRESSED')`,
      );
    });

    it("BITE: never deletes a DEAD row — an undrained dead letter is unfinished work, not history", async () => {
      const { capturedWheres } = setupSingleOrg([]);
      const svc = new CronOutboxRetentionService({} as unknown as Db);
      await svc.sweep();

      const rendered = dialect.sqlToQuery(capturedWheres[0]!);
      expect(rendered.sql).not.toContain("'DEAD'");
    });

    it("does NOT include PENDING rows in the delete predicate", async () => {
      const { capturedWheres } = setupSingleOrg([]);
      const svc = new CronOutboxRetentionService({} as unknown as Db);
      await svc.sweep();

      const rendered = dialect.sqlToQuery(capturedWheres[0]!);
      expect(rendered.sql).not.toContain("'PENDING'");
    });

    it("does NOT include IN_FLIGHT rows in the delete predicate", async () => {
      const { capturedWheres } = setupSingleOrg([]);
      const svc = new CronOutboxRetentionService({} as unknown as Db);
      await svc.sweep();

      const rendered = dialect.sqlToQuery(capturedWheres[0]!);
      expect(rendered.sql).not.toContain("'IN_FLIGHT'");
    });

    it("binds occurred_at time filter — only rows older than the cutoff are deleted", async () => {
      const { capturedWheres } = setupSingleOrg([]);
      const svc = new CronOutboxRetentionService({} as unknown as Db);
      await svc.sweep();

      const rendered = dialect.sqlToQuery(capturedWheres[0]!);
      expect(rendered.sql).toContain(`"outbox_events"."occurred_at" <`);
    });

    /**
     * This assertion used to read `params.some((p) => p instanceof Date)`, and a
     * raw `Date` in the parameter list was precisely the second half of the
     * defect: interpolated into a bare `sql` template the cutoff carried no
     * column encoder, postgres.js resolved the parameter type from the server
     * (OID 1114) and handed the `Date` to the text serializer, which throws at
     * BIND time. So the old assertion certified the bug. What is required is the
     * opposite — the cutoff reaches the driver already encoded by the column's
     * own `timestamp` mapper, and no bare `Date` survives to the wire.
     */
    it("binds the cutoff through the column encoder, never as a raw Date", async () => {
      const { capturedWheres } = setupSingleOrg([]);
      const svc = new CronOutboxRetentionService({} as unknown as Db);
      await svc.sweep();

      const rendered = dialect.sqlToQuery(capturedWheres[0]!);
      expect(rendered.params.some((p) => p instanceof Date)).toBe(false);
      expect(
        rendered.params.some((p) => typeof p === "string" && ISO_TIMESTAMP.test(p)),
      ).toBe(true);
    });

    it("binds org_id in the outbox predicate to scope the delete to the org", async () => {
      const { capturedWheres } = setupSingleOrg([]);
      const svc = new CronOutboxRetentionService({} as unknown as Db);
      await svc.sweep();

      const rendered = dialect.sqlToQuery(capturedWheres[0]!);
      expect(rendered.params).toContain(ORG_TEST);
      // `outbox_events` has no `org_id`; its tenant column is `organization_id`.
      // Asserting the wrong name here certified a statement that raised 42703
      // for every tenant, and `forEachOrg` swallowed the throw.
      expect(rendered.sql).toContain(`"outbox_events"."organization_id" =`);
    });
  });

  describe("inbox_records predicate (capturedWheres[1])", () => {
    it("filters only processed rows: processed_at IS NOT NULL", async () => {
      const { capturedWheres } = setupSingleOrg([]);
      const svc = new CronOutboxRetentionService({} as unknown as Db);
      await svc.sweep();

      const rendered = dialect.sqlToQuery(capturedWheres[1]!);
      expect(rendered.sql.toLowerCase()).toContain(`"processed_at" is not null`);
    });

    it("binds processed_at time filter — only rows older than the cutoff are deleted", async () => {
      const { capturedWheres } = setupSingleOrg([]);
      const svc = new CronOutboxRetentionService({} as unknown as Db);
      await svc.sweep();

      const rendered = dialect.sqlToQuery(capturedWheres[1]!);
      expect(rendered.sql).toContain(`"inbox_records"."processed_at" <`);
    });

    it("binds the cutoff through the column encoder for inbox_records too", async () => {
      const { capturedWheres } = setupSingleOrg([]);
      const svc = new CronOutboxRetentionService({} as unknown as Db);
      await svc.sweep();

      const rendered = dialect.sqlToQuery(capturedWheres[1]!);
      expect(rendered.params.some((p) => p instanceof Date)).toBe(false);
      expect(
        rendered.params.some((p) => typeof p === "string" && ISO_TIMESTAMP.test(p)),
      ).toBe(true);
    });

    it("binds org_id in the inbox predicate to scope the delete to the org", async () => {
      const { capturedWheres } = setupSingleOrg([]);
      const svc = new CronOutboxRetentionService({} as unknown as Db);
      await svc.sweep();

      const rendered = dialect.sqlToQuery(capturedWheres[1]!);
      expect(rendered.params).toContain(ORG_TEST);
      // Same defect, same table-specific truth: `inbox_records.organization_id`.
      expect(rendered.sql).toContain(`"inbox_records"."organization_id" =`);
    });
  });

  describe("result counts", () => {
    it("reports 0 outboxEventsDeleted when no rows match", async () => {
      setupSingleOrg([]);
      const svc = new CronOutboxRetentionService({} as unknown as Db);
      const result = await svc.sweep();
      expect(result.outboxEventsDeleted).toBe(0);
    });

    it("reports 0 inboxRecordsDeleted when no rows match", async () => {
      setupSingleOrg([]);
      const svc = new CronOutboxRetentionService({} as unknown as Db);
      const result = await svc.sweep();
      expect(result.inboxRecordsDeleted).toBe(0);
    });

    it("truncated is false when all rows fit in a single batch", async () => {
      setupSingleOrg([]);
      const svc = new CronOutboxRetentionService({} as unknown as Db);
      const result = await svc.sweep();
      expect(result.truncated).toBe(false);
    });
  });

  describe("idempotency", () => {
    it("re-running sweep with 0 eligible rows does not throw and returns 0 counts both times", async () => {
      const svc = new CronOutboxRetentionService({} as unknown as Db);

      setupSingleOrg([]);
      const r1 = await svc.sweep();

      setupSingleOrg([]);
      const r2 = await svc.sweep();

      expect(r1.outboxEventsDeleted).toBe(0);
      expect(r1.inboxRecordsDeleted).toBe(0);
      expect(r1.truncated).toBe(false);
      expect(r2.outboxEventsDeleted).toBe(0);
      expect(r2.inboxRecordsDeleted).toBe(0);
      expect(r2.truncated).toBe(false);
    });
  });
});

describe("CronOutboxRetentionService — batching and resumability", () => {
  it("runs a second batch when the first returns exactly BATCH_SIZE (1000) rows — resumable", async () => {
    let calls = 0;

    const result = await runBatchedDelete(async () => {
      calls += 1;
      return calls === 1 ? 1000 : 0;
    }, jest.fn());

    expect(calls).toBe(2);
    expect(result.count).toBe(1000);
    expect(result.truncated).toBe(false);
  });

  it("stops immediately after a partial batch returns fewer than BATCH_SIZE rows", async () => {
    let calls = 0;

    const result = await runBatchedDelete(async () => {
      calls += 1;
      return calls < 3 ? 1000 : 7;
    }, jest.fn());

    expect(calls).toBe(3);
    expect(result.count).toBe(2007);
    expect(result.truncated).toBe(false);
  });

  it("sets truncated=true, accumulates count and warns when MAX_BATCHES (50) all return full", async () => {
    const onCapped = jest.fn();

    const result = await runBatchedDelete(async () => 1000, onCapped);

    expect(result.truncated).toBe(true);
    expect(result.count).toBe(50_000);
    expect(onCapped).toHaveBeenCalledTimes(1);
  });

  it("(bite proof) partial final batch → truncated=false; all-full run → truncated=true", async () => {
    let calls1 = 0;
    const partial = await runBatchedDelete(async () => {
      calls1 += 1;
      return calls1 <= 1 ? 1000 : 5;
    }, jest.fn());

    const full = await runBatchedDelete(async () => 1000, jest.fn());

    expect(partial.truncated).toBe(false);
    expect(full.truncated).toBe(true);
  });
});
