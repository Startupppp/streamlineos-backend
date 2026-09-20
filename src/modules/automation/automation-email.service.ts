import { Inject, Injectable } from "@nestjs/common";
import { logger } from "../../common/logger/logger.service";
import { EmailProviderService } from "../email/email.provider";
import { EmailOutboxService } from "../email/email-outbox.service";

export interface AutomationEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  /**
   * Passed straight to the provider. `EmailOptions.headers` already exists for
   * RFC 8058 `List-Unsubscribe`, and this interface was the one link in the
   * chain that dropped it, so a CRM marketing send could not offer an opt-out
   * a mail client would show natively.
   */
  headers?: Record<string, string>;
}

@Injectable()
export class AutomationEmailService {
  constructor(
    @Inject(EmailProviderService)
    private readonly emailProvider: Pick<EmailProviderService, "getEmailProvider">,
    @Inject(EmailOutboxService)
    private readonly outbox: Pick<EmailOutboxService, "enqueueAndTry">,
  ) {}

  async send(options: AutomationEmailOptions): Promise<void> {
    if (this.emailProvider.getEmailProvider() === "none") {
      logger.warn("automation.email skipped: no provider configured", {
        subject: options.subject,
        hint: "Set EMAIL_PROVIDER + ZEPTOMAIL_TOKEN (or RESEND_API_KEY) in .env",
      });
      return;
    }
    await this.outbox.enqueueAndTry(options);
  }
}
