import { Injectable } from "@nestjs/common";
import { logger } from "../../common/logger/logger.service";
import { dispatchEmail, getEmailProvider } from "../email/email.provider";

export interface AutomationEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

@Injectable()
export class AutomationEmailService {
  async send(options: AutomationEmailOptions): Promise<void> {
    if (getEmailProvider() === "none") {
      logger.warn("automation.email skipped: no provider configured", {
        subject: options.subject,
        hint: "Set EMAIL_PROVIDER + ZEPTOMAIL_SMTP_PASS (or RESEND_API_KEY) in .env",
      });
      return;
    }
    await dispatchEmail(options);
  }
}
