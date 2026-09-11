import type { ReportResult } from "./reporting.service";

/**
 * A report result as an email a person can read.
 *
 * Pure, and its own module, because the two things that go wrong here are both
 * decidable without a database: a tenant's own data escaping into the HTML, and
 * a report that returned a thousand rows becoming a message no provider will
 * accept and no recipient will read.
 */

/**
 * Rows shown in the body.
 *
 * The rest are counted, not dropped silently. A mail that shows the first
 * fifty rows of two hundred and says so is useful; one that shows fifty and
 * implies that is all of them is worse than sending nothing, because the
 * recipient acts on a number that is wrong.
 */
export const DELIVERED_ROW_LIMIT = 50;

/**
 * The five characters that turn a cell into markup.
 *
 * Every value in a report result came from a tenant's own records — a company
 * named `<script>` is a support ticket, not an attack, right up until it is
 * rendered into a mail somebody's client executes.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A cell as text.
 *
 * `null` is rendered as an em dash rather than as the string "null", which is a
 * value some column could legitimately hold; dates go to ISO, because a locale
 * guessed in a background job is a worse answer than an unambiguous one.
 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export interface RenderedReport {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export function renderReportEmail(input: {
  reportName: string;
  result: ReportResult;
  /** Labels for the generated `c0`, `c1`, … aliases the rows carry. */
  headers: readonly string[];
  ranAt: Date;
}): RenderedReport {
  const { reportName, result, headers, ranAt } = input;
  const shown = result.rows.slice(0, DELIVERED_ROW_LIMIT);
  const hidden = result.rowCount - shown.length;

  /**
   * Two different truths, and both are stated. `truncated` means the query
   * itself hit its limit, so there may be rows this report never saw; `hidden`
   * means the mail is showing fewer than it read. Collapsing them would let a
   * recipient read "50 of 200" and believe 200 was the total.
   */
  const notes: string[] = [];
  if (hidden > 0)
    notes.push(`Showing the first ${shown.length} of ${result.rowCount} rows returned.`);
  if (result.truncated)
    notes.push(
      "The report reached its row limit, so these numbers are a floor rather than a total.",
    );

  const headerCells = headers.map((header) => `<th align="left">${escapeHtml(header)}</th>`);
  const bodyRows = shown.map((row) => {
    const cells = result.columns.map(
      (column) => `<td>${escapeHtml(cellText(row[column.alias]))}</td>`,
    );
    return `<tr>${cells.join("")}</tr>`;
  });

  const html = [
    `<p>${escapeHtml(reportName)} — run ${escapeHtml(ranAt.toISOString())}</p>`,
    ...notes.map((note) => `<p>${escapeHtml(note)}</p>`),
    shown.length === 0
      ? "<p>This report returned no rows.</p>"
      : `<table cellpadding="6" cellspacing="0" border="1"><thead><tr>${headerCells.join(
          "",
        )}</tr></thead><tbody>${bodyRows.join("")}</tbody></table>`,
  ].join("\n");

  const textRows = shown.map((row) =>
    result.columns.map((column) => cellText(row[column.alias])).join("\t"),
  );
  const text = [
    `${reportName} — run ${ranAt.toISOString()}`,
    ...notes,
    "",
    headers.join("\t"),
    ...textRows,
  ].join("\n");

  return { subject: `${reportName} — ${result.rowCount} rows`, html, text };
}
