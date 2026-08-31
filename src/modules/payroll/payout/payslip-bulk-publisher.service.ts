import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { createHash } from "crypto";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollRuns,
  payrollRunEmployees,
  payslipPublications,
  payslipTemplates,
  payrollRunEvents,
  organizations,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { StorageService } from "../../storage/storage.service";
import { PayrollNotificationsService } from "../insights/payroll-notifications.service";
import { logger } from "../../../common/logger/logger.service";
import { generatePayslipPdf } from "../hr-payroll/lib/payslip-pdf";
import { buildPayslipPdfData } from "./lib/payslip-renderer";
import { getPayslipEmailTemplate } from "../../email/templates/payroll";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import {
  filterPayeesByRunEmployeeIds,
  filterPayeesBySubjectKeys,
  loadRunEmployeePayees,
} from "../lib/payroll-run-payee";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import type { CalculationSnapshot, PayrollToggles } from "../payroll.types";
import type { PayslipTemplateConfig } from "./dto/payout.schemas";

export function computeSnapshotHash(snapshot: CalculationSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
}

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function fmtMonthYear(month: string): string {
  const [yr, mo] = month.split("-");
  const idx = parseInt(mo ?? "1") - 1;
  return `${MONTHS_LONG[idx] ?? month} ${yr ?? ""}`.trim();
}

@Injectable()
export class PayslipBulkPublisherService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly notifications: PayrollNotificationsService,
    private readonly dispatch: NotificationDispatchService,
    private readonly efService: EmploymentFactsService,
  ) {}

  async publish(
    orgId: string,
    runId: number,
    actorId: string,
    subjectKeys?: string[],
    runEmployeeIds?: number[],
  ) {
    const run = await this.db.query.payrollRuns.findFirst({
      where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
      with: { policyVersion: { columns: { toggles: true } } },
    });
    if (!run) throw new NotFoundException("Payroll run not found");
    if (run.status !== "PAID") {
      throw new BadRequestException(`Cannot publish payslips for run in status ${run.status} — run must be PAID`);
    }

    const storedToggles = run.policyVersion?.toggles;
    const toggles: Partial<PayrollToggles> =
      storedToggles && typeof storedToggles === "object" ? (storedToggles as Partial<PayrollToggles>) : {};
    const emailPayslips = toggles.emailPayslips === true;

    const [defaultTemplate, org] = await Promise.all([
      this.db.query.payslipTemplates.findFirst({
        where: and(eq(payslipTemplates.orgId, orgId), eq(payslipTemplates.isDefault, true)),
      }),
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { name: true, address: true },
      }),
    ]);
    const orgName = org?.name ?? "Organization";
    const orgAddress = org?.address
      ? [org.address.city, org.address.state, org.address.country].filter(Boolean).join(", ")
      : undefined;

    let payees = await loadRunEmployeePayees(this.db, orgId, runId, this.efService);
    const totalRunEmployeeCount = payees.length;

    if (runEmployeeIds && runEmployeeIds.length > 0) {
      payees = filterPayeesByRunEmployeeIds(payees, runEmployeeIds);
    } else if (subjectKeys && subjectKeys.length > 0) {
      payees = filterPayeesBySubjectKeys(payees, subjectKeys);
    }

    const runEmployees = await this.db
      .select({
        id: payrollRunEmployees.id,
        calculationSnapshot: payrollRunEmployees.calculationSnapshot,
        workerType: payrollRunEmployees.workerType,
        currency: payrollRunEmployees.currency,
      })
      .from(payrollRunEmployees)
      .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)));

    const snapshotByRunEmployee = new Map(
      runEmployees.map((row) => [row.id, row] as const),
    );

    let published = 0;
    const total = payees.length;

    const layout = defaultTemplate?.layout ?? "CLASSIC";
    const rawTemplateConfig = defaultTemplate?.config;
    const config: PayslipTemplateConfig = rawTemplateConfig && typeof rawTemplateConfig === "object"
      ? { accent: "#0f2b7f", showEmployerContributions: false, showYtd: false, ...(rawTemplateConfig as Partial<PayslipTemplateConfig>) }
      : { accent: "#0f2b7f", showEmployerContributions: false, showYtd: false };

    const existingPubs = await this.db.query.payslipPublications.findMany({
      where: and(eq(payslipPublications.runId, runId), eq(payslipPublications.orgId, orgId)),
      columns: { runEmployeeId: true, attemptCount: true, status: true },
    });
    const attemptCountByRunEmployee = new Map(
      existingPubs.map((p) => [p.runEmployeeId, p.attemptCount] as const),
    );
    const priorStatusByRunEmployee = new Map(
      existingPubs.map((p) => [p.runEmployeeId, p.status] as const),
    );

    for (const payee of payees) {
      const emp = snapshotByRunEmployee.get(payee.runEmployeeId);
      if (!emp?.calculationSnapshot) continue;
      const snapshot = emp.calculationSnapshot as CalculationSnapshot;
      const snapshotHash = computeSnapshotHash(snapshot);

      const bank = payee.bankDetails;
      const maskedAccount = bank?.accountNumber ? "XXXX" + bank.accountNumber.slice(-4) : undefined;

      const pdfData = buildPayslipPdfData({
        snapshot,
        employee: {
          name: payee.displayName,
          employeeId: payee.employeeId ?? undefined,
          designation: payee.designation ?? undefined,
          joiningDate: payee.joiningDate ?? undefined,
          maskedAccount,
          bankName: bank?.bankName ?? undefined,
          ifsc: bank?.ifsc ?? undefined,
          pfUan: bank?.pfUanNumber ?? undefined,
        },
        org: { name: orgName, address: orgAddress },
        workerType: emp.workerType,
        month: run.month,
        layout,
        config,
      });

      let pdfUrl: string | null = null;
      let renderedPdfBuffer: Buffer | null;
      let failureReason: string | null = null;
      try {
        renderedPdfBuffer = await generatePayslipPdf(pdfData);
        if (this.storage.isConfigured()) {
          const fileName = `payslip-${payee.subjectKey}-${run.month}.pdf`;
          const uploadResult = await this.storage.uploadFile(
            orgId,
            renderedPdfBuffer,
            `payroll/payslips/${runId}`,
            fileName,
            "application/pdf",
          );
          pdfUrl = uploadResult.url;
        } else if (!renderedPdfBuffer) {
          failureReason = "PDF generation returned empty buffer";
        }
      } catch (err) {
        pdfUrl = null;
        renderedPdfBuffer = null;
        failureReason = err instanceof Error ? err.message : "PDF generation failed";
      }

      const pubStatus = failureReason ? "FAILED" : "PUBLISHED";
      const now = new Date();

      const nextAttempt = (attemptCountByRunEmployee.get(payee.runEmployeeId) ?? 0) + 1;

      const [upsertedPub] = await this.db
        .insert(payslipPublications)
        .values({
          orgId,
          runId,
          runEmployeeId: payee.runEmployeeId,
          userId: payee.subject.userId,
          workerId: payee.subject.workerId,
          payslipTemplateId: defaultTemplate?.id ?? null,
          pdfUrl,
          publishedAt: pubStatus === "PUBLISHED" ? now : null,
          publishedBy: actorId,
          channel: "PORTAL",
          status: pubStatus,
          snapshotHash,
          failureReason,
          attemptCount: nextAttempt,
          lastAttemptAt: now,
        })
        .onConflictDoUpdate({
          target: payslipPublications.runEmployeeId,
          set: {
            pdfUrl,
            publishedAt: pubStatus === "PUBLISHED" ? now : null,
            publishedBy: actorId,
            status: pubStatus,
            snapshotHash,
            payslipTemplateId: defaultTemplate?.id ?? null,
            failureReason,
            attemptCount: nextAttempt,
            lastAttemptAt: now,
            userId: payee.subject.userId,
            workerId: payee.subject.workerId,
          },
        })
        .returning({ id: payslipPublications.id });

      const wasAlreadyPublished = priorStatusByRunEmployee.get(payee.runEmployeeId) === "PUBLISHED";
      if (pubStatus === "PUBLISHED") {
        published++;
        if (upsertedPub && !wasAlreadyPublished && payee.subject.userId && emailPayslips && payee.email && renderedPdfBuffer) {
          try {
            const monthLabel = fmtMonthYear(run.month);
            const emailTemplate = getPayslipEmailTemplate({
              employeeName: payee.displayName,
              month: monthLabel,
              orgName,
            });
            await this.dispatch.emit({
              orgId,
              eventKey: "payroll.payslip.ready",
              targetUserIds: [payee.subject.userId],
              title: emailTemplate.subject,
              message: `Your payslip for ${monthLabel} is ready to download.`,
              link: "/payroll/me/payslips",
              emailHtml: emailTemplate.html,
              attachments: [{
                filename: `payslip-${monthLabel.replace(" ", "-")}.pdf`,
                contentBase64: renderedPdfBuffer.toString("base64"),
                type: "application/pdf",
              }],
              dedupeKey: `payslip-publication:${upsertedPub.id}`,
              metadata: { publicationId: upsertedPub.id, runId, month: run.month },
            });
          } catch (error) {
            logger.warn("Payslip publication email failed", {
              orgId,
              runId,
              subjectKey: payee.subjectKey,
              error,
            });
          }
        } else if (upsertedPub && !wasAlreadyPublished && payee.subject.userId) {
          await this.notifications
            .notifyPayslipPublished(orgId, payee.subject.userId, upsertedPub.id, run.month)
            .catch((e: unknown) => logger.error("notifyPayslipPublished failed", { error: e }));
        }
      } else {
        logger.error("Payslip publication failed", {
          orgId,
          runId,
          subjectKey: payee.subjectKey,
          failureReason,
        });
      }
    }

    let runStatus: (typeof payrollRuns.$inferSelect)["status"] = run.status;
    const allPublications = await this.db.query.payslipPublications.findMany({
      where: and(eq(payslipPublications.runId, runId), eq(payslipPublications.orgId, orgId)),
      columns: { status: true },
    });
    const allPublished = allPublications.length >= totalRunEmployeeCount &&
      allPublications.every(p => p.status === "PUBLISHED");

    if (allPublished) {
      const now = new Date();
      await this.db.transaction(async (tx) => {
        await tx
          .update(payrollRuns)
          .set({ status: "PAYSLIPS_PUBLISHED", publishedAt: now, publishedBy: actorId })
          .where(eq(payrollRuns.id, runId));
        await tx.insert(payrollRunEvents).values({
          orgId,
          runId,
          type: "PAYSLIPS_PUBLISHED",
          actorId,
          metadata: { publishedCount: published, total: totalRunEmployeeCount },
        });
      });

      this.audit.log({
        action: "payroll.payslips_published",
        userId: actorId,
        orgId,
        targetId: String(runId),
        targetType: "payroll_run",
        metadata: { publishedCount: published, total: totalRunEmployeeCount },
      });

      runStatus = "PAYSLIPS_PUBLISHED";
    }

    return { published, total, runStatus };
  }
}
