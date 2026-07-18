import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  StreamableFile,
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
  users,
  organizationMembers,
  organizations,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { StorageService } from "../../storage/storage.service";
import { EmailService } from "../../email/email.service";
import { AccessService } from "../../access/access.service";
import { PayrollNotificationsService } from "../insights/payroll-notifications.service";
import { logger } from "../../../common/logger/logger.service";
import { decryptBankDetails } from "../../../modules/hr-payroll/lib/encryption";
import { generatePayslipPdf } from "../../../modules/hr-payroll/lib/payslip-pdf";
import { renderPayslipHtml, buildPayslipPdfData } from "./lib/payslip-renderer";
import { getPayslipEmailTemplate } from "../../email/templates/payroll";
import type { CalculationSnapshot, PayrollToggles } from "../payroll.types";
import type { PayslipTemplateConfig } from "./dto/payout.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function computeSnapshotHash(snapshot: CalculationSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
}

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function fmtMonthYear(month: string): string {
  const [yr, mo] = month.split("-");
  const idx = parseInt(mo ?? "1") - 1;
  return `${MONTHS_LONG[idx] ?? month} ${yr ?? ""}`.trim();
}

@Injectable()
export class PublishingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly email: EmailService,
    private readonly access: AccessService,
    private readonly notifications: PayrollNotificationsService,
  ) {}

  async publish(
    orgId: string,
    runId: number,
    actorId: string,
    userIds?: string[],
  ) {
    const run = await this.db.query.payrollRuns.findFirst({
      where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
      with: { policyVersion: true },
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

    let employees = await this.db
      .select({
        id: payrollRunEmployees.id,
        userId: payrollRunEmployees.userId,
        workerType: payrollRunEmployees.workerType,
        currency: payrollRunEmployees.currency,
        calculationSnapshot: payrollRunEmployees.calculationSnapshot,
        bankDetails: users.bankDetails,
        name: users.name,
        email: users.email,
        employeeId: users.employeeId,
        designation: users.designation,
        joiningDate: users.joiningDate,
      })
      .from(payrollRunEmployees)
      .leftJoin(users, eq(payrollRunEmployees.userId, users.id))
      .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)));

    if (userIds && userIds.length > 0) {
      employees = employees.filter(e => userIds.includes(e.userId));
    }

    let published = 0;
    const total = employees.length;

    const layout = defaultTemplate?.layout ?? "CLASSIC";
    const rawTemplateConfig = defaultTemplate?.config;
    const config: PayslipTemplateConfig = rawTemplateConfig && typeof rawTemplateConfig === "object"
      ? { accent: "#0f2b7f", showEmployerContributions: false, showYtd: false, ...(rawTemplateConfig as Partial<PayslipTemplateConfig>) }
      : { accent: "#0f2b7f", showEmployerContributions: false, showYtd: false };

    for (const emp of employees) {
      if (!emp.calculationSnapshot) continue;
      const snapshot = emp.calculationSnapshot as CalculationSnapshot;
      const snapshotHash = computeSnapshotHash(snapshot);

      const bank = decryptBankDetails(emp.bankDetails ?? null);
      const maskedAccount = bank?.accountNumber ? "XXXX" + bank.accountNumber.slice(-4) : undefined;

      const pdfData = buildPayslipPdfData({
        snapshot,
        employee: {
          name: emp.name ?? emp.userId,
          employeeId: emp.employeeId ?? undefined,
          designation: emp.designation ?? undefined,
          joiningDate: emp.joiningDate ?? undefined,
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
      let renderedPdfBuffer: Buffer | null = null;
      try {
        renderedPdfBuffer = await generatePayslipPdf(pdfData);
        if (this.storage.isConfigured()) {
          const fileName = `payslip-${emp.userId}-${run.month}.pdf`;
          const uploadResult = await this.storage.uploadFile(
            renderedPdfBuffer,
            `payroll/payslips/${runId}`,
            fileName,
            "application/pdf",
          );
          pdfUrl = uploadResult.url;
        }
      } catch {
        pdfUrl = null;
        renderedPdfBuffer = null;
      }

      const [upsertedPub] = await this.db
        .insert(payslipPublications)
        .values({
          orgId,
          runId,
          runEmployeeId: emp.id,
          userId: emp.userId,
          payslipTemplateId: defaultTemplate?.id ?? null,
          pdfUrl,
          publishedAt: new Date(),
          publishedBy: actorId,
          channel: "PORTAL",
          status: "PUBLISHED",
          snapshotHash,
        })
        .onConflictDoUpdate({
          target: payslipPublications.runEmployeeId,
          set: {
            pdfUrl,
            publishedAt: new Date(),
            publishedBy: actorId,
            status: "PUBLISHED",
            snapshotHash,
            payslipTemplateId: defaultTemplate?.id ?? null,
          },
        })
        .returning({ id: payslipPublications.id });

      published++;

      if (upsertedPub) {
        this.notifications
          .notifyPayslipPublished(orgId, emp.userId, upsertedPub.id, run.month)
          .catch(e => logger.error("notifyPayslipPublished failed", { error: e }));
      }

      if (emailPayslips && emp.email && renderedPdfBuffer) {
        try {
          const monthLabel = fmtMonthYear(run.month);
          const netAmount = parseFloat(snapshot.totals.net).toLocaleString("en-IN", { minimumFractionDigits: 2 });
          const emailTemplate = getPayslipEmailTemplate({
            employeeName: emp.name ?? emp.userId,
            month: monthLabel,
            netSalary: netAmount,
            orgName,
          });
          void this.email.sendEmail({
            to: emp.email,
            subject: emailTemplate.subject,
            html: emailTemplate.html,
            attachments: [
              {
                filename: `payslip-${monthLabel.replace(" ", "-")}.pdf`,
                content: renderedPdfBuffer,
                type: "application/pdf",
              },
            ],
          });
        } catch {
        }
      }
    }

    let runStatus: (typeof payrollRuns.$inferSelect)["status"] = run.status;
    const allPublications = await this.db.query.payslipPublications.findMany({
      where: and(eq(payslipPublications.runId, runId), eq(payslipPublications.orgId, orgId)),
      columns: { status: true },
    });
    const totalEmployees = employees.length;
    const allPublished = allPublications.length >= totalEmployees &&
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
          metadata: { publishedCount: published, total: totalEmployees },
        });
      });

      this.audit.log({
        action: "payroll.payslips_published",
        userId: actorId,
        orgId,
        targetId: String(runId),
        targetType: "payroll_run",
        metadata: { publishedCount: published, total: totalEmployees },
      });

      runStatus = "PAYSLIPS_PUBLISHED";
    }

    return { published, total, runStatus };
  }

  async listPublications(orgId: string, runId: number) {
    const run = await this.db.query.payrollRuns.findFirst({
      where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
      columns: { id: true },
    });
    if (!run) throw new NotFoundException("Payroll run not found");

    return this.db.query.payslipPublications.findMany({
      where: and(eq(payslipPublications.runId, runId), eq(payslipPublications.orgId, orgId)),
      columns: {
        id: true,
        userId: true,
        runEmployeeId: true,
        status: true,
        channel: true,
        pdfUrl: true,
        publishedAt: true,
        snapshotHash: true,
      },
    });
  }

  async downloadPdf(
    publicationId: number,
    caller: CurrentUserContext,
  ): Promise<StreamableFile> {
    const publication = await this.db.query.payslipPublications.findFirst({
      where: eq(payslipPublications.id, publicationId),
      columns: {
        id: true,
        orgId: true,
        userId: true,
        runId: true,
        runEmployeeId: true,
        snapshotHash: true,
        payslipTemplateId: true,
        status: true,
      },
    });
    if (!publication) throw new NotFoundException("Payslip publication not found");

    const isOwnPayslip = publication.userId === caller.userId;

    if (!isOwnPayslip) {
      if (publication.orgId !== caller.orgId) {
        throw new ForbiddenException("Access denied");
      }
      const perms = await this.access.resolveUserPermissions(caller.orgId, caller.userId);
      const memberRow = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.userId, caller.userId),
          eq(organizationMembers.orgId, caller.orgId),
        ),
        columns: { isOwner: true },
      });
      const isOwner = memberRow?.isOwner === true;
      if (!isOwner && !caller.isPlatformAdmin && !perms.has("payroll:payslips:view")) {
        throw new ForbiddenException("Missing permission: payroll:payslips:view");
      }
    }

    const runEmployee = await this.db.query.payrollRunEmployees.findFirst({
      where: and(eq(payrollRunEmployees.id, publication.runEmployeeId), eq(payrollRunEmployees.orgId, publication.orgId)),
      columns: {
        calculationSnapshot: true,
        workerType: true,
        currency: true,
        userId: true,
      },
    });
    if (!runEmployee?.calculationSnapshot) {
      throw new ConflictException("Calculation snapshot not available for this payslip");
    }

    const snapshot = runEmployee.calculationSnapshot as CalculationSnapshot;
    const currentHash = computeSnapshotHash(snapshot);
    if (publication.snapshotHash && currentHash !== publication.snapshotHash) {
      throw new ConflictException("Published payslip snapshot has changed — contact HR to re-publish");
    }

    const run = await this.db.query.payrollRuns.findFirst({
      where: and(eq(payrollRuns.id, publication.runId), eq(payrollRuns.orgId, publication.orgId)),
      columns: { month: true, orgId: true },
    });
    if (!run) throw new NotFoundException("Payroll run not found");

    const [userRow, orgRow, templateRow] = await Promise.all([
      this.db.query.users.findFirst({
        where: eq(users.id, runEmployee.userId),
        columns: { name: true, employeeId: true, designation: true, joiningDate: true, bankDetails: true, email: true },
      }),
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, run.orgId),
        columns: { name: true, address: true },
      }),
      publication.payslipTemplateId
        ? this.db.query.payslipTemplates.findFirst({
            where: eq(payslipTemplates.id, publication.payslipTemplateId),
            columns: { layout: true, config: true },
          })
        : Promise.resolve(null),
    ]);

    const bank = decryptBankDetails(userRow?.bankDetails ?? null);
    const maskedAccount = bank?.accountNumber ? "XXXX" + bank.accountNumber.slice(-4) : undefined;
    const orgName = orgRow?.name ?? "Organization";
    const orgAddress = orgRow?.address
      ? [orgRow.address.city, orgRow.address.state, orgRow.address.country].filter(Boolean).join(", ")
      : undefined;

    const layout = templateRow?.layout ?? "CLASSIC";
    const rawConfig = templateRow?.config;
    const config: PayslipTemplateConfig = rawConfig && typeof rawConfig === "object"
      ? { accent: "#0f2b7f", showEmployerContributions: false, showYtd: false, ...(rawConfig as Partial<PayslipTemplateConfig>) }
      : { accent: "#0f2b7f", showEmployerContributions: false, showYtd: false };

    const pdfData = buildPayslipPdfData({
      snapshot,
      employee: {
        name: userRow?.name ?? runEmployee.userId,
        employeeId: userRow?.employeeId ?? undefined,
        designation: userRow?.designation ?? undefined,
        joiningDate: userRow?.joiningDate ?? undefined,
        maskedAccount,
        bankName: bank?.bankName ?? undefined,
        ifsc: bank?.ifsc ?? undefined,
        pfUan: bank?.pfUanNumber ?? undefined,
      },
      org: { name: orgName, address: orgAddress },
      workerType: runEmployee.workerType,
      month: run.month,
      layout,
      config,
    });

    const pdfBuffer = await generatePayslipPdf(pdfData);
    return new StreamableFile(pdfBuffer, {
      type: "application/pdf",
      disposition: `attachment; filename="payslip-${run.month}.pdf"`,
    });
  }
}
