import { exportColumnsOf } from "./hr-export-columns";
import { toCsv } from "../../inventory/import-export/csv.util";

/**
 * HRMS-E2E-013c / 017a. An export with no rows used to serialize to the empty
 * string, which the browser saved as a 0-byte file indistinguishable from a
 * successful download. These assertions fail if the header goes back to being
 * read off the first row.
 */
describe("HR CSV export headers", () => {
  it("names every column of the exported table, with no rows to read them from", () => {
    const columns = exportColumnsOf("assets");
    expect(columns).toContain("serialNumber");
    expect(columns).toContain("orgId");
    expect(columns.length).toBeGreaterThan(5);
  });

  it("produces a header-only file rather than an empty one", () => {
    const csv = toCsv(exportColumnsOf("attendance"), []);
    expect(csv.length).toBeGreaterThan(0);
    expect(csv.split("\n")[0]).toContain("date");
  });

  it.each(["assets", "attendance", "leave_balances", "document_metadata"] as const)(
    "has columns for %s",
    (entity) => {
      expect(exportColumnsOf(entity).length).toBeGreaterThan(0);
    },
  );

  it("returns nothing for employees, which exports through its own job route", () => {
    expect(exportColumnsOf("employees")).toEqual([]);
  });
});
