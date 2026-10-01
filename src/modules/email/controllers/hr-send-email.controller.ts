import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { AuditService } from "../../../common/audit/audit.service";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { hrSendEmailResponseSchema } from "../dto/email-response.schemas";
import { sendEmailSchema, type SendEmailInput } from "../dto/email.schemas";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { candidates, emailTemplates } from "../../../db/schema";
import { EmailService } from "../email.service";
import { EmailProviderService } from "../email.provider";
import { escapeHtml } from "../templates/base";

function replaceVariables(
  text: string,
  vars: Record<string, string>,
  encode: (value: string) => string = (value) => value,
): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, encode(value));
  }
  return result;
}

@Controller("hr/integrations/send-email")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrSendEmailController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly emailService: EmailService,
    private readonly emailProvider: EmailProviderService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(200)
  @ResponseSchema(hrSendEmailResponseSchema)
  @RequirePermission("hr:communications:send")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("hr:communications-send")
  @Validate({ body: sendEmailSchema })
  async send(
    @Body() body: SendEmailInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (this.emailProvider.getEmailProvider() === "none")
      throw new BadRequestException(
        "Email not configured. Set ZEPTOMAIL_TOKEN or RESEND_API_KEY.",
      );

    let subject = body.subject;
    let emailBody = body.body;

    if (body.templateId !== undefined) {
      const template = await this.db.query.emailTemplates.findFirst({
        where: and(
          eq(emailTemplates.id, body.templateId),
          eq(emailTemplates.orgId, u.orgId),
        ),
      });
      if (template) {
        subject = template.subject;
        emailBody = template.body;
      }
    }

    if (body.candidateId !== undefined) {
      const candidate = await this.db.query.candidates.findFirst({
        where: and(
          eq(candidates.id, body.candidateId),
          eq(candidates.orgId, u.orgId),
        ),
      });
      if (candidate) {
        const autoVars: Record<string, string> = {
          candidateName: `${candidate.firstName} ${candidate.lastName}`,
          candidateEmail: candidate.email,
          candidateFirstName: candidate.firstName,
          candidateLastName: candidate.lastName,
        };
        const vars = { ...autoVars, ...(body.variables ?? {}) };
        subject = replaceVariables(subject, vars);
        // Candidate names arrive from the public careers form; in an HTML body they are text.
        emailBody = replaceVariables(emailBody, vars, escapeHtml);
      }
    } else if (body.variables) {
      subject = replaceVariables(subject, body.variables);
      emailBody = replaceVariables(emailBody, body.variables, escapeHtml);
    }

    await this.emailService.sendEmail({
      to: body.to,
      subject,
      html: emailBody,
    });

    this.audit.log({
      action: "hr.communications.send",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "email",
      resourceId: body.to,
      metadata: {
        subject,
        templateId: body.templateId ?? null,
        candidateId: body.candidateId ?? null,
      },
    });

    return { sent: true, to: body.to, subject };
  }
}
