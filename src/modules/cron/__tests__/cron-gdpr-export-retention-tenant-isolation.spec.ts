import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { CronGdprExportRetentionService } from "../cron-gdpr-export-retention.service";
import type { Db } from "../../../db/drizzle.module";
import { StorageService } from "../../storage/storage.service";
import { forEachOrg, withTenant } from "../../../common/tenant";

jest.mock("../../../common/tenant", () => ({
  forEachOrg: jest.fn(),
  withTenant: jest.fn(),
}));

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;
const mockedWithTenant = withTenant as jest.MockedFunction<typeof withTenant>;

const ORG_A = "org-aaaa-0000-tenant-a";
const ORG_B = "org-bbbb-1111-tenant-b";
const ARTIFACT_OF_A = "gdpr-exports/tenant-a-subject.json";

const dialect = new PgDialect();

// ─── One subject's export archive is the most concentrated PII in the system ──
//
// MECHANISM: this sweep both reads and destroys `gdpr_export_jobs` rows and the objects
// they name. A predicate that leaked past `org_id` would not merely disclose another
// tenant's data — it would delete their subject's export archive. Every statement is
// rendered through the real PgDialect and its bound parameters inspected, so a predicate
// that stopped binding the sweeping org fails here rather than passing on the strength of
// the service's name appearing in a spec file.

interface Captured {
  selects: SQL[];
  updates: SQL[];
  auditOrgIds: unknown[];
}

function makeTx(captured: Captured, artifactRows: Array<{ id: string; fileKey: string }>) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((predicate: SQL) => {
          captured.selects.push(predicate);
          return {
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(
                captured.selects.length === 1 ? artifactRows : [],
              ),
            }),
          };
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((predicate: SQL) => {
          captured.updates.push(predicate);
          const settled = Promise.resolve([]);
          return Object.assign(settled, {
            returning: jest.fn().mockResolvedValue([]),
          });
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((row: { orgId: unknown }) => {
        captured.auditOrgIds.push(row.orgId);
        return Promise.resolve(undefined);
      }),
    }),
  };
}

function emptyCapture(): Captured {
  return { selects: [], updates: [], auditOrgIds: [] };
}

function boundOrgs(statements: SQL[]): unknown[] {
  return statements.map((s) =>
    dialect.sqlToQuery(s).params.find((v) => v === ORG_A || v === ORG_B),
  );
}

function makeStorage() {
  return { deleteFileIfPresent: jest.fn().mockResolvedValue(true) };
}

function buildService(storage: { deleteFileIfPresent: jest.Mock }) {
  return new CronGdprExportRetentionService(
    {} as unknown as Db,
    storage as unknown as StorageService,
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  mockedWithTenant.mockImplementation(async (_db, _ctx, fn) =>
    fn({ update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }) } as never),
  );
});

describe("CronGdprExportRetentionService — cross-tenant isolation", () => {
  it("binds only the sweeping org's id on every statement, so another tenant's archives are unreachable", async () => {
    const captured = emptyCapture();
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeTx(captured, []) as never, ORG_B);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    await buildService(makeStorage()).sweep();

    expect(captured.selects.length + captured.updates.length).toBeGreaterThan(0);
    for (const statement of [...captured.selects, ...captured.updates]) {
      const rendered = dialect.sqlToQuery(statement);
      expect(rendered.params).toContain(ORG_B);
      expect(rendered.params).not.toContain(ORG_A);
      expect(rendered.sql).toContain('"org_id" =');
    }
  });

  it("(bite proof) sweeping two organisations binds each under its own id, never a shared predicate", async () => {
    const first = emptyCapture();
    const second = emptyCapture();
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeTx(first, []) as never, ORG_A);
      await fn(makeTx(second, []) as never, ORG_B);
      return { organizations: 2, succeeded: 2, failed: 0 };
    });

    await buildService(makeStorage()).sweep();

    expect(new Set(boundOrgs(first.selects))).toEqual(new Set([ORG_A]));
    expect(new Set(boundOrgs(second.selects))).toEqual(new Set([ORG_B]));
    expect(new Set(boundOrgs(first.updates))).toEqual(new Set([ORG_A]));
    expect(new Set(boundOrgs(second.updates))).toEqual(new Set([ORG_B]));
  });

  it("only ever retires artifacts already past their expiry, in a terminal status", async () => {
    const captured = emptyCapture();
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeTx(captured, []) as never, ORG_A);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    await buildService(makeStorage()).sweep();

    const rendered = dialect.sqlToQuery(captured.selects[0]!);
    expect(rendered.sql).toContain('"expires_at" <');
    expect(rendered.sql).toContain('"file_key" is not null');
    expect(rendered.params).toContain("completed");
    expect(rendered.params).toContain("expired");
  });

  it("reclaims only jobs this tenant left stale in running", async () => {
    const captured = emptyCapture();
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeTx(captured, []) as never, ORG_A);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    await buildService(makeStorage()).sweep();

    const reclaim = dialect.sqlToQuery(captured.updates[0]!);
    expect(reclaim.params).toContain(ORG_A);
    expect(reclaim.params).toContain("running");
    expect(reclaim.sql).toContain('"locked_at" <=');
  });

  it("deletes the object and clears the pointer under the owning tenant, never a neighbour's", async () => {
    const captured = emptyCapture();
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(
        makeTx(captured, [{ id: "job-a", fileKey: ARTIFACT_OF_A }]) as never,
        ORG_A,
      );
      return { organizations: 1, succeeded: 1, failed: 0 };
    });
    const storage = makeStorage();

    await buildService(storage).sweep();

    expect(storage.deleteFileIfPresent).toHaveBeenCalledWith(ORG_A, ARTIFACT_OF_A);
    expect(storage.deleteFileIfPresent).not.toHaveBeenCalledWith(
      ORG_B,
      expect.anything(),
    );
    expect(mockedWithTenant).toHaveBeenCalledTimes(1);
    expect(mockedWithTenant.mock.calls[0]?.[1]).toMatchObject({ orgId: ORG_A });
  });

  it("writes the retention audit row under the sweeping tenant", async () => {
    const captured = emptyCapture();
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(
        makeTx(captured, [{ id: "job-a", fileKey: ARTIFACT_OF_A }]) as never,
        ORG_B,
      );
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    await buildService(makeStorage()).sweep();

    expect(captured.auditOrgIds).toEqual([ORG_B]);
  });
});
