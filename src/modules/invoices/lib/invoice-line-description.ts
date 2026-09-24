import type { InvoiceableTimesheetEntry } from "../../timesheets/core/timesheet-invoicing.service";
import type { InvoiceLineDetail } from "../../timesheets/core/invoice-line-detail";

const UNNAMED_WORK_LABEL = "Time";

export function invoiceLineDescription(
  entry: Pick<
    InvoiceableTimesheetEntry,
    "projectName" | "date" | "hours" | "description"
  >,
  detail: InvoiceLineDetail,
): string {
  const label = entry.projectName ?? UNNAMED_WORK_LABEL;

  if (detail === "raw") {
    const note = entry.description ? ` — ${entry.description}` : "";
    return `${label} · ${entry.date}${note}`;
  }

  const hours = Number.parseFloat(entry.hours);
  const billed = Number.isFinite(hours) ? hours.toFixed(2) : entry.hours;
  return `${label} · ${entry.date} · ${billed} h billed`;
}
