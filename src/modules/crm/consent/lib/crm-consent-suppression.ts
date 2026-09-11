import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { crmContactChannelConsent, crmSuppressionHashes } from "../../../../db/schema";
import { businessParties, contactPartyMap } from "../../../../db/schema/party";
import { PARTY_OF_CONTACT } from "../../crm-party-reads";
import { type Db } from "../../../../db/drizzle.module";
import type { ConsentChannel } from "./crm-consent.types";

/*
 * Suppression by address: the reader that unions an opted-out contact's
 * address with the erasure-surviving hashes, and the writer of those hashes
 * for a contact about to be erased. `CrmConsentService.suppressedEmails` and
 * `retainSuppressionOnErasure` delegate here with the service's own handle.
 */

/** Salted-free SHA-256 of the normalised address — never store the address. */
export function hashAddress(normalisedAddress: string): string {
  return createHash("sha256").update(normalisedAddress).digest("hex");
}

/** The query behind `CrmConsentService.suppressedEmails`; its contract is documented there. */
export async function readSuppressedEmails(
  db: Db,
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
  const rows = await db
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
  const suppressedHashes = await db
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

/** The write behind `CrmConsentService.retainSuppressionOnErasure`. */
export async function writeErasureSuppression(
  db: Db,
  orgId: string,
  address: string,
  channel: ConsentChannel,
  reason: string,
): Promise<void> {
  const normalised = address.trim().toLowerCase();
  if (!normalised) return;

  await db
    .insert(crmSuppressionHashes)
    .values({ orgId, channel, addressHash: hashAddress(normalised), reason })
    .onConflictDoNothing();
}
