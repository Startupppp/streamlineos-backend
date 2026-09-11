import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { CronNotificationOutboxRetentionService } from "../cron-notification-outbox-retention.service";
import type { Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant/for-each-org";

jest.mock("../../../common/tenant/for-each-org", () => ({
  forEachOrg: jest.fn(),
}));

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

describe("CronNotificationOutboxRetentionService — cross-tenant isolation", () => {
  let svc: CronNotificationOutboxRetentionService;

  beforeEach(() => {
    jest.resetAllMocks();
    svc = new CronNotificationOutboxRetentionService({} as unknown as Db);
  });

  it("binds only the sweeping org's id, so another tenant's rows are unreachable", async () => {
    const captured: SQL[] = [];
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeTx(captured) as never, ORG_B);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    await svc.sweep();

    expect(captured).toHaveLength(1);
    const rendered = dialect.sqlToQuery(captured[0]!);
    expect(rendered.params).toContain(ORG_B);
    expect(rendered.params).not.toContain(ORG_A);
    expect(rendered.sql).toContain("org_id =");
  });

  it("sweeps each organization under its own id rather than a shared predicate", async () => {
    const captured: SQL[] = [];
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeTx(captured) as never, ORG_A);
      await fn(makeTx(captured) as never, ORG_B);
      return { organizations: 2, succeeded: 2, failed: 0 };
    });

    await svc.sweep();

    const boundOrgs = captured.map((p) =>
      dialect.sqlToQuery(p).params.find((v) => v === ORG_A || v === ORG_B),
    );
    expect(boundOrgs).toEqual([ORG_A, ORG_B]);
  });

  it("only ever deletes terminal rows older than the cutoff", async () => {
    const captured: SQL[] = [];
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeTx(captured) as never, ORG_A);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    await svc.sweep();

    const rendered = dialect.sqlToQuery(captured[0]!);
    expect(rendered.sql).toContain("state IN ('PROCESSED', 'DEAD')");
    expect(rendered.sql).toContain("created_at <");
  });
});
