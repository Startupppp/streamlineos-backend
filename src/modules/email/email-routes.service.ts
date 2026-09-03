import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { EmailService } from "./email.service";
import { TwilioGateway } from "./dispatch/twilio.gateway";
import { canonicalEmail } from "./email-suppression.service";
import { TEMPLATE_MAP } from "./templates/registry";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { users } from "../../db/schema";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
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

  getTemplatePreviews(): Array<{
    id: string;
    category: string;
    name: string;
    subject: string;
    html: string;
    version: number;
    locale: string;
    supportedLocales: readonly string[];
  }> {
    return Object.entries(TEMPLATE_MAP).map(([id, entry]) => {
      const rendered = entry.render();
      return {
        id,
        category: entry.category,
        name: entry.name,
        subject: rendered.subject,
        html: rendered.html,
        version: rendered.version,
        locale: rendered.locale,
        supportedLocales: entry.supportedLocales,
      };
    });
  }

  /**
   * Sends only to the caller's own account address. The destination used to be
   * whatever the body asked for, which pointed the platform's sending identity
   * and its deliverability reputation at any address a holder of
   * settings:email-templates:manage cared to name.
   */
  async sendTemplateTest(
    actor: CurrentUserContext,
    templateId: string,
    testEmail: string,
    locale: string,
  ): Promise<{ sent: true; to: string; templateId: string; locale: string; version: number }> {
    const entry = TEMPLATE_MAP[templateId];
    if (!entry) throw new NotFoundException(`Unknown template ID: ${templateId}`);

    const account = await this.db.query.users.findFirst({
      where: eq(users.id, actor.userId),
      columns: { email: true },
    });
    if (!account || canonicalEmail(account.email) !== canonicalEmail(testEmail))
      throw new ForbiddenException(
        "A template test can only be sent to your own account email address",
      );

    let rendered: ReturnType<typeof entry.render>;
    try {
      rendered = entry.render(locale);
    } catch (e) {
      throw new InternalServerErrorException(
        `Failed to generate template: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    await this.email.sendEmail({
      to: account.email,
      subject: `[TEST] ${rendered.subject}`,
      html: rendered.html,
      organizationId: actor.orgId,
      recipientUserId: actor.userId,
    });

    return {
      sent: true,
      to: account.email,
      templateId,
      locale: rendered.locale,
      version: rendered.version,
    };
  }
}
