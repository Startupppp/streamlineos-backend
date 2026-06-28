import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { candidates, emailTemplates } from "../../../db/schema";
import { EmailService } from "../email.service";

const sendEmailSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
  templateId: z.number().int().positive().optional(),
  candidateId: z.number().int().positive().optional(),
  variables: z.record(z.string(), z.string()).optional(),
});

type SendEmailInput = z.infer<typeof sendEmailSchema>;

function replaceVariables(text: string, vars: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

@Controller("hr/integrations/send-email")
@UseGuards(JwtAuthGuard)
export class HrSendEmailController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly emailService: EmailService,
  ) {}

  @Post()
  @HttpCode(200)
  async send(
    @Body(new ZodValidationPipe(sendEmailSchema)) body: SendEmailInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (u.role !== "CEO" && u.role !== "HR" && u.role !== "ADMIN") {
      throw new ForbiddenException("Only admins can send emails.");
    }

    const providerConfigured =
      process.env["RESEND_API_KEY"] ?? process.env["SENDGRID_API_KEY"];
    if (!providerConfigured) {
      throw new BadRequestException(
        "Email not configured. Set RESEND_API_KEY or SENDGRID_API_KEY.",
      );
    }

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
        emailBody = replaceVariables(emailBody, vars);
      }
    } else if (body.variables) {
      subject = replaceVariables(subject, body.variables);
      emailBody = replaceVariables(emailBody, body.variables);
    }

    await this.emailService.sendEmail({ to: body.to, subject, html: emailBody });

    return { sent: true, to: body.to, subject };
  }
}
