import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  CronNotificationOutboxRetentionService,
  NOTIFICATION_OUTBOX_RETENTION_DAYS,
  NOTIFICATION_OUTBOX_DEAD_RETENTION_DAYS,
} from "../cron-notification-outbox-retention.service";
import type { Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant/for-each-org";

jest.mock("../../../common/tenant/for-each-org", () => ({
  forEachOrg: jest.fn(),
}));

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;
const dialect = new PgDialect();
const ORG = "org-aaaa-0000-tenant-a";

/**
 * A DEAD `notification_outbox` row is the record that a notification somebody was
 * owed will never arrive — the same row `alert-dead-notification-outbox.mjs` pages
 * on. It used to be purged on the PROCESSED schedule, so the sweep and the DLQ
 * watcher answered to different clocks and an investigation opened after the sweep
 * found nothing left to investigate.
 */
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

async function sweepOnce(): Promise<{ sql: string; params: unknown[] }> {
  const captured: SQL[] = [];
  mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
    await fn(makeTx(captured) as never, ORG);
    return { organizations: 1, succeeded: 1, failed: 0 };
  });
  const svc = new CronNotificationOutboxRetentionService({} as unknown as Db);
  await svc.sweep();
  const first = captured[0];
  if (first === undefined) throw new Error("the sweep issued no delete");
  const rendered = dialect.sqlToQuery(first);
  return { sql: rendered.sql, params: [...rendered.params] };
}

describe("notification outbox DEAD retention", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("holds DEAD rows far longer than the 24h dead-letter alert window", () => {
    expect(NOTIFICATION_OUTBOX_DEAD_RETENTION_DAYS).toBeGreaterThan(
      NOTIFICATION_OUTBOX_RETENTION_DAYS,
    );
    expect(NOTIFICATION_OUTBOX_DEAD_RETENTION_DAYS).toBeGreaterThanOrEqual(90);
  });

  it("purges DEAD rows on their own cutoff, not the PROCESSED one", async () => {
    const { sql, params } = await sweepOnce();
    expect(sql).toContain("state IN ('PROCESSED', 'DEAD')");
    expect(sql).toMatch(/CASE WHEN state = 'DEAD' THEN/);

    const dates = params.filter((p): p is Date => p instanceof Date);
    expect(dates).toHaveLength(2);
    const [deadCutoff, processedCutoff] = [...dates].sort(
      (a, b) => a.getTime() - b.getTime(),
    );
    if (deadCutoff === undefined || processedCutoff === undefined)
      throw new Error("the sweep bound fewer than two cutoffs");

    const spreadDays = (processedCutoff.getTime() - deadCutoff.getTime()) / 86_400_000;
    expect(Math.round(spreadDays)).toBe(
      NOTIFICATION_OUTBOX_DEAD_RETENTION_DAYS - NOTIFICATION_OUTBOX_RETENTION_DAYS,
    );
  });

  it("still binds the sweeping org so the wider horizon is not a cross-tenant reach", async () => {
    const { sql, params } = await sweepOnce();
    expect(params).toContain(ORG);
    expect(sql).toContain("org_id =");
  });
});
