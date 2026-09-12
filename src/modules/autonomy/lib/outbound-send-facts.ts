import { createHash } from "node:crypto";
import { and, desc, eq, gte, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import {
  businessParties,
  crmContactChannelConsent,
  crmOutboundClassStops,
  crmOutboundMessages,
  crmSuppressionHashes,
  organizations,
  relationshipStates,
} from "../../../db/schema";
import { canonicalEmail } from "../../email/email-suppression.service";
import type { DealState } from "../outbound-eligibility";
import type { SendTimeFacts } from "../send-guardrails";
import type { OutboundFactsDeps, SendTimeMessage } from "./outbound-compose.types";
import { DAY_MS, loadOutboundDeal } from "./outbound-party-reads";

/*
  The facts `evaluateGuardrails` judges, read at the far end of the hold window
  from inside the claim step. Never at compose time — `send-guardrails.ts` has
  the argument, and `outbound.service.spec.ts` pins that compose never asks.
*/

/**
 * The world, read as late as it can be read.
 *
 * Called from inside the claim step and nowhere else. Every field below can
 * change during the hold window, and the whole point of `send-guardrails.ts`
 * is to be given the values that are true at the instant of the send rather
 * than the ones that were true when the draft was written.
 *
 * `partyTimezone` is the party's own zone where somebody recorded one
 * (CRM-P1-09 added `business_parties.timezone`), and null otherwise. Null is
 * not a stub: `resolveTimezone` falls through to the tenant's zone and
 * reports `tenant` as the source, which stays deliberate. The alternative for
 * an unknown zone — guessing from an address — would produce a confident
 * wrong answer and a message at four in the morning.
 */
export async function readSendTimeFacts(
  deps: OutboundFactsDeps,
  organizationId: string,
  message: SendTimeMessage,
): Promise<SendTimeFacts> {
  const now = new Date();

  const [consent] = message.contactId
    ? await deps.db
        .select({
          status: crmContactChannelConsent.status,
          expiresAt: crmContactChannelConsent.expiresAt,
        })
        .from(crmContactChannelConsent)
        .where(
          and(
            eq(crmContactChannelConsent.orgId, organizationId),
            eq(crmContactChannelConsent.contactId, message.contactId),
            eq(crmContactChannelConsent.channel, "EMAIL"),
          ),
        )
        .limit(1)
    : [];

  const [stop] = await deps.db
    .select({ id: crmOutboundClassStops.outboundClassStopId })
    .from(crmOutboundClassStops)
    .where(
      and(
        eq(crmOutboundClassStops.organizationId, organizationId),
        eq(crmOutboundClassStops.partyId, message.partyId),
        eq(crmOutboundClassStops.outboundClass, message.outboundClass),
        isNull(crmOutboundClassStops.releasedAt),
      ),
    )
    .limit(1);

  /**
   * Every send to this party, across every class and every loop.
   *
   * Not filtered by class, which is the failure `PARTY_FREQUENCY_CAPS` names:
   * four loops each politely sending one is four messages a week to somebody
   * who asked for none, and each loop can show it behaved. Bounded at the
   * widest cap window, because a send older than that cannot count.
   */
  const sends = await deps.db
    .select({ sentAt: crmOutboundMessages.sentAt })
    .from(crmOutboundMessages)
    .where(
      and(
        eq(crmOutboundMessages.organizationId, organizationId),
        eq(crmOutboundMessages.partyId, message.partyId),
        eq(crmOutboundMessages.status, "sent"),
        isNotNull(crmOutboundMessages.sentAt),
        gte(crmOutboundMessages.sentAt, new Date(now.getTime() - CAP_WINDOW_MS)),
      ),
    )
    .orderBy(desc(crmOutboundMessages.sentAt))
    .limit(MAX_SENDS_READ);

  const [relationship] = await deps.db
    .select({ lastInboundAt: relationshipStates.lastInboundAt })
    .from(relationshipStates)
    .where(
      and(
        eq(relationshipStates.organizationId, organizationId),
        eq(relationshipStates.partyId, message.partyId),
      ),
    )
    .limit(1);

  const [org] = await deps.db
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  /**
   * CRM-P1-09. Read here rather than carried on the draft, like every other
   * fact in this function: somebody may correct a customer's zone during the
   * hold window, and the send should honour the correction.
   */
  const [party] = await deps.db
    .select({ timezone: businessParties.timezone })
    .from(businessParties)
    .where(
      and(
        eq(businessParties.organizationId, organizationId),
        eq(businessParties.partyId, message.partyId),
      ),
    )
    .limit(1);

  return {
    now,
    outboundClass: message.outboundClass,
    consent: toConsentStatus(consent?.status),
    consentExpiresAt: consent?.expiresAt ?? null,
    suppressed: await isSuppressed(deps, organizationId, message.recipientEmail),
    classStopped: Boolean(stop),
    recentSendsToParty: sends.flatMap((row) => (row.sentAt ? [row.sentAt] : [])),
    partyTimezone: party?.timezone ?? null,
    tenantTimezone: org?.timezone ?? FALLBACK_TIMEZONE,
    repliedAt: relationship?.lastInboundAt ?? null,
    draftedAt: message.draftedAt,
    dealState: await dealState(deps.db, organizationId, message.dealId),
    deferralsSoFar: message.workingHourDeferrals,
  };
}

async function dealState(db: Db, organizationId: string, dealId: string | null): Promise<DealState> {
  if (!dealId) return "none";
  const deal = await loadOutboundDeal(db, organizationId, dealId);
  return deal?.state ?? "none";
}

/**
 * Both suppression lists, and a refusal when there is no address to check.
 *
 * `email_suppressions` is the platform's — hard bounces and complaints, which
 * make an address undeliverable rather than merely unwanted.
 * `crm_suppression_hashes` is the tenant's, and it holds only a hash precisely
 * so an opt-out survives the erasure of the contact who made it. Checking one
 * and not the other would let a re-imported address resume receiving mail.
 */
async function isSuppressed(
  deps: OutboundFactsDeps,
  organizationId: string,
  address: string | null,
): Promise<boolean> {
  if (!address) return false;

  const canonical = canonicalEmail(address);
  if (!canonical) return false;

  const platform = await deps.suppression.findSuppressed([canonical], organizationId);
  if (platform.size > 0) return true;

  const [tenant] = await deps.db
    .select({ id: crmSuppressionHashes.id })
    .from(crmSuppressionHashes)
    .where(
      and(
        eq(crmSuppressionHashes.orgId, organizationId),
        eq(crmSuppressionHashes.channel, "EMAIL"),
        eq(
          crmSuppressionHashes.addressHash,
          createHash("sha256").update(canonical).digest("hex"),
        ),
      ),
    )
    .limit(1);

  return Boolean(tenant);
}

/**
 * How far back the frequency-cap read reaches: the widest window in
 * `PARTY_FREQUENCY_CAPS`, and nothing beyond it, because a send older than the
 * widest cap cannot count against any of them.
 */
const CAP_WINDOW_MS = 30 * DAY_MS;

/**
 * A bound on the read rather than on the cap.
 *
 * `exceedsFrequencyCap` compares counts against a maximum of three, so any
 * honest answer is reached inside the first handful of rows. The limit exists so
 * a party that somehow accumulated thousands of sends cannot turn one guardrail
 * check into an unbounded scan; it can only make an already-exceeded cap read as
 * exceeded, which is the direction that fails closed.
 */
const MAX_SENDS_READ = 50;

/**
 * Used only when an organisation row has somehow gone. `organizations.timezone`
 * is NOT NULL with this same default, so this is unreachable in practice and is
 * here because `resolveTimezone` takes a string and a crash at send time would
 * dead-letter the run rather than refuse the message.
 */
const FALLBACK_TIMEZONE = "Asia/Kolkata";

/**
 * `crm_contact_channel_consent.status` is a Postgres enum with exactly the three
 * members `ConsentStatus` has, and `CrmConsentService` exports the identical
 * union — so this is a narrowing, not a translation. Absence reads as UNKNOWN,
 * which does not block: the tenant's legal basis may be contract or legitimate
 * interest, and that judgement is `evaluateGuardrails`'s to make.
 */
function toConsentStatus(status: string | undefined): SendTimeFacts["consent"] {
  return status === "OPTED_IN" || status === "OPTED_OUT" ? status : "UNKNOWN";
}
