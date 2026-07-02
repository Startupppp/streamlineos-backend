import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { hashToken } from "../../common/security/token.util";
import { invitations, organizations, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "./email.service";
import { TwilioGateway } from "./dispatch/twilio.gateway";
import { TEMPLATE_MAP } from "./templates/test-catalog";
import type { DispatchInput } from "./dto/email.schemas";

export interface ChannelResult {
  channel: "email" | "sms" | "whatsapp";
  sent: boolean;
  sid?: string;
  reason?: string;
}

@Injectable()
export class EmailRoutesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
    private readonly twilio: TwilioGateway,
  ) {}

  async dispatch(input: DispatchInput): Promise<{ results: ChannelResult[]; allFailed: boolean }> {
    const results: ChannelResult[] = [];

    for (const channel of input.channels) {
      if (channel === "email") {
        if (!input.email) {
          results.push({ channel: "email", sent: false, reason: "no_email_address" });
          continue;
        }
        try {
          await this.email.sendEmail({ to: input.email, subject: input.subject, html: input.body });
          results.push({ channel: "email", sent: true });
        } catch (e) {
          results.push({
            channel: "email",
            sent: false,
            reason: e instanceof Error ? e.message : "unknown_error",
          });
        }
        continue;
      }

      if (!input.phone) {
        results.push({ channel, sent: false, reason: "no_phone_number" });
        continue;
      }

      if (channel === "whatsapp") {
        if (input.whatsappSmsFallback) {
          const result = await this.twilio.sendWhatsAppWithSmsFallback(input.phone, input.body);
          if (result.channel === "whatsapp") {
            results.push({ channel: "whatsapp", sent: true, sid: result.sid });
          } else if (result.channel === "sms") {
            results.push({ channel: "whatsapp", sent: false, reason: "fell_back_to_sms" });
            results.push({ channel: "sms", sent: true, sid: result.sid });
          } else {
            results.push({ channel: "whatsapp", sent: false, reason: "all_channels_failed" });
          }
        } else {
          const result = await this.twilio.sendWhatsApp(input.phone, input.body);
          results.push({ channel: "whatsapp", sent: result.sent, sid: result.sid, reason: result.reason });
        }
        continue;
      }

      const result = await this.twilio.sendSms(input.phone, input.body);
      results.push({ channel: "sms", sent: result.sent, sid: result.sid, reason: result.reason });
    }

    const allFailed = results.every((r) => !r.sent);
    return { results, allFailed };
  }

  async resendInvitation(orgId: string, actorUserId: string, invitationId: string): Promise<{ success: true }> {
    const invitation = await this.db.query.invitations.findFirst({
      where: and(eq(invitations.id, invitationId), eq(invitations.orgId, orgId)),
    });

    if (!invitation) throw new NotFoundException("Invitation not found");
    if (invitation.acceptedAt) throw new BadRequestException("Invitation already accepted");

    const rawToken = randomBytes(32).toString("hex");
    const newExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

    await this.db
      .update(invitations)
      .set({ token: hashToken(rawToken), expiresAt: newExpiresAt })
      .where(eq(invitations.id, invitationId));

    const [org, inviter] = await Promise.all([
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { name: true },
      }),
      this.db.query.users.findFirst({
        where: eq(users.id, actorUserId),
        columns: { name: true, firstName: true, lastName: true },
      }),
    ]);

    const inviterName =
      inviter?.firstName && inviter?.lastName
        ? `${inviter.firstName} ${inviter.lastName}`
        : inviter?.name ?? undefined;

    await this.email.sendInvitationEmail(
      invitation.email,
      rawToken,
      org?.name ?? "StreamlineOS",
      inviterName,
    );

    return { success: true };
  }

  getTemplatePreviews(): { id: string; category: string; name: string; subject: string; html: string }[] {
    return Object.entries(TEMPLATE_MAP).map(([id, entry]) => ({
      id,
      category: entry.category,
      name: entry.name,
      subject: entry.subject,
      html: entry.generateHtml(),
    }));
  }

  async sendTemplateTest(
    templateId: string,
    testEmail: string,
  ): Promise<{ sent: true; to: string; templateId: string }> {
    const entry = TEMPLATE_MAP[templateId];
    if (!entry) throw new NotFoundException(`Unknown template ID: ${templateId}`);

    let html: string;
    try {
      html = entry.generateHtml();
    } catch (e) {
      throw new InternalServerErrorException(
        `Failed to generate template: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    await this.email.sendEmail({ to: testEmail, subject: `[TEST] ${entry.subject}`, html });

    return { sent: true, to: testEmail, templateId };
  }
}
