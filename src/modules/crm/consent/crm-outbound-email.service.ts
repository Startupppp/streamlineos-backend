import { Injectable } from "@nestjs/common";
import {
  AutomationEmailService,
  type AutomationEmailOptions,
} from "../../automation/automation-email.service";
import { logger } from "../../../common/logger/logger.service";
import { CrmConsentService } from "./crm-consent.service";

/**
 * The ONLY way CRM automated paths may send email.
 *
 * Consent lives here rather than in each caller so a future bulk sender cannot
 * forget it, and here rather than in the shared `AutomationEmailService` because
 * that one also carries HR and platform automation mail, which CRM marketing
 * consent must not suppress.
 */
@Injectable()
export class CrmOutboundEmailService {
  constructor(
    private readonly email: AutomationEmailService,
    private readonly consent: CrmConsentService,
  ) {}

  /**
   * Drops suppressed recipients and sends to the rest. Returns what was sent and
   * what was withheld so callers can log it against the sequence or automation
   * run. A send to a wholly-suppressed audience is a no-op, never an error.
   */
  async send(
    orgId: string,
    options: AutomationEmailOptions,
  ): Promise<{ sent: string[]; suppressed: string[] }> {
    const recipients = (Array.isArray(options.to) ? options.to : [options.to])
      .map((address) => address.trim())
      .filter(Boolean);

    if (recipients.length === 0) return { sent: [], suppressed: [] };

    const suppressedSet = await this.consent.suppressedEmails(orgId, recipients);
    const sendable = recipients.filter(
      (address) => !suppressedSet.has(address.toLowerCase()),
    );
    const suppressed = recipients.filter((address) =>
      suppressedSet.has(address.toLowerCase()),
    );

    if (suppressed.length > 0) {
      logger.warn("crm.outbound.suppressed", {
        orgId,
        suppressedCount: suppressed.length,
        subject: options.subject,
      });
    }

    if (sendable.length === 0) return { sent: [], suppressed };

    await this.email.send({ ...options, to: sendable });
    return { sent: sendable, suppressed };
  }
}
