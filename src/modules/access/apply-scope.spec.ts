import { type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { applyScope } from "./apply-scope";

function isSqlLiteral(s: SQL, literal: string): boolean {
  const first: unknown = s.queryChunks[0];
  if (first == null || typeof first !== "object" || !("value" in first)) return false;
  const value = (first as { value: unknown }).value;
  if (!Array.isArray(value)) return false;
  return (value as unknown[])[0] === literal;
}

function isSqlFalse(s: SQL): boolean {
  return s.queryChunks.length === 1 && isSqlLiteral(s, "false");
}

function isSqlTrue(s: SQL): boolean {
  return s.queryChunks.length === 1 && isSqlLiteral(s, "true");
}

function countSqlParameter(s: SQL, expected: unknown): number {
  const seen = new Set<object>();
  const visit = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((total, item) => total + visit(item), 0);
    if (typeof value !== "object" || value === null || seen.has(value)) return 0;
    seen.add(value);
    const record = value as { value?: unknown; queryChunks?: unknown[] };
    const own = record.value === expected ? 1 : 0;
    return own + (record.queryChunks ? visit(record.queryChunks) : 0);
  };
  return visit(s);
}

const makeCol = (): PgColumn =>
  ({
    table: { _: { name: "test_table" } },
    _: {
      name: "col",
      columnType: "PgText",
      dataType: "string",
      notNull: true,
      hasDefault: false,
      isPrimaryKey: false,
    },
  }) as unknown as PgColumn;

describe("applyScope", () => {
  const userId = "user-abc";
  const ownerColumn = makeCol();
  const teamColumn = makeCol();

  describe("all", () => {
    it("returns sql`true`", () => {
      const result = applyScope("all", "org-a", userId, { ownerColumn });
      expect(isSqlTrue(result)).toBe(true);
    });
  });

  describe("none", () => {
    it("returns sql`false`", () => {
      const result = applyScope("none", "org-a", userId, { ownerColumn });
      expect(isSqlFalse(result)).toBe(true);
    });
  });

  describe("own", () => {
    it("returns an eq expression (not the literal false)", () => {
      const result = applyScope("own", "org-a", userId, { ownerColumn });
      expect(isSqlFalse(result)).toBe(false);
      expect(isSqlTrue(result)).toBe(false);
    });
  });

  describe("team", () => {
    it("resolves teammates from org_unit_members when the table has no team column", () => {
      const result = applyScope("team", "org-a", userId, { ownerColumn });
      expect(isSqlFalse(result)).toBe(false);
      expect(isSqlTrue(result)).toBe(false);
      // The org identifier must be embedded in every TEAM membership branch;
      // otherwise a multi-org user's team in org B can widen access in org A.
      expect(countSqlParameter(result, "org-a")).toBeGreaterThanOrEqual(3);
    });

    it("resolves teammates from org_unit_members when teamIds is empty", () => {
      const result = applyScope("team", "org-a", userId, { ownerColumn, teamColumn, teamIds: [] });
      expect(isSqlFalse(result)).toBe(false);
      expect(isSqlTrue(result)).toBe(false);
    });

    it("uses the explicit team column when teamColumn + teamIds are populated", () => {
      const result = applyScope("team", "org-a", userId, {
        ownerColumn,
        teamColumn,
        teamIds: ["team-1", "team-2"],
      });
      expect(isSqlFalse(result)).toBe(false);
      expect(isSqlTrue(result)).toBe(false);
    });

    it("never widens to every row", () => {
      for (const cols of [{ ownerColumn }, { ownerColumn, teamColumn, teamIds: ["team-1"] }]) {
        expect(isSqlTrue(applyScope("team", "org-a", userId, cols))).toBe(false);
      }
    });
  });
});
