import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { CronKbTelemetryRetentionService } from "../cron-kb-telemetry-retention.service";
import type { Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant";

jest.mock("../../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;

const ORG_A = "org-aaaa-0000-tenant-a";
const ORG_B = "org-bbbb-1111-tenant-b";

const dialect = new PgDialect();

// ─── A kb_events row carries the searcher's own free text and names them ─────
//
// MECHANISM: this sweep DELETES rows. A predicate that stopped binding the sweeping org
// would not merely disclose another tenant's search history — it would destroy it. Every
// statement is rendered through the real PgDialect and its bound parameters inspected,
// because walking a Drizzle condition object makes the assertion vacuous: the service's
// name appearing in a spec file is what the static gate sees, not whether anything was
// actually asserted.

interface Captured {
  selects: SQL[];
  deletes: SQL[];
}

function emptyCapture(): Captured {
  return { selects: [], deletes: [] };
}

/**
 * Returns one batch on the first select of each table and nothing afterwards, so
 * `deleteInBatches` terminates while still exercising the delete predicate.
 */
function makeTx(captured: Captured) {
  const served = new Set<number>();
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((predicate: SQL) => {
          captured.selects.push(predicate);
          const index = captured.selects.length;
          return {
            limit: jest.fn().mockImplementation(() => {
              if (served.has(index)) return Promise.resolve([]);
              served.add(index);
              return Promise.resolve([{ id: 1 }]);
            }),
          };
        }),
      }),
    }),
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockImplementation((predicate: SQL) => {
        captured.deletes.push(predicate);
        return Promise.resolve([]);
      }),
    }),
  };
}

function boundOrgs(statements: SQL[]): unknown[] {
  return statements.map((s) =>
    dialect.sqlToQuery(s).params.find((v) => v === ORG_A || v === ORG_B),
  );
}

function buildService(): CronKbTelemetryRetentionService {
  return new CronKbTelemetryRetentionService({} as unknown as Db);
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("CronKbTelemetryRetentionService — cross-tenant isolation", () => {
  it("binds only the sweeping org on every selection, so another tenant's telemetry is never a delete candidate", async () => {
    const captured = emptyCapture();
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeTx(captured) as never, ORG_B);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    await buildService().sweep();

    expect(captured.selects.length).toBeGreaterThan(0);
    for (const statement of captured.selects) {
      const rendered = dialect.sqlToQuery(statement);
      expect(rendered.params).toContain(ORG_B);
      expect(rendered.params).not.toContain(ORG_A);
      expect(rendered.sql).toContain('"org_id" =');
    }
  });

  it("sweeps both KB telemetry tables, so neither is silently uncovered", async () => {
    const captured = emptyCapture();
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeTx(captured) as never, ORG_A);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    await buildService().sweep();

    const rendered = captured.selects.map((s) => dialect.sqlToQuery(s).sql);
    expect(rendered.some((s) => s.includes("occurred_at"))).toBe(true);
    expect(rendered.some((s) => s.includes("created_at"))).toBe(true);
  });

  it("(bite proof) sweeping two organisations binds each under its own id, never a shared predicate", async () => {
    const first = emptyCapture();
    const second = emptyCapture();
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeTx(first) as never, ORG_A);
      await fn(makeTx(second) as never, ORG_B);
      return { organizations: 2, succeeded: 2, failed: 0 };
    });

    await buildService().sweep();

    expect(new Set(boundOrgs(first.selects))).toEqual(new Set([ORG_A]));
    expect(new Set(boundOrgs(second.selects))).toEqual(new Set([ORG_B]));
  });

  it("holds both tables behind an unreleased organisation legal hold", async () => {
    const captured = emptyCapture();
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeTx(captured) as never, ORG_A);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    await buildService().sweep();

    for (const statement of captured.selects) {
      const rendered = dialect.sqlToQuery(statement).sql;
      expect(rendered).toContain("organization_legal_holds");
      expect(rendered).toContain("released_at");
    }
  });

  it("holds a searcher's own events behind an HR legal hold naming them", async () => {
    const captured = emptyCapture();
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(makeTx(captured) as never, ORG_A);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    await buildService().sweep();

    const eventSelects = captured.selects
      .map((s) => dialect.sqlToQuery(s).sql)
      .filter((s) => s.includes("occurred_at"));
    expect(eventSelects.length).toBeGreaterThan(0);
    for (const rendered of eventSelects) {
      expect(rendered).toContain("hr_legal_holds");
      expect(rendered).toContain("actor_membership_id");
    }
  });
});
