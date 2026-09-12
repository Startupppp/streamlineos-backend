import { DELIVERED_ROW_LIMIT, renderReportEmail } from "./report-delivery-render";
import type { ReportResult } from "./reporting.service";

/**
 * CRM-P2-08. Two things go wrong when a report becomes an email, and both are
 * decidable without a database: a tenant's own data escaping into the markup,
 * and a large result becoming a message nobody can read.
 */

const RAN_AT = new Date("2026-09-09T06:00:00.000Z");

function result(rows: Record<string, unknown>[], over: Partial<ReportResult> = {}): ReportResult {
  return {
    columns: [
      { alias: "c0", projection: { kind: "field", field: "name" }, type: "text" },
      { alias: "c1", projection: { kind: "aggregate", aggregate: "count" }, type: "number" },
    ],
    rows,
    rowCount: rows.length,
    truncated: false,
    ...over,
  } as ReportResult;
}

describe("renderReportEmail", () => {
  it("escapes tenant data rather than rendering it as markup", () => {
    /**
     * A company named `<script>` is a support ticket, not an attack — right up
     * until it reaches a mail client that executes it.
     */
    const rendered = renderReportEmail({
      reportName: "Pipeline <b>by owner</b>",
      headers: ["Name", "Count"],
      ranAt: RAN_AT,
      result: result([{ c0: "<script>alert(1)</script>", c1: 3 }]),
    });

    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("Pipeline &lt;b&gt;by owner&lt;/b&gt;");
  });

  it("says how many rows it is not showing", () => {
    const rows = Array.from({ length: DELIVERED_ROW_LIMIT + 12 }, (_, i) => ({
      c0: `row ${i}`,
      c1: i,
    }));
    const rendered = renderReportEmail({
      reportName: "Big report",
      headers: ["Name", "Count"],
      ranAt: RAN_AT,
      result: result(rows),
    });

    expect(rendered.text).toContain(`Showing the first ${DELIVERED_ROW_LIMIT} of 62 rows`);
    expect(rendered.html).not.toContain("row 61");
    expect(rendered.html).toContain("row 0");
  });

  it("keeps a truncated query separate from a truncated mail", () => {
    /**
     * Two different truths. `truncated` means the query hit its own limit, so
     * there may be rows the report never saw; the row cap means the mail shows
     * fewer than it read. Collapsing them lets a recipient read "50 of 200" and
     * believe 200 was the total.
     */
    const rendered = renderReportEmail({
      reportName: "Capped",
      headers: ["Name", "Count"],
      ranAt: RAN_AT,
      result: result([{ c0: "one", c1: 1 }], { truncated: true }),
    });

    expect(rendered.text).toContain("a floor rather than a total");
    expect(rendered.text).not.toContain("Showing the first");
  });

  it("renders an empty report as empty, not as a broken table", () => {
    const rendered = renderReportEmail({
      reportName: "Nothing",
      headers: ["Name", "Count"],
      ranAt: RAN_AT,
      result: result([]),
    });

    expect(rendered.html).toContain("returned no rows");
    expect(rendered.html).not.toContain("<table");
    expect(rendered.subject).toContain("0 rows");
  });

  it("distinguishes a null cell from the string 'null'", () => {
    /** "null" is a value a text column can legitimately hold. */
    const rendered = renderReportEmail({
      reportName: "Nulls",
      headers: ["Name", "Count"],
      ranAt: RAN_AT,
      result: result([
        { c0: null, c1: 1 },
        { c0: "null", c1: 2 },
      ]),
    });

    expect(rendered.text).toContain("—\t1");
    expect(rendered.text).toContain("null\t2");
  });
});
