import { PgDialect } from "drizzle-orm/pg-core";
import { buildCursorPredicate, buildMineCursorPredicate, serializeSortValue } from "./projects-work-query.cursor";
import { decodeCursor, encodeCursor } from "../../../common/pagination/cursor";

const timestamp = "2026-09-09 12:34:56.123456";
const position = { sortValue: timestamp, id: "42" };
const dialect = new PgDialect();

describe("Work cursor timestamp precision", () => {
  it.each(["created", "updated"] as const)("preserves PostgreSQL microseconds in %s predicates", (sortKey) => {
    expect(dialect.sqlToQuery(buildCursorPredicate(sortKey, "desc", position)).params[0]).toBe(timestamp);
    expect(dialect.sqlToQuery(buildMineCursorPredicate(sortKey, "desc", position)).params[0]).toBe(timestamp);
  });

  it("serializes exact timestamp projections instead of lossy JavaScript dates", () => {
    const row = { rank: "a0", priority: "HIGH", dueDate: null, createdAt: new Date(timestamp), updatedAt: new Date(timestamp), cursorCreatedAt: timestamp, cursorUpdatedAt: timestamp };
    expect(serializeSortValue(row, "created")).toBe(timestamp);
    expect(serializeSortValue(row, "updated")).toBe(timestamp);
  });

  it("round-trips a null due date without losing its cursor", () => {
    const row = { rank: "a0", priority: "HIGH", dueDate: null, createdAt: new Date(), updatedAt: new Date(), cursorCreatedAt: timestamp, cursorUpdatedAt: timestamp };
    const sortValue = serializeSortValue(row, "dueDate");
    expect(decodeCursor(encodeCursor({ sortValue, id: "42" }))).toEqual({ sortValue, id: "42" });
  });

  it.each([buildCursorPredicate, buildMineCursorPredicate])("aligns nullable date boundaries with PostgreSQL default null ordering", (predicate) => {
    const nullPosition = { sortValue: "__null__", id: "42" };
    const ascNull = dialect.sqlToQuery(predicate("dueDate", "asc", nullPosition));
    const descNull = dialect.sqlToQuery(predicate("dueDate", "desc", nullPosition));
    const ascValue = dialect.sqlToQuery(predicate("dueDate", "asc", { sortValue: "2026-09-09", id: "42" }));
    expect(ascNull.sql).toMatch(/IS NULL/);
    expect(ascNull.params).toEqual([42]);
    expect(descNull.sql).toMatch(/IS NOT NULL/);
    expect(descNull.sql).toMatch(/IS NULL/);
    expect(ascValue.sql).toMatch(/IS NULL/);
  });
});
