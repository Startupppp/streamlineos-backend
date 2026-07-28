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
      const result = applyScope("all", userId, { ownerColumn });
      expect(isSqlTrue(result)).toBe(true);
    });
  });

  describe("none", () => {
    it("returns sql`false`", () => {
      const result = applyScope("none", userId, { ownerColumn });
      expect(isSqlFalse(result)).toBe(true);
    });
  });

  describe("own", () => {
    it("returns an eq expression (not the literal false)", () => {
      const result = applyScope("own", userId, { ownerColumn });
      expect(isSqlFalse(result)).toBe(false);
      expect(isSqlTrue(result)).toBe(false);
    });
  });

  describe("team — §5 fail-closed behaviour", () => {
    it("returns sql`false` (deny) when no teamColumn or teamIds are provided", () => {
      const result = applyScope("team", userId, { ownerColumn });
      expect(isSqlFalse(result)).toBe(true);
    });

    it("returns sql`false` (deny) when teamColumn is provided but teamIds is empty", () => {
      const result = applyScope("team", userId, {
        ownerColumn,
        teamColumn,
        teamIds: [],
      });
      expect(isSqlFalse(result)).toBe(true);
    });

    it("returns sql`false` (deny) when teamIds is undefined even with a teamColumn", () => {
      const result = applyScope("team", userId, {
        ownerColumn,
        teamColumn,
        teamIds: undefined,
      });
      expect(isSqlFalse(result)).toBe(true);
    });

    it("returns a compound expression (not the literal false) when teamColumn + teamIds are populated", () => {
      const result = applyScope("team", userId, {
        ownerColumn,
        teamColumn,
        teamIds: ["dept-1", "dept-2"],
      });
      expect(isSqlFalse(result)).toBe(false);
      expect(isSqlTrue(result)).toBe(false);
    });
  });
});
