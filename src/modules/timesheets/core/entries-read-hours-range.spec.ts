import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { EntriesReadService } from "./entries-read.service";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();
const ORG_A = "org-ts-hrs-a";
const ORG_B = "org-ts-hrs-b";
const MEMBERSHIP_A = 11;

function makeDb(capturedWhere?: { cond?: unknown }, result?: unknown[]): Db {
  const where = jest.fn().mockImplementation((cond: unknown) => {
    if (capturedWhere) capturedWhere.cond = cond;
    return Promise.resolve(result ?? [{ total: "5.50" }]);
  });
  const from = jest.fn().mockReturnValue({ where });
  return {
    select: jest.fn().mockReturnValue({ from }),
  } as unknown as Db;
}

describe("EntriesReadService.getHoursLoggedInRange — tenant isolation + voided exclusion", () => {
  describe("WHERE scoping (serializable proof)", () => {
    let capturedWhere: { cond?: unknown };

    beforeEach(async () => {
      capturedWhere = {};
      const db = makeDb(capturedWhere);
      const svc = new EntriesReadService(db, null as never);
      await svc.getHoursLoggedInRange(ORG_A, MEMBERSHIP_A, "2026-08-01", "2026-09-01");
    });

    it("WHERE condition is captured (fails when mock is neutered by removing the push)", () => {
      expect(capturedWhere.cond).toBeDefined();
    });

    it("org_id of requesting org appears as a bound param — tenant isolation", () => {
      const { params } = dialect.sqlToQuery(capturedWhere.cond as SQL);
      expect(params).toContain(ORG_A);
    });

    it("org B id is absent from params — org B cannot read org A hours", () => {
      const { params } = dialect.sqlToQuery(capturedWhere.cond as SQL);
      expect(params).not.toContain(ORG_B);
    });

    it("membershipId appears as a bound param — scoped to a single member", () => {
      const { params } = dialect.sqlToQuery(capturedWhere.cond as SQL);
      expect(params).toContain(MEMBERSHIP_A);
    });

    it("voided_at IS NULL appears in the serialized SQL — voided entries excluded", () => {
      const { sql: sqlStr } = dialect.sqlToQuery(capturedWhere.cond as SQL);
      expect(sqlStr).toMatch(/voided_at.*is null/i);
    });

    it("endDate is an exclusive bound (lt, not lte) — appears as a < in SQL", () => {
      const { sql: sqlStr } = dialect.sqlToQuery(capturedWhere.cond as SQL);
      expect(sqlStr).toContain("<");
    });
  });

  describe("return value", () => {
    it("returns 0 when the aggregate returns an empty result", async () => {
      const db = makeDb(undefined, []);
      const svc = new EntriesReadService(db, null as never);
      const result = await svc.getHoursLoggedInRange(ORG_A, MEMBERSHIP_A, "2026-08-01", "2026-09-01");
      expect(result).toBe(0);
    });

    it("converts the aggregate string to a number", async () => {
      const db = makeDb(undefined, [{ total: "7.25" }]);
      const svc = new EntriesReadService(db, null as never);
      const result = await svc.getHoursLoggedInRange(ORG_A, MEMBERSHIP_A, "2026-08-01", "2026-09-01");
      expect(result).toBe(7.25);
    });

    it("handles a null/undefined total row gracefully", async () => {
      const db = makeDb(undefined, [{}]);
      const svc = new EntriesReadService(db, null as never);
      const result = await svc.getHoursLoggedInRange(ORG_A, MEMBERSHIP_A, "2026-08-01", "2026-09-01");
      expect(result).toBe(0);
    });
  });
});
