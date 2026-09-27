import { PgDialect } from "drizzle-orm/pg-core";
import { WORK_ROW_SELECTION } from "../projects-work-query-helpers";

const dialect = new PgDialect();

describe("WORK_ROW_SELECTION — assigneeId must use the already-joined column, not a correlated subquery", () => {
  it("resolves assigneeId from the already-present organization_members LEFT JOIN instead of issuing a correlated per-row SELECT", () => {
    const rendered = dialect.sqlToQuery(WORK_ROW_SELECTION.assigneeId as never);
    expect(rendered.sql.toUpperCase()).not.toContain("SELECT");
  });
});
