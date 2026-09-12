import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { crmContactChannelConsent } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  ConsentChannel,
  ConsentDecision,
  ConsentRecordInput,
} from "./lib/crm-consent.types";
import { readSuppressedEmails, writeErasureSuppression } from "./lib/crm-consent-suppression";
import { recordConsentChange } from "./lib/crm-consent-record";
import {
  countContactsMissingConsent,
  readConsentEvents,
  readConsentForContact,
  readContactEmail,
} from "./lib/crm-consent-reads";
import { logger } from "../../../common/logger/logger.service";

export type {
  ConsentChannel,
  ConsentStatus,
  ConsentSource,
  LegalBasis,
  ConsentDecision,
} from "./lib/crm-consent.types";

/**
 * The single authority on whether the org may contact someone on a channel.
 *
 * Every CRM outbound path must resolve through `filterSendable` — a suppressed
 * contact is dropped here rather than in each caller, so a future bulk send
 * cannot forget the check. `assertSendable` is the strict form for single sends.
 */
@Injectable()
export class CrmConsentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // The suppression-hash reader and writer, the `record` transaction and the
  // read-only projections live in `lib/` and take this service's handle. The
  // send gate itself, `filterSendable` and `assertSendable`, stays here.

  /**
   * Suppression is authoritative: an explicit OPTED_OUT, or an OPTED_IN whose
   * `expiresAt` has passed, blocks the send. UNKNOWN does not block — the org's
   * legal basis may be contract or legitimate interest — but it is reported so
   * callers can surface it.
   */
  async filterSendable(
    orgId: string,
    channel: ConsentChannel,
    contactIds: readonly number[],
  ): Promise<{ sendable: number[]; blocked: ConsentDecision[] }> {
    if (contactIds.length === 0) return { sendable: [], blocked: [] };

    const unique = [...new Set(contactIds)];
    const rows = await this.db
      .select({
        contactId: crmContactChannelConsent.contactId,
        status: crmContactChannelConsent.status,
        expiresAt: crmContactChannelConsent.expiresAt,
      })
      .from(crmContactChannelConsent)
      .where(
        and(
          eq(crmContactChannelConsent.orgId, orgId),
          eq(crmContactChannelConsent.channel, channel),
          inArray(crmContactChannelConsent.contactId, unique),
        ),
      );

    const byContact = new Map(rows.map((row) => [row.contactId, row]));
    const now = Date.now();
    const sendable: number[] = [];
    const blocked: ConsentDecision[] = [];

    for (const contactId of unique) {
      const record = byContact.get(contactId);
      if (!record) {
        sendable.push(contactId);
        continue;
      }
      if (record.status === "OPTED_OUT") {
        blocked.push({ contactId, allowed: false, reason: "opted_out" });
        continue;
      }
      if (record.expiresAt && record.expiresAt.getTime() <= now) {
        blocked.push({ contactId, allowed: false, reason: "expired" });
        continue;
      }
      sendable.push(contactId);
    }

    return { sendable, blocked };
  }

  async assertSendable(
    orgId: string,
    channel: ConsentChannel,
    contactId: number,
  ): Promise<void> {
    const { blocked } = await this.filterSendable(orgId, channel, [contactId]);
    const decision = blocked[0];
    if (!decision) return;
    throw new ForbiddenException(
      decision.reason === "expired"
        ? `Consent to contact this person by ${channel} has expired`
        : `This person has opted out of ${channel}`,
    );
  }

  /**
   * Suppression by email address, for paths that hold an address but no contact
   * id (inbound unsubscribe links, imports, bulk pastes).
   */
  async suppressedEmails(
    orgId: string,
    emails: readonly string[],
  ): Promise<Set<string>> {
    return readSuppressedEmails(this.db, orgId, emails);
  }

  /**
   * Records the opt-out in a form that survives erasure of the contact itself.
   * Call this BEFORE hard-deleting a contact under a DPDP/GDPR request —
   * afterwards the consent rows are gone and the address is unrecoverable.
   */
  async retainSuppressionOnErasure(
    orgId: string,
    address: string,
    channel: ConsentChannel,
    reason: string,
  ): Promise<void> {
    await writeErasureSuppression(this.db, orgId, address, channel, reason);
  }

  /**
   * One channel's new position for one contact, recorded with its event, its
   * erasure-surviving suppression copy (an EMAIL opt-out) and its audit entry
   * in one tenant transaction. The body, and why each part is there, is
   * `recordConsentChange` in `lib/crm-consent-record.ts`.
   */
  async record(orgId: string, input: ConsentRecordInput): Promise<void> {
    await recordConsentChange(this.db, this.audit, orgId, input);
  }

  /**
   * The opt-out a signed unsubscribe link carries, for the public routes.
   *
   * A token naming a contact outside its own organisation (or one that no
   * longer resolves) writes nothing and is answered like every other token, so
   * the public endpoint is not an oracle for whether a contact exists. The
   * refusal is still logged, because a signed token that resolves nowhere is
   * worth being able to see.
   */
  async recordUnsubscribe(input: {
    orgId: string;
    contactId: number;
    channel: ConsentChannel;
  }): Promise<void> {
    try {
      await this.record(input.orgId, {
        contactId: input.contactId,
        channel: input.channel,
        status: "OPTED_OUT",
        source: "UNSUBSCRIBE_LINK",
        legalBasis: "CONSENT",
        recordedByUserId: null,
      });
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      logger.warn("crm.consent.unsubscribe.unresolved", {
        orgId: input.orgId,
        contactId: input.contactId,
        channel: input.channel,
        outcome: "answered 200 without recording",
        reason:
          "signed token names a contact that is absent, soft-deleted, or not in the signed org",
      });
    }
  }

  /**
   * The evidence trail, which was being written and read by nothing.
   *
   * `record()` appends a row here on every change, carrying `fromStatus` ->
   * `toStatus`, the basis claimed and who claimed it. Nothing in the codebase
   * read that table: no service method, no route. So the product recorded
   * exactly what a DPDP or GDPR review asks for — what changed, when, on what
   * basis, at whose hand — and had no way to produce it.
   *
   * Separate from `listForContact` because they answer different questions.
   * That one returns the CURRENT position, at most one row per channel, because
   * `uniq_crm_consent_org_contact_channel` allows only one and `record()`
   * upserts. This one is the history, and only this one can answer "when did
   * they opt out".
   *
   * Projected rather than `select()`, per §1: `orgId` and `contactPartyId` are
   * ours and not the caller's, and a raw row hands back both.
   */
  async listConsentEvents(orgId: string, contactId: number, limit: number) {
    return readConsentEvents(this.db, orgId, contactId, limit);
  }

  /**
   * Current position per channel — at most one row each, because
   * `uniq_crm_consent_org_contact_channel` allows only one and `record()`
   * upserts. For the history, see `listConsentEvents`.
   */
  async listForContact(orgId: string, contactId: number) {
    return readConsentForContact(this.db, orgId, contactId);
  }

  /**
   * The address a contact is reachable at, so an unsubscribe link can be checked
   * against the person it is about to be sent to.
   *
   * An unsubscribe token names a contact. Putting one in a message that went to
   * somebody else would hand that somebody the power to opt this contact out, so
   * the sender verifies rather than assuming its `to` is the enrolled contact's
   * address. Returns null when there is no party, no address, or the contact
   * belongs to another organisation -- every one of which means "do not attach
   * a link", which is the safe answer for all three.
   */
  async contactEmail(orgId: string, contactId: number): Promise<string | null> {
    return readContactEmail(this.db, orgId, contactId);
  }

  /** Contacts with no consent row at all for a channel, for data-quality surfacing. */
  async countMissingConsent(orgId: string, channel: ConsentChannel): Promise<number> {
    return countContactsMissingConsent(this.db, orgId, channel);
  }
}
