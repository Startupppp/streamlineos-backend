import { getTableConfig } from "drizzle-orm/pg-core";
import { tickets } from "./ticket-core";

describe("ticket-64 tickets.project_id is NOT NULL", () => {
  it("walks enough columns to avoid a vacuous pass", () => {
    expect(getTableConfig(tickets).columns.length).toBeGreaterThan(20);
  });

  it("project_id column is declared NOT NULL in the schema", () => {
    const col = getTableConfig(tickets).columns.find((c) => c.name === "project_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
  });
});
