import { type SQL } from "drizzle-orm";
import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import { applyScope } from "./apply-scope";

const dialect = new PgDialect();

function render(value: SQL): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(value);
  return { sql: query.sql, params: query.params };
}

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

const testTable = pgTable("test_table", {
  assignedToId: text("assigned_to_id").notNull(),
  teamId: text("team_id").notNull(),
});

describe("applyScope", () => {
  const userId = "user-abc";
  const ownerColumn = testTable.assignedToId;
  const teamColumn = testTable.teamId;

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
    it("binds the owner column to the acting user, not to any other column or id", () => {
      const result = applyScope("own", "org-a", userId, { ownerColumn, teamColumn });

      expect(isSqlFalse(result)).toBe(false);
      expect(isSqlTrue(result)).toBe(false);

      const { sql, params } = render(result);
      expect(sql).toBe('"test_table"."assigned_to_id" = $1');
      expect(sql).not.toContain("team_id");
      expect(params).toEqual([userId]);
    });
  });

  describe("team", () => {
    it("falls back to own scope when no teamColumn or teamIds supplied", () => {
      const result = applyScope("team", "org-a", userId, { ownerColumn });

      const { sql, params } = render(result);
      expect(sql).toBe('"test_table"."assigned_to_id" = $1');
      expect(params).toEqual([userId]);
    });

    it("falls back to own scope when teamIds is empty", () => {
      const result = applyScope("team", "org-a", userId, { ownerColumn, teamColumn, teamIds: [] });

      const { sql, params } = render(result);
      expect(sql).toBe('"test_table"."assigned_to_id" = $1');
      expect(sql).not.toContain("team_id");
      expect(params).toEqual([userId]);
    });

    it("ORs the owner predicate with an IN over the explicit team column", () => {
      const result = applyScope("team", "org-a", userId, {
        ownerColumn,
        teamColumn,
        teamIds: ["team-1", "team-2"],
      });

      const { sql, params } = render(result);
      expect(sql).toBe(
        '("test_table"."assigned_to_id" = $1 OR "test_table"."team_id" in ($2, $3))',
      );
      expect(params).toEqual([userId, "team-1", "team-2"]);
    });

    it("never widens to every row", () => {
      for (const cols of [{ ownerColumn }, { ownerColumn, teamColumn, teamIds: ["team-1"] }]) {
        const result = applyScope("team", "org-a", userId, cols);
        expect(isSqlTrue(result)).toBe(false);
        expect(render(result).sql).toContain("assigned_to_id");
      }
    });
  });
});
