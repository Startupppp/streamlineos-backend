import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  contacts,
  crmContactChannelConsent,
  crmContactConsentEvents,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { AuditService } from "../../../common/audit/audit.service";

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

    const rows = await this.db
      .select({ email: contacts.email })
      .from(crmContactChannelConsent)
      .innerJoin(
        contacts,
        and(
          eq(contacts.id, crmContactChannelConsent.contactId),
          eq(contacts.orgId, orgId),
        ),
      )
      .where(
        and(
          eq(crmContactChannelConsent.orgId, orgId),
          eq(crmContactChannelConsent.channel, "EMAIL"),
          eq(crmContactChannelConsent.status, "OPTED_OUT"),
          inArray(sql`lower(${contacts.email})`, normalised),
        ),
      );

    return new Set(
      rows.flatMap((row) => (row.email ? [row.email.trim().toLowerCase()] : [])),
    );
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

        await this.audit.logCritical({
          action: "crm.consent.recorded",
          userId: input.recordedByUserId ?? "system",
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
        });
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
      .from(contacts)
      .leftJoin(
        crmContactChannelConsent,
        and(
          eq(crmContactChannelConsent.contactId, contacts.id),
          eq(crmContactChannelConsent.orgId, orgId),
          eq(crmContactChannelConsent.channel, channel),
        ),
      )
      .where(
        and(
          eq(contacts.orgId, orgId),
          isNull(contacts.deletedAt),
          isNull(crmContactChannelConsent.id),
        ),
      );
    return Number(row?.cnt ?? 0);
  }
}
