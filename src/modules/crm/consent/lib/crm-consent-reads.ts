import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { crmContactChannelConsent, crmContactConsentEvents, users } from "../../../../db/schema";
import { businessParties, contactPartyMap } from "../../../../db/schema/party";
import { PARTY_OF_CONTACT } from "../../crm-party-reads";
import { type Db } from "../../../../db/drizzle.module";
import type { ConsentChannel } from "./crm-consent.types";

/*
 * The read-only projections `CrmConsentService` serves: the evidence trail, the
 * current position per channel, the address a contact is reachable at, and the
 * missing-consent count. Each takes the service's handle, and each method's
 * contract is documented on the service.
 */

/** The query behind `CrmConsentService.listConsentEvents`. */
export async function readConsentEvents(
  db: Db,
  orgId: string,
  contactId: number,
  limit: number,
) {
  return db
    .select({
      id: crmContactConsentEvents.id,
      contactId: crmContactConsentEvents.contactId,
      channel: crmContactConsentEvents.channel,
      fromStatus: crmContactConsentEvents.fromStatus,
      toStatus: crmContactConsentEvents.toStatus,
      legalBasis: crmContactConsentEvents.legalBasis,
      source: crmContactConsentEvents.source,
      sourceDetail: crmContactConsentEvents.sourceDetail,
      recordedByUserId: crmContactConsentEvents.recordedByUserId,
      /**
       * The actor as a name, not only as an id -- a screen may never render a
       * raw user id, and this is the only place the trail names a person.
       *
       * One projected column off a LEFT JOIN, because `users` is the global
       * identity table and still carries authentication secrets, so an
       * unprojected relation to it is banned (§3). LEFT twice over: the
       * column is nullable by design -- an unsubscribe-link event has no
       * actor at all -- and somebody who has since left the organisation must
       * not drop their own entries out of an audit trail.
       */
      recordedByName: users.name,
      createdAt: crmContactConsentEvents.createdAt,
    })
    .from(crmContactConsentEvents)
    .leftJoin(users, eq(crmContactConsentEvents.recordedByUserId, users.id))
    .where(
      and(
        eq(crmContactConsentEvents.orgId, orgId),
        eq(crmContactConsentEvents.contactId, contactId),
      ),
    )
    /*
      Newest first, and `id` breaks the tie. Two changes can land in the same
      millisecond — an import touching several channels does exactly that —
      and ordering on the timestamp alone would let them swap between requests,
      which in an evidence trail reads as the record changing its story.
    */
    .orderBy(desc(crmContactConsentEvents.createdAt), desc(crmContactConsentEvents.id))
    .limit(limit);
}

/** The query behind `CrmConsentService.listForContact`. */
export async function readConsentForContact(db: Db, orgId: string, contactId: number) {
  return db
    .select({
      id: crmContactChannelConsent.id,
      contactId: crmContactChannelConsent.contactId,
      channel: crmContactChannelConsent.channel,
      status: crmContactChannelConsent.status,
      legalBasis: crmContactChannelConsent.legalBasis,
      source: crmContactChannelConsent.source,
      sourceDetail: crmContactChannelConsent.sourceDetail,
      capturedAt: crmContactChannelConsent.capturedAt,
      expiresAt: crmContactChannelConsent.expiresAt,
      recordedByUserId: crmContactChannelConsent.recordedByUserId,
    })
    .from(crmContactChannelConsent)
    .where(
      and(
        eq(crmContactChannelConsent.orgId, orgId),
        eq(crmContactChannelConsent.contactId, contactId),
      ),
    );
}

/** The query behind `CrmConsentService.contactEmail`. */
export async function readContactEmail(
  db: Db,
  orgId: string,
  contactId: number,
): Promise<string | null> {
  const [row] = await db
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
  const email = row?.email?.trim();
  return email && email.length > 0 ? email : null;
}

/** The count behind `CrmConsentService.countMissingConsent`. */
export async function countContactsMissingConsent(
  db: Db,
  orgId: string,
  channel: ConsentChannel,
): Promise<number> {
  const [row] = await db
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
