import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  crmContactChannelConsent,
  crmContactConsentEvents,
  crmSuppressionHashes,
} from "../../../db/schema";
import { businessParties, contactPartyMap } from "../../../db/schema/party";
import { PARTY_OF_CONTACT } from "../crm-party-reads";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { AuditService } from "../../../common/audit/audit.service";

/** Salted-free SHA-256 of the normalised address — never store the address. */
function hashAddress(normalisedAddress: string): string {
  return createHash("sha256").update(normalisedAddress).digest("hex");
}

export type ConsentChannel = "EMAIL" | "SMS" | "WHATSAPP" | "PHONE" | "POST";
export type ConsentStatus = "OPTED_IN" | "OPTED_OUT" | "UNKNOWN";
export type ConsentSource =
  | "USER_ENTRY"
  | "IMPORT"
  | "WEB_FORM"
  | "UNSUBSCRIBE_LINK"
  | "API"
  | "ENRICHMENT";
export type LegalBasis =
  | "CONSENT"
  | "CONTRACT"
  | "LEGITIMATE_INTEREST"
  | "LEGAL_OBLIGATION";

export interface ConsentDecision {
  contactId: number;
  allowed: boolean;
  reason: "allowed" | "opted_out" | "expired";
}

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
    if (emails.length === 0) return new Set();
    const normalised = [...new Set(emails.map((email) => email.trim().toLowerCase()))];

    // Deliberately does NOT filter `isNull(businessParties.deletedAt)`. An opt-out
    // must outlive the record it was captured on: if the contact is deleted and
    // the same address is later re-added, suppression still applies. Adding that
    // filter here would silently resume emailing people who opted out — the one
    // direction this query must never fail in. `countMissingConsent` filters
    // deleted contacts because it is a coverage metric, not a safety gate.
    const rows = await this.db
      .select({ email: businessParties.email })
      .from(crmContactChannelConsent)
      .innerJoin(
        contactPartyMap,
        and(
          eq(contactPartyMap.contactId, crmContactChannelConsent.contactId),
          eq(contactPartyMap.organizationId, orgId),
        ),
      )
      .innerJoin(businessParties, PARTY_OF_CONTACT)
      .where(
        and(
          eq(crmContactChannelConsent.orgId, orgId),
          eq(crmContactChannelConsent.channel, "EMAIL"),
          eq(crmContactChannelConsent.status, "OPTED_OUT"),
          inArray(sql`lower(${businessParties.email})`, normalised),
        ),
      );

    const fromConsent = rows.flatMap((row) =>
      row.email ? [row.email.trim().toLowerCase()] : [],
    );

    // Union with erasure-surviving suppression: a contact deleted under a DPDP
    // request takes its consent rows with it, but the opt-out must persist or
    // re-importing the address resumes emailing someone who withdrew consent.
    const hashes = normalised.map((email) => hashAddress(email));
    const suppressedHashes = await this.db
      .select({ addressHash: crmSuppressionHashes.addressHash })
      .from(crmSuppressionHashes)
      .where(
        and(
          eq(crmSuppressionHashes.orgId, orgId),
          eq(crmSuppressionHashes.channel, "EMAIL"),
          inArray(crmSuppressionHashes.addressHash, hashes),
        ),
      );

    const suppressedHashSet = new Set(suppressedHashes.map((row) => row.addressHash));
    const fromHashes = normalised.filter((email) =>
      suppressedHashSet.has(hashAddress(email)),
    );

    return new Set([...fromConsent, ...fromHashes]);
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
    const normalised = address.trim().toLowerCase();
    if (!normalised) return;

    await this.db
      .insert(crmSuppressionHashes)
      .values({ orgId, channel, addressHash: hashAddress(normalised), reason })
      .onConflictDoNothing();
  }

  /**
   * The address-only copy of an opt-out, for a contact we still have.
   *
   * Takes the transaction rather than opening one: the caller is recording the
   * opt-out, and the two must commit together or not at all.
   *
   * Silently does nothing when the contact has no address — there is nothing to
   * suppress, and a contact can legitimately have none. Not an error, because
   * it must never be the reason an opt-out fails to record.
   */
  private async retainSuppressionForContact(
    tx: Parameters<Parameters<typeof runInTenantTransaction>[1]>[0],
    orgId: string,
    contactId: number,
    reason: string,
  ): Promise<void> {
    const [row] = await tx
      .select({ email: businessParties.email })
      .from(contactPartyMap)
      .innerJoin(businessParties, PARTY_OF_CONTACT)
      .where(
        and(
          eq(contactPartyMap.organizationId, orgId),
          eq(contactPartyMap.contactId, contactId),
        ),
      )
      .limit(1);

    const normalised = row?.email?.trim().toLowerCase();
    if (!normalised) return;

    await tx
      .insert(crmSuppressionHashes)
      .values({
        orgId,
        channel: "EMAIL",
        addressHash: hashAddress(normalised),
        reason,
      })
      .onConflictDoNothing();
  }

  async record(
    orgId: string,
    input: {
      contactId: number;
      channel: ConsentChannel;
      status: ConsentStatus;
      source: ConsentSource;
      legalBasis?: LegalBasis;
      sourceDetail?: string;
      expiresAt?: Date | null;
      recordedByUserId?: string | null;
    },
  ): Promise<void> {
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [existing] = await tx
          .select({ status: crmContactChannelConsent.status })
          .from(crmContactChannelConsent)
          .where(
            and(
              eq(crmContactChannelConsent.orgId, orgId),
              eq(crmContactChannelConsent.contactId, input.contactId),
              eq(crmContactChannelConsent.channel, input.channel),
            ),
          )
          .limit(1);

        await tx
          .insert(crmContactChannelConsent)
          .values({
            orgId,
            contactId: input.contactId,
            channel: input.channel,
            status: input.status,
            source: input.source,
            legalBasis: input.legalBasis ?? null,
            sourceDetail: input.sourceDetail ?? null,
            expiresAt: input.expiresAt ?? null,
            recordedByUserId: input.recordedByUserId ?? null,
          })
          .onConflictDoUpdate({
            target: [
              crmContactChannelConsent.orgId,
              crmContactChannelConsent.contactId,
              crmContactChannelConsent.channel,
            ],
            set: {
              status: input.status,
              source: input.source,
              legalBasis: input.legalBasis ?? null,
              sourceDetail: input.sourceDetail ?? null,
              expiresAt: input.expiresAt ?? null,
              recordedByUserId: input.recordedByUserId ?? null,
              capturedAt: new Date(),
              updatedAt: new Date(),
            },
          });

        await tx.insert(crmContactConsentEvents).values({
          orgId,
          contactId: input.contactId,
          channel: input.channel,
          fromStatus: existing?.status ?? null,
          toStatus: input.status,
          legalBasis: input.legalBasis ?? null,
          source: input.source,
          sourceDetail: input.sourceDetail ?? null,
          recordedByUserId: input.recordedByUserId ?? null,
        });

        /**
         * CRM-P1-11. An opt-out has to outlive the row it was captured on.
         *
         * `crm_contact_channel_consent` is keyed on `contact_id`, so a contact
         * erased under a DPDP request takes its opt-out with it — and if the
         * same address is imported again, both suppression readers find nothing
         * and mail resumes to somebody who withdrew consent.
         *
         * `crm_suppression_hashes` exists precisely to survive that, and both
         * readers already union it in: `suppressedEmails` here, and
         * `OutboundService.isSuppressed` at send time. Nothing had ever written
         * a row, so that half of both queries was permanently empty and the
         * union added nothing at all.
         *
         * Written in the same transaction as the consent row, because an
         * opt-out recorded without its durable copy is the exact state this is
         * meant to prevent.
         *
         * EMAIL only, deliberately: both readers filter `channel = 'EMAIL'`,
         * and writing phone hashes nothing reads would be storing a fact with
         * no consumer — the shape of the bug being fixed here.
         */
        if (input.status === "OPTED_OUT" && input.channel === "EMAIL") {
          await this.retainSuppressionForContact(
            tx,
            orgId,
            input.contactId,
            `consent:${input.source}`,
          );
        }

        /**
         * The public unsubscribe endpoint has no signed-in user, so this is the
         * unattributed case: a null actor naming the capture path that acted.
         * It used to write the string "system", which has no row in `users`, so
         * this awaited `logCritical` raised a foreign-key violation and rolled
         * back the opt-out and its suppression hash along with it — clicking
         * the unsubscribe link recorded nothing at all.
         */
        const auditEntry = {
          action: "crm.consent.recorded",
          orgId,
          targetId: String(input.contactId),
          targetType: "crm_contact_consent",
          metadata: {
            channel: input.channel,
            from: existing?.status ?? null,
            to: input.status,
            source: input.source,
            legalBasis: input.legalBasis ?? null,
          },
        };

        await this.audit.logCritical(
          input.recordedByUserId
            ? { ...auditEntry, userId: input.recordedByUserId }
            : { ...auditEntry, systemActor: `crm.consent.${input.source}` },
        );
      },
      { orgId },
    );
  }

  async listForContact(orgId: string, contactId: number) {
    return this.db
      .select()
      .from(crmContactChannelConsent)
      .where(
        and(
          eq(crmContactChannelConsent.orgId, orgId),
          eq(crmContactChannelConsent.contactId, contactId),
        ),
      );
  }

  /** Contacts with no consent row at all for a channel, for data-quality surfacing. */
  async countMissingConsent(orgId: string, channel: ConsentChannel): Promise<number> {
    const [row] = await this.db
      .select({ cnt: sql<number>`count(*)` })
      .from(contactPartyMap)
      .innerJoin(businessParties, PARTY_OF_CONTACT)
      .leftJoin(
        crmContactChannelConsent,
        and(
          eq(crmContactChannelConsent.contactId, contactPartyMap.contactId),
          eq(crmContactChannelConsent.orgId, orgId),
          eq(crmContactChannelConsent.channel, channel),
        ),
      )
      .where(
        and(
          eq(contactPartyMap.organizationId, orgId),
          isNull(businessParties.deletedAt),
          isNull(crmContactChannelConsent.id),
        ),
      );
    return Number(row?.cnt ?? 0);
  }
}
