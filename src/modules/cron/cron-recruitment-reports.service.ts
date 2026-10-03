import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { scheduledReports } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { logger } from "../../common/logger/logger.service";
import { EmailService } from "../email/email.service";
import { HrRecruitmentReportsService } from "../hr/interviews/hr-recruitment-reports.service";

/**
 * Renders and delivers the reports the Reports screen lets a recruiter
 * schedule.
 *
 * `POST /reports/schedule` inserted a row with a name, a config, a cadence and
 * a list of recipients — and nothing ever read it. The screen offered "Weekly"
 * and "Monthly" and no report was ever sent to anybody. The row is now a
 * standing instruction that this sweep carries out, and `last_run_at` is what
 * says whether it did.
 *
 * Due is computed from `last_run_at` rather than a stored `next_run_at`,
 * because `scheduled_reports` has no such column and the HR table count is
 * frozen. A schedule that has never run is due immediately.
 */

const CADENCE_DAYS: Record<string, number> = { WEEKLY: 7, MONTHLY: 30 };
const MAX_CSV_ROWS = 1_000;
const SCHEDULE_BATCH = 100;
export const RECRUITMENT_REPORTS_RUN_BUDGET = 500;

export interface ReportDeliveryOutcome {
  delivered: number;
  failed: number;
  skippedNoRecipients: number;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows: ReadonlyArray<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0] ?? {});
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n");
}

function toHtmlTable(rows: ReadonlyArray<Record<string, unknown>>): string {
  if (rows.length === 0) return "<p>No rows matched this report.</p>";
  const headers = Object.keys(rows[0] ?? {});
  const head = headers.map((h) => `<th align="left">${h}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${headers.map((h) => `<td>${csvCell(row[h])}</td>`).join("")}</tr>`)
    .join("");
  return `<table border="1" cellpadding="6" cellspacing="0"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

@Injectable()
export class CronRecruitmentReportsService {
  private resumeAfterOrgId: string | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
    private readonly reports: HrRecruitmentReportsService,
  ) {}

  async deliverDueReports(): Promise<ReportDeliveryOutcome> {
    const outcome: ReportDeliveryOutcome = { delivered: 0, failed: 0, skippedNoRecipients: 0 };
    const budgetSpent = () => outcome.delivered + outcome.failed >= RECRUITMENT_REPORTS_RUN_BUDGET;
    let lastVisitedOrgId: string | null = null;

    await forEachOrg(this.db, "recruitment-scheduled-reports", async (tx, orgId) => {
      lastVisitedOrgId = orgId;
      const due = await tx
        .select({
          id: scheduledReports.id,
          name: scheduledReports.name,
          reportConfig: scheduledReports.reportConfig,
          schedule: scheduledReports.schedule,
          recipients: scheduledReports.recipients,
        })
        .from(scheduledReports)
        .where(
          and(
            eq(scheduledReports.orgId, orgId),
            or(
              isNull(scheduledReports.lastRunAt),
              lte(
                scheduledReports.lastRunAt,
                sql`now() - (CASE ${scheduledReports.schedule} WHEN 'MONTHLY' THEN ${CADENCE_DAYS.MONTHLY} ELSE ${CADENCE_DAYS.WEEKLY} END || ' days')::interval`,
              ),
            ),
          ),
        )
        .limit(SCHEDULE_BATCH);

      for (const schedule of due) {
        if (schedule.recipients.length === 0) {
          outcome.skippedNoRecipients += 1;
          continue;
        }
        try {
          const report = await this.reports.generateReport(orgId, schedule.reportConfig);
          const rows = report.rows.slice(0, MAX_CSV_ROWS);
          await this.email.sendEmail({
            to: schedule.recipients.join(","),
            subject: `${schedule.name} — ${report.total} row(s)`,
            html: `<p>${schedule.name}</p>${toHtmlTable(rows)}${
              report.total > rows.length
                ? `<p>Showing the first ${rows.length} of ${report.total} rows.</p>`
                : ""
            }`,
          });
          /**
           * Stamped only after the send returned. A failed delivery leaves
           * `last_run_at` alone so the next sweep retries it, rather than
           * recording a report that nobody received.
           */
          await tx
            .update(scheduledReports)
            .set({ lastRunAt: new Date() })
            .where(and(eq(scheduledReports.id, schedule.id), eq(scheduledReports.orgId, orgId)));
          outcome.delivered += 1;
        } catch (error) {
          outcome.failed += 1;
          logger.error("[recruitment-reports] scheduled report delivery failed", {
            orgId,
            scheduledReportId: schedule.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }, "write", { startAfterOrgId: this.resumeAfterOrgId, stopWhen: budgetSpent });

    this.resumeAfterOrgId = budgetSpent() ? lastVisitedOrgId : null;
    return outcome;
  }
}
