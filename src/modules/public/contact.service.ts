import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import { EmailService } from "../email/email.service";
import { getContactAdminNotificationEmail } from "../email/templates";
import type { ContactSubmitInput } from "./dto/public.schemas";

const turnstileResponseSchema = z.object({
  success: z.boolean(),
});

const notificationEmailSchema = z.string().trim().email();

@Injectable()
export class ContactService {
  constructor(private readonly email: EmailService) {}

  async submit(
    input: ContactSubmitInput,
    clientIp: string | undefined,
  ): Promise<{ ok: true }> {
    await this.verifyTurnstile(input.cfTurnstileToken, clientIp);

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
    const configured = process.env.CONTACT_NOTIFICATION_EMAIL;
    const parsed = notificationEmailSchema.safeParse(configured);
    if (!parsed.success) {
      throw new ServiceUnavailableException(
        "Contact form delivery is not configured",
      );
    }
    return parsed.data;
  }

  private async verifyTurnstile(
    token: string | undefined,
    clientIp: string | undefined,
  ): Promise<void> {
    const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
    if (!secret) return;
    if (!token) {
      throw new BadRequestException("Bot verification is required");
    }

    const body = new URLSearchParams({
      secret,
      response: token,
    });
    if (clientIp) body.set("remoteip", clientIp);

    let response: Response;
    try {
      response = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          body,
          signal: AbortSignal.timeout(5000),
        },
      );
    } catch {
      throw new ServiceUnavailableException(
        "Bot verification is temporarily unavailable",
      );
    }

    if (!response.ok) {
      throw new ServiceUnavailableException(
        "Bot verification is temporarily unavailable",
      );
    }

    const parsed = turnstileResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ServiceUnavailableException(
        "Bot verification is temporarily unavailable",
      );
    }
    if (!parsed.data.success) {
      throw new BadRequestException("Bot verification failed");
    }
  }
}
