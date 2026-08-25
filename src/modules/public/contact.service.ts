import { randomUUID } from "node:crypto";
import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { z } from "zod";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { TurnstileService } from "../../common/security/turnstile.service";
import { EmailService } from "../email/email.service";
import { getContactAdminNotificationEmail } from "../email/templates";
import type { ContactSubmitInput } from "./dto/public.schemas";

const notificationEmailSchema = z.string().trim().email();

@Injectable()
export class ContactService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly email: EmailService,
    private readonly turnstile: TurnstileService,
  ) {}

  async submit(
    input: ContactSubmitInput,
    clientIp: string | undefined,
  ): Promise<{ ok: true }> {
    await this.turnstile.verify(input.cfTurnstileToken, clientIp);

    const recipient = this.getNotificationEmail();
    const reference = randomUUID().slice(0, 8).toUpperCase();
    const receivedAt = new Date().toISOString();
    const message = getContactAdminNotificationEmail({
      name: input.name,
      email: input.email,
      company: input.company || undefined,
      phone: input.phone || undefined,
      topic: input.topic,
      message: input.message,
      reference,
      receivedAt,
    });

    await this.email.sendEmail({
      to: recipient,
      replyTo: input.email,
      subject: message.subject,
      html: message.html,
    });

    return { ok: true };
  }

  private getNotificationEmail(): string {
    const configured = this.config.CONTACT_NOTIFICATION_EMAIL;
    const parsed = notificationEmailSchema.safeParse(configured);
    if (!parsed.success) {
      throw new ServiceUnavailableException(
        "Contact form delivery is not configured",
      );
    }
    return parsed.data;
  }
}
