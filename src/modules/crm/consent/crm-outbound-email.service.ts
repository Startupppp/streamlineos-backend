import { Injectable } from "@nestjs/common";
import {
  AutomationEmailService,
  type AutomationEmailOptions,
} from "../../automation/automation-email.service";
import { logger } from "../../../common/logger/logger.service";
import { CrmConsentService } from "./crm-consent.service";
import { buildUnsubscribeToken } from "./unsubscribe-token.util";
import type { ConsentChannel } from "./crm-consent.service";

/**
 * The ONLY way CRM automated paths may send email.
 *
 * Consent lives here rather than in each caller so a future bulk sender cannot
 * forget it, and here rather than in the shared `AutomationEmailService` because
 * that one also carries HR and platform automation mail, which CRM marketing
 * consent must not suppress.
 */
/**
 * The contact this message is addressed to, so it can carry a way out.
 *
 * Only ever ONE contact: an unsubscribe link names a person, and putting one
 * person's link in a message fanned out to five would let any of them opt the
 * first one out. `send` enforces that rather than trusting the caller.
 */
export interface CrmUnsubscribeContext {
  contactId: number;
  channel: ConsentChannel;
}

/**
 * The enrolled entity as an unsubscribe subject, when it is one.
 *
 * `entityId` arrives as a string and is not always a number -- `parseInt` on a
 * uuid yields NaN or, worse, a leading-digit prefix, so this refuses anything
 * that is not wholly digits rather than mailing a link that names contact 4.
 */
export function contactUnsubscribe(
  entityType: string,
  entityId: string,
): { contactId: number; channel: "EMAIL" } | undefined {
  if (entityType.toLowerCase() !== "contact") return undefined;
  if (!/^\d+$/.test(entityId.trim())) return undefined;
  const contactId = Number(entityId.trim());
  return contactId > 0 ? { contactId, channel: "EMAIL" } : undefined;
}

/**
 * Where a mail client must POST to honour one-click, which is this API and not
 * the web app. Absent means we offer nothing rather than a link that 404s --
 * the same rule `notification-email.provider.ts` follows, and for the same
 * reason: a failing `List-Unsubscribe` is read as a sender refusing opt-outs.
 */
function apiOrigin(): string | null {
  const raw = process.env.PUBLIC_API_URL?.trim().replace(/\/$/, "");
  return raw && raw.length > 0 ? raw : null;
}

function unsubscribeFooterHtml(url: string): string {
  return (
    `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;` +
    `font-size:12px;color:#6b7280">` +
    `Don't want these emails? <a href="${url}" style="color:#6b7280">Unsubscribe</a>.` +
    `</div>`
  );
}

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
    unsubscribe?: CrmUnsubscribeContext,
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

    await this.email.send({
      ...options,
      to: sendable,
      ...(await this.withUnsubscribe(orgId, options, unsubscribe, sendable)),
    });
    return { sent: sendable, suppressed };
  }

  /**
   * The way out, which this service could not offer at all.
   *
   * `buildUnsubscribeToken` and the public route it feeds both existed and
   * NOTHING MINTED A TOKEN -- verified across the whole repository, where the
   * only callers were the two specs. So every CRM automation and sequence email
   * went out with no opt-out of any kind while the endpoint that would have
   * honoured one sat waiting for a token nobody issued. `suppressedEmails`
   * above enforces a decision the recipient had no way to make.
   *
   * Both halves, because they serve different readers: the header is what a
   * mail client turns into a native Unsubscribe control, and the footer is what
   * a person sees when their client shows none.
   */
  private async withUnsubscribe(
    orgId: string,
    options: AutomationEmailOptions,
    unsubscribe: CrmUnsubscribeContext | undefined,
    sendable: readonly string[],
  ): Promise<Partial<AutomationEmailOptions>> {
    if (!unsubscribe) return {};

    /*
      One contact, one recipient. The token names a person, so fanning this
      message out would hand every recipient the power to opt that one person
      out. Dropping the link is the safe direction: the message still goes.
    */
    const only = sendable.length === 1 ? sendable[0] : undefined;
    if (only === undefined) {
      logger.warn("crm.outbound.unsubscribe-skipped-multi-recipient", {
        contactId: unsubscribe.contactId,
        sendableCount: sendable.length,
      });
      return {};
    }

    /*
      And that the recipient IS the contact. A convention the caller was trusted
      to keep is not a guarantee; this makes the unsafe state unrepresentable
      instead of documenting it. A sequence whose `to` was configured to some
      other address gets no link rather than a link that opts out a third party.
    */
    const contactEmail = await this.consent.contactEmail(orgId, unsubscribe.contactId);
    if (!contactEmail || contactEmail.toLowerCase() !== only.trim().toLowerCase()) {
      logger.warn("crm.outbound.unsubscribe-skipped-recipient-mismatch", {
        contactId: unsubscribe.contactId,
        hasContactEmail: contactEmail !== null,
      });
      return {};
    }

    const origin = apiOrigin();
    if (!origin) {
      logger.warn("crm.outbound.unsubscribe-unconfigured", {
        contactId: unsubscribe.contactId,
        hint: "Set PUBLIC_API_URL so marketing mail can carry a working opt-out.",
      });
      return {};
    }

    const token = buildUnsubscribeToken({
      orgId,
      contactId: unsubscribe.contactId,
      channel: unsubscribe.channel,
    });
    const url = `${origin}/crm/consent/unsubscribe/${token}`;

    return {
      html: `${options.html}${unsubscribeFooterHtml(url)}`,
      ...(options.text === undefined
        ? {}
        : { text: `${options.text}\n\nUnsubscribe: ${url}` }),
      headers: {
        ...options.headers,
        "List-Unsubscribe": `<${url}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    };
  }
}
