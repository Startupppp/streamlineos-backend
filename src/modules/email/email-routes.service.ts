import { Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { EmailService } from "./email.service";
import { TwilioGateway } from "./dispatch/twilio.gateway";
import { TEMPLATE_MAP } from "./templates/registry";
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
