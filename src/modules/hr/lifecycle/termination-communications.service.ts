import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { AuditService } from "../../../common/audit/audit.service";
import { formatDdMmmYyyy } from "../../../common/date";
import { resolveCompatibleList } from "../../../common/db/expand-contract-compat";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { organizations, terminations, users } from "../../../db/schema";
import { EmailService } from "../../email/email.service";
import { getTerminationEmailTemplate } from "../../email/templates/hr";
import { loadTerminationRelationalCollections } from "./termination-relational-compat";

@Injectable()
export class TerminationCommunicationsService {
  private readonly logger = new Logger(TerminationCommunicationsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  async getLetter(orgId: string, terminationId: number) {
    const termination = await this.db.query.terminations.findFirst({
      where: and(eq(terminations.id, terminationId), eq(terminations.orgId, orgId)),
      with: { user: { columns: { id: true, name: true, designation: true } } },
    });
    if (!termination) throw new NotFoundException("Termination not found.");

    const [org] = await this.db
      .select({ name: organizations.name, supportEmail: organizations.supportEmail })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    const employee = termination.user;
    const employeeName = employee?.name ?? "Employee";
    const companyName = org?.name ?? "the Company";
    const hrEmail = org?.supportEmail ?? "";
    const reasons = await this.resolveTerminationReasons(
      orgId,
      termination.id,
      termination.reasons,
    );
    const reasonsList = reasons.map((reason) => `<li>${reason}</li>`).join("\n");
    const effectiveDate = termination.effectiveDate
      ? formatDdMmmYyyy(termination.effectiveDate)
      : "N/A";
    const severance = termination.severanceAmount;

    const letterHtml = `<div style="font-family:'Times New Roman',serif;max-width:700px;margin:0 auto;padding:40px;line-height:1.8">
  <div style="text-align:center;margin-bottom:30px;border-bottom:2px solid #333;padding-bottom:15px">
    <h2 style="margin:0">${companyName}</h2>
    <p style="margin:5px 0 0;font-size:12px;color:#666">CONFIDENTIAL</p>
  </div>
  <p style="text-align:right">Date: ${formatDdMmmYyyy(new Date())}</p>
  <p>To,<br/><strong>${employeeName}</strong><br/>${employee?.designation ?? "N/A"}<br/>${companyName}</p>
  <p><strong>Subject: Termination of Employment</strong></p>
  <p>Dear ${employeeName},</p>
  <p>This letter is to formally notify you that your employment with <strong>${companyName}</strong> is being terminated, effective <strong>${effectiveDate}</strong>.</p>
  <p><strong>Reason(s) for Termination:</strong></p>
  <ul>${reasonsList}</ul>
  ${severance ? `<p><strong>Severance:</strong> You will receive a severance payment of <strong>${companyName.includes("INR") ? "" : "INR "}${severance}</strong>, subject to applicable deductions and taxes. This amount will be included in your final settlement.</p>` : ""}
  <p><strong>Final Settlement:</strong> Your final settlement, including any pending salary, leave encashment, and other dues, will be processed within 45 days from the effective date of termination.</p>
  <p><strong>Return of Company Property:</strong> You are requested to hand over all company assets, documents, and responsibilities to <strong>Reporting Manager/HR</strong> on your last working day.</p>
  <p><strong>Confidentiality:</strong> All confidentiality and non-disclosure agreements remain in full effect even after termination.</p>
  <p>We wish you the best in your future endeavours.</p>
  <p style="margin-top:40px">Sincerely,<br/><br/><strong>Human Resources Department</strong><br/>${companyName}</p>
  ${hrEmail ? `<p style="margin-top:20px;font-size:11px;color:#999;text-align:center">For queries, please contact HR at <a href="mailto:${hrEmail}">${hrEmail}</a></p>` : ""}
</div>`;

    return { html: letterHtml };
  }

  async sendEmail(orgId: string, actorUserId: string, terminationId: number) {
    const existing = await this.db.query.terminations.findFirst({
      where: and(eq(terminations.id, terminationId), eq(terminations.orgId, orgId)),
      with: { user: { columns: { id: true, name: true, email: true, designation: true } } },
    });
    if (!existing) throw new NotFoundException("Termination not found.");
    if (existing.status !== "APPROVED") {
      throw new BadRequestException("Termination must be FINAL-approved before sending.");
    }
    if (existing.emailSentAt && existing.emailStatus === "sent") {
      throw new ConflictException("Termination email has already been sent.");
    }

    const employee = existing.user;
    if (!employee?.email) throw new BadRequestException("Employee email not found.");

    const [org] = await this.db
      .select({ supportEmail: organizations.supportEmail })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    const actor = await this.db.query.users.findFirst({
      where: eq(users.id, actorUserId),
      columns: { name: true },
    });
    const effectiveDate = existing.effectiveDate
      ? formatDdMmmYyyy(existing.effectiveDate)
      : "N/A";
    const reasons = await this.resolveTerminationReasons(
      orgId,
      existing.id,
      existing.reasons,
    );

    try {
      await this.email.sendEmail({
        to: employee.email,
        subject: "Notice of employment termination",
        html: getTerminationEmailTemplate(
          employee.name ?? "Employee",
          employee.designation ?? "N/A",
          effectiveDate,
          actor?.name ?? "HR",
          reasons.join(", "),
          org?.supportEmail ?? "",
        ),
      });

      await this.db
        .update(terminations)
        .set({ status: "SENT", emailSentAt: new Date(), emailStatus: "sent", updatedAt: new Date() })
        .where(and(eq(terminations.id, terminationId), eq(terminations.orgId, orgId)));

      await this.audit.logCritical({
        action: "TERMINATION_EMAIL_SENT",
        userId: actorUserId,
        orgId,
        targetId: String(terminationId),
        targetType: "termination",
        metadata: {
          employeeId: existing.userId,
          employeeName: employee.name,
          employeeEmail: employee.email,
          pdfAttached: false,
        },
      });
      return { success: true };
    } catch (error) {
      this.logger.error(
        "Termination email delivery failed",
        error instanceof Error ? error.stack : undefined,
      );
      await this.db
        .update(terminations)
        .set({ emailStatus: "failed", updatedAt: new Date() })
        .where(and(eq(terminations.id, terminationId), eq(terminations.orgId, orgId)));
      await this.audit.logCritical({
        action: "TERMINATION_EMAIL_FAILED",
        userId: actorUserId,
        orgId,
        targetId: String(terminationId),
        targetType: "termination",
        metadata: {
          employeeId: existing.userId,
          failureCode: "EMAIL_DELIVERY_FAILED",
        },
      });
      throw new InternalServerErrorException({
        code: "TERMINATION_EMAIL_DELIVERY_FAILED",
        message: "The termination email could not be sent. Try again later.",
      });
    }
  }

  private async resolveTerminationReasons(
    organizationId: string,
    terminationId: number,
    legacyReasons: readonly string[] | null,
  ): Promise<string[]> {
    const relationalCollections = await loadTerminationRelationalCollections(
      this.db,
      organizationId,
      [terminationId],
    );
    return resolveCompatibleList(
      legacyReasons,
      relationalCollections.reasonsByTerminationId.get(terminationId),
    );
  }
}
