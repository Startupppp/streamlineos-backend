import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { activities } from "../../../db/schema";
import { crmContactChannelConsent } from "../../../db/schema/crm/consent";
import { callRecordingConsent } from "../../../db/schema/crm/call-analysis";
import {
  callRecordingConsentVerdict,
  consentRegimeBasis,
  normaliseJurisdiction,
  type ConsentMethod,
  type PartyConsentEvidence,
} from "../call-recording-consent";
import type { CallConsentDecision } from "./call-recording-consent.types";

/** One standing PHONE consent row, projected to what the rule needs. */
interface StandingConsentRow {
  readonly contactPartyId: string | null;
  readonly status: "OPTED_IN" | "OPTED_OUT" | "UNKNOWN";
  readonly capturedAt: Date;
  readonly expiresAt: Date | null;
}

/** The facts one call contributes, before the rule is applied. */
interface CallFacts {
  readonly occurredAt: Date;
  readonly partyId: string | null;
}

/**
 * The three reads behind `CallRecordingConsentService.decideMany`, and the fold
 * that turns them into one honest snapshot per live call for the rule. Runs on
 * the service's own handle; the method's contract is documented there.
 *
 * The join to the standing record goes through `contact_party_id`, not
 * `contact_id`. `activities` is anchored on a party; `crm_contact_channel_consent`
 * carries both the legacy integer contact id and the party id beside it, kept in
 * step by `trg_contact_channel_consent_party` (migration 0276). Joining on the
 * party is the only edge that exists between the two, and every side of it
 * carries the organisation predicate.
 *
 * One honest limit of that join, stated here rather than discovered later. It
 * resolves only where the party a call was filed against and the party a
 * contact's consent row derives from are the same row — an inbound call whose
 * number matched an existing party identifier, typically. Where they are not the
 * same party, the standing opt-in contributes nothing and the per-call
 * attestation is the only evidence available. That degrades to a refusal rather
 * than to a pass, which is the direction a gap in this rule has to fall.
 */
export async function decideCallConsentMany(
  db: Db,
  organizationId: string,
  activityIds: readonly string[],
): Promise<Map<string, CallConsentDecision>> {
  const out = new Map<string, CallConsentDecision>();
  if (activityIds.length === 0) return out;

  const ids = [...new Set(activityIds)];

  const calls = await db
    .select({
      activityId: activities.activityId,
      occurredAt: activities.occurredAt,
      partyId: activities.partyId,
    })
    .from(activities)
    .where(
      and(
        eq(activities.organizationId, organizationId),
        inArray(activities.activityId, ids),
        eq(activities.kind, "call"),
        isNull(activities.deletedAt),
      ),
    );

  if (calls.length === 0) return out;

  const callById = new Map<string, CallFacts>(
    calls.map((row) => [row.activityId, { occurredAt: row.occurredAt, partyId: row.partyId }]),
  );
  const liveIds = [...callById.keys()];
  const partyIds = [
    ...new Set(calls.map((row) => row.partyId).filter((id): id is string => id !== null)),
  ];

  const [attestations, standing] = await Promise.all([
    db
      .select()
      .from(callRecordingConsent)
      .where(
        and(
          eq(callRecordingConsent.organizationId, organizationId),
          inArray(callRecordingConsent.activityId, liveIds),
        ),
      ),
    partyIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            contactPartyId: crmContactChannelConsent.contactPartyId,
            status: crmContactChannelConsent.status,
            capturedAt: crmContactChannelConsent.capturedAt,
            expiresAt: crmContactChannelConsent.expiresAt,
          })
          .from(crmContactChannelConsent)
          .where(
            and(
              eq(crmContactChannelConsent.orgId, organizationId),
              eq(crmContactChannelConsent.channel, "PHONE"),
              inArray(crmContactChannelConsent.contactPartyId, partyIds),
            ),
          ),
  ]);

  const attestationByActivity = new Map(attestations.map((row) => [row.activityId, row]));
  /**
   * Folded rather than mapped, because a party can have more than one row
   * here: the unique index on `crm_contact_channel_consent` is per contact,
   * and two contacts can map to one party. Keeping whichever row the planner
   * returned last would make the verdict depend on row order — and would
   * sometimes drop an opt-out. So an `OPTED_OUT` beats everything, and among
   * opt-ins the earliest capture wins, because the question the rule asks is
   * whether consent predates the call.
   */
  const standingByParty = new Map<string, StandingConsentRow>();
  for (const row of standing) {
    if (row.contactPartyId === null) continue;
    const held = standingByParty.get(row.contactPartyId);
    if (!held) {
      standingByParty.set(row.contactPartyId, row);
      continue;
    }
    if (held.status === "OPTED_OUT") continue;
    if (row.status === "OPTED_OUT") {
      standingByParty.set(row.contactPartyId, row);
      continue;
    }
    if (row.status === "OPTED_IN" && held.status !== "OPTED_IN") {
      standingByParty.set(row.contactPartyId, row);
      continue;
    }
    if (
      row.status === held.status &&
      row.capturedAt.getTime() < held.capturedAt.getTime()
    ) {
      standingByParty.set(row.contactPartyId, row);
    }
  }

  const now = new Date();

  for (const activityId of liveIds) {
    const call = callById.get(activityId);
    if (!call) continue;
    const attested = attestationByActivity.get(activityId) ?? null;
    const party = call.partyId === null ? null : standingByParty.get(call.partyId) ?? null;

    const evidence: PartyConsentEvidence[] = [];

    /**
     * The standing opt-in counts as evidence only when it is an affirmative
     * `OPTED_IN`. `UNKNOWN` is the default every contact starts on and is the
     * absence of a decision, not a quiet yes — `CrmConsentService.filterSendable`
     * treats it as non-blocking for outbound because a legal basis other than
     * consent may cover a phone call, and that reasoning does not carry over
     * here: nothing but consent makes a recording lawful in an all-party
     * jurisdiction.
     */
    if (party && party.status === "OPTED_IN") {
      evidence.push({
        consentedAt: party.capturedAt,
        method: "standing-consent",
        expiresAt: party.expiresAt,
      });
    }

    if (attested?.counterpartyConsentedAt) {
      evidence.push({
        consentedAt: attested.counterpartyConsentedAt,
        method: (attested.counterpartyMethod as ConsentMethod | null) ?? "written-agreement",
        // A per-call attestation is about one conversation, so it cannot
        // expire between being made and the call it describes.
        expiresAt: null,
      });
    }

    /**
     * Either withdrawal vetoes. A channel-wide `OPTED_OUT` and a "do not
     * record this call" are different acts, and honouring only one of them
     * would let the other be worked around by using the wrong control.
     */
    const withdrawnAt =
      attested?.counterpartyWithdrawnAt ??
      (party && party.status === "OPTED_OUT" ? party.capturedAt : null);

    out.set(
      activityId,
      consentDecisionFor(activityId, {
        now,
        occurredAt: call.occurredAt,
        jurisdiction: normaliseJurisdiction(attested?.jurisdiction ?? null),
        orgParty: attested?.orgPartyConsentedAt
          ? {
              consentedAt: attested.orgPartyConsentedAt,
              method: (attested.orgPartyMethod as ConsentMethod | null) ?? "own-recording",
              expiresAt: null,
            }
          : null,
        counterparty: { withdrawnAt, evidence },
      }),
    );
  }

  return out;
}

/** The rule's verdict for one call, with the citation behind its regime. */
export function consentDecisionFor(
  activityId: string,
  facts: Parameters<typeof callRecordingConsentVerdict>[0],
): CallConsentDecision {
  const verdict = callRecordingConsentVerdict(facts);
  return {
    activityId,
    verdict,
    basis: consentRegimeBasis(verdict.jurisdiction),
  };
}
