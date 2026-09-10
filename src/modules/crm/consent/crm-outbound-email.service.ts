import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
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

/** Trailing slash off, empty treated as absent. */
function origin(raw: string | undefined): string | null {
  const trimmed = raw?.trim().replace(/\/$/, "");
  return trimmed && trimmed.length > 0 ? trimmed : null;
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
    /**
     * Injected rather than read from `process.env` at call time.
     *
     * Both origins used to come from module-level `process.env` helpers, which
     * `no-restricted-syntax` bans for a reason this file demonstrates: the
     * value is then read on every send, from a source no test can set through
     * the constructor and no boot-time validation covers. `APP_URL` is
     * `.required()` in `env.validation.ts`, so through this token it is a
     * string; through `process.env` it was `string | undefined` and the code
     * had to invent a fallback for a case that cannot happen.
     */
    @Inject(APP_CONFIG)
    private readonly config: Pick<AppConfig, "APP_URL" | "PUBLIC_API_URL">,
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

    const token = buildUnsubscribeToken({
      orgId,
      contactId: unsubscribe.contactId,
      channel: unsubscribe.channel,
    });

    /*
      Two URLs for two readers, carrying the same token.

      The footer is what a person clicks, so it goes to a page that can say what
      happened. The header is what a mail client POSTs under RFC 8058, so it
      must reach a route on this API — and it is omitted entirely when
      `PUBLIC_API_URL` is unset, because a `List-Unsubscribe` that fails is read
      as a sender refusing opt-outs. The footer does not depend on that variable
      and is never dropped: a message a person cannot opt out of is worse than a
      message with no native Unsubscribe button.
    */
    /*
      `APP_URL` is required by env validation, so the person's link always
      exists. `PUBLIC_API_URL` is optional, so the mail client's may not.
    */
    const pageUrl = `${origin(this.config.APP_URL) ?? ""}/unsubscribe/${token}`;
    const apiUrl = origin(this.config.PUBLIC_API_URL);
    if (!apiUrl) {
      logger.warn("crm.outbound.unsubscribe-header-omitted", {
        contactId: unsubscribe.contactId,
        hint: "Set PUBLIC_API_URL to add RFC 8058 one-click headers; the footer link works regardless.",
      });
    }
    const oneClickUrl = apiUrl ? `${apiUrl}/crm/consent/unsubscribe/${token}` : null;

    return {
      html: `${options.html}${unsubscribeFooterHtml(pageUrl)}`,
      ...(options.text === undefined
        ? {}
        : { text: `${options.text}\n\nUnsubscribe: ${pageUrl}` }),
      ...(oneClickUrl === null
        ? {}
        : {
            headers: {
              ...options.headers,
              "List-Unsubscribe": `<${oneClickUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          }),
    };
  }
}
