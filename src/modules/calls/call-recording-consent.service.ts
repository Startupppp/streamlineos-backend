import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { activities } from "../../db/schema";
import { crmContactChannelConsent } from "../../db/schema/crm/consent";
import {
  callAnalysisRefusals,
  callRecordingConsent,
} from "../../db/schema/crm/call-analysis";
import {
  callRecordingConsentVerdict,
  consentRegimeBasis,
  normaliseJurisdiction,
  type CallConsentVerdict,
  type ConsentMethod,
  type PartyConsentEvidence,
} from "./call-recording-consent";

/**
 * Everything that talks to the database about whether a call may be analysed,
 * and nothing that decides it.
 *
 * The split is the same one `call-analysis-visibility.service.ts` makes against
 * `call-analysis-visibility.ts`, and for the same reason: a rule expressed as a
 * WHERE clause holds for exactly the query it was written in, and the next
 * surface that reads a transcript reimplements it from memory. Here the rule is
 * a pure function with no clock of its own, and this file's whole job is to hand
 * it an honest snapshot.
 *
 * Two stores answer "did the customer agree", and both are read rather than one
 * being copied into the other. `crm_contact_channel_consent` holds the standing
 * PHONE opt-in with its own append-only event history — the CRM's existing
 * consent machinery, which every outbound path already resolves through. Copying
 * it onto the call would create a second answer to "has this person opted out?"
 * that stops agreeing the moment somebody unsubscribes. `crm_call_recording_consent`
 * holds only what has nowhere else to live: where the call happened, our own
 * side's participation, and the per-call form of the customer's agreement.
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

/** What a refusal looks like to a caller that has to act on it. */
export interface CallConsentDecision {
  readonly activityId: string;
  readonly verdict: CallConsentVerdict;
  /** The citation behind the regime, for a compliance reviewer. Null when it defaulted. */
  readonly basis: string | null;
}

export interface CallRecordingConsentAttestation {
  readonly jurisdiction: string;
  readonly orgPartyConsented: boolean;
  readonly counterpartyConsented: boolean;
  readonly counterpartyMethod: ConsentMethod | null;
  readonly counterpartyWithdrawn: boolean;
  readonly note: string | null;
}

export type AttestOutcome =
  | { readonly ok: true; readonly decision: CallConsentDecision }
  | { readonly ok: false; readonly reason: "not-found" | "bad-jurisdiction"; readonly note: string };

export interface RefusalLedgerRow {
  readonly activityId: string;
  readonly jurisdiction: string | null;
  readonly reason: string;
  readonly note: string;
  readonly ruleVersion: number;
  readonly attempts: number;
  readonly firstRefusedAt: Date;
  readonly lastRefusedAt: Date;
}

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

@Injectable()
export class CallRecordingConsentService {
  private readonly logger = new Logger("CallRecordingConsent");

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * May this call be analysed?
   *
   * Returns a verdict for a call that does not exist as well as for one that
   * does, and deliberately does not distinguish them here: a missing call has no
   * jurisdiction on record, so it refuses with `jurisdiction-unrecorded` like any
   * other. The callers that need the distinction — the attestation route, which
   * must 404 — ask for it separately rather than reading it out of a refusal
   * reason that means something else.
   */
  async decide(organizationId: string, activityId: string): Promise<CallConsentDecision> {
    const decisions = await this.decideMany(organizationId, [activityId]);
    const found = decisions.get(activityId);
    if (found) return found;

    // No such live call. Fall through the rule rather than around it, so the
    // shape of a refusal is identical however it was reached.
    return this.decisionFor(activityId, {
      now: new Date(),
      occurredAt: new Date(0),
      jurisdiction: null,
      orgParty: null,
      counterparty: { withdrawnAt: null, evidence: [] },
    });
  }

  /**
   * The same decision for many calls, in three round trips rather than three per
   * call.
   *
   * The coaching digest reads a cohort of analyses and has to drop the ones the
   * consent rule would refuse; doing that one call at a time would make a
   * manager's page cost three queries per call. Every read carries the
   * organisation predicate, and the activity read carries the same
   * `kind = 'call'` and `deleted_at IS NULL` filters the per-call path does — a
   * batched read that quietly relaxed either would let a call into an aggregate
   * that the per-call route refuses to show.
   */
  async decideMany(
    organizationId: string,
    activityIds: readonly string[],
  ): Promise<Map<string, CallConsentDecision>> {
    const out = new Map<string, CallConsentDecision>();
    if (activityIds.length === 0) return out;

    const ids = [...new Set(activityIds)];

    const calls = await this.db
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
      this.db
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
        : this.db
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
        this.decisionFor(activityId, {
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

  /**
   * Record the refusal, so the gap is visible.
   *
   * Upserted on (organisation, call, rule version) rather than appended. A
   * timeline that re-renders refuses again, and an append-only ledger would grow
   * a row per page load — the signal a compliance officer needs is which calls,
   * not how many times somebody scrolled past one.
   *
   * Never throws. This is bookkeeping about a request that has already been
   * decided; turning a ledger write failure into a 500 would convert "we did not
   * analyse this call, and here is why" into "the call surface is broken", which
   * is a worse outcome for the same underlying event.
   */
  async recordRefusal(
    organizationId: string,
    activityId: string,
    verdict: CallConsentVerdict,
    requestedByUserId: string | null,
  ): Promise<void> {
    if (verdict.allowed) return;

    try {
      await this.db
        .insert(callAnalysisRefusals)
        .values({
          organizationId,
          activityId,
          jurisdiction: verdict.jurisdiction,
          reason: verdict.reason,
          ruleVersion: verdict.ruleVersion,
          note: verdict.note,
          lastRequestedByUserId: requestedByUserId,
        })
        .onConflictDoUpdate({
          target: [
            callAnalysisRefusals.organizationId,
            callAnalysisRefusals.activityId,
            callAnalysisRefusals.ruleVersion,
          ],
          set: {
            // The reason can move between attempts — somebody fills the
            // jurisdiction in and the refusal becomes a consent one. Keeping the
            // first reason would leave a compliance officer chasing a gap that
            // has already been closed.
            jurisdiction: verdict.jurisdiction,
            reason: verdict.reason,
            note: verdict.note,
            lastRefusedAt: sql`now()`,
            lastRequestedByUserId: requestedByUserId,
            attempts: sql`${callAnalysisRefusals.attempts} + 1`,
          },
        });
    } catch (error) {
      this.logger.warn(
        `consent refusal for ${activityId} in ${organizationId} was not recorded: ${String(error)}`,
      );
    }
  }

  /**
   * Attest to where a call happened and who agreed to it being recorded.
   *
   * An upsert, because the first attestation is usually incomplete — somebody
   * records the jurisdiction when the call lands and the consent evidence when
   * they have checked it — and a create-only route would make the second half
   * unreachable. Correcting an attestation is meant to be possible: an
   * attestation that could not be corrected would make a typo permanent, and the
   * fix somebody reached for instead would be a second row.
   */
  async attest(
    organizationId: string,
    userId: string,
    activityId: string,
    input: CallRecordingConsentAttestation,
  ): Promise<AttestOutcome> {
    const jurisdiction = normaliseJurisdiction(input.jurisdiction);
    if (jurisdiction === null) {
      return {
        ok: false,
        reason: "bad-jurisdiction",
        note: "A jurisdiction is an ISO 3166 code such as DE or US-CA.",
      };
    }

    const [call] = await this.db
      .select({ activityId: activities.activityId })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, organizationId),
          eq(activities.activityId, activityId),
          eq(activities.kind, "call"),
          isNull(activities.deletedAt),
        ),
      )
      .limit(1);

    if (!call) {
      return {
        ok: false,
        reason: "not-found",
        note: "That call is not on this organisation's timeline.",
      };
    }

    /**
     * The server's clock, and no field on the request that could replace it.
     *
     * This is the one edit that would turn this route into a way of
     * retroactively legalising a recording: a `consentedAt` a caller could
     * supply lets anybody back-date an attestation to before a call that has
     * already happened, and the rule would then wave it through. So the DTO has
     * no such field and this line has no parameter —
     * `counterparty-consent-after-the-call` catches the honest version of this
     * mistake, and the absence of the field is what stops the dishonest one.
     */
    const consentedAt = new Date();

    await this.db
      .insert(callRecordingConsent)
      .values({
        organizationId,
        activityId,
        jurisdiction,
        orgPartyConsentedAt: input.orgPartyConsented ? consentedAt : null,
        orgPartyMethod: input.orgPartyConsented ? "own-recording" : null,
        counterpartyConsentedAt: input.counterpartyConsented ? consentedAt : null,
        counterpartyMethod: input.counterpartyConsented
          ? (input.counterpartyMethod ?? "announced-and-acknowledged")
          : null,
        counterpartyWithdrawnAt: input.counterpartyWithdrawn ? consentedAt : null,
        note: input.note,
        attestedByUserId: userId,
      })
      .onConflictDoUpdate({
        target: [callRecordingConsent.organizationId, callRecordingConsent.activityId],
        set: {
          jurisdiction,
          orgPartyConsentedAt: input.orgPartyConsented ? consentedAt : null,
          orgPartyMethod: input.orgPartyConsented ? "own-recording" : null,
          counterpartyConsentedAt: input.counterpartyConsented ? consentedAt : null,
          counterpartyMethod: input.counterpartyConsented
            ? (input.counterpartyMethod ?? "announced-and-acknowledged")
            : null,
          counterpartyWithdrawnAt: input.counterpartyWithdrawn ? consentedAt : null,
          note: input.note,
          attestedByUserId: userId,
          updatedAt: new Date(),
        },
      });

    return { ok: true, decision: await this.decide(organizationId, activityId) };
  }

  /**
   * The calls this organisation is not analysing, and why.
   *
   * Carries no transcript, no quote and no analysis. The refusal exists
   * precisely because none of that may be produced, and a ledger that quoted the
   * call to explain why the call could not be quoted would be the disclosure the
   * refusal prevented.
   */
  async refusals(
    organizationId: string,
    sinceDays: number,
    limit: number,
  ): Promise<readonly RefusalLedgerRow[]> {
    const days = Number.isFinite(sinceDays) ? Math.min(Math.max(Math.trunc(sinceDays), 1), 90) : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await this.db
      .select({
        activityId: callAnalysisRefusals.activityId,
        jurisdiction: callAnalysisRefusals.jurisdiction,
        reason: callAnalysisRefusals.reason,
        note: callAnalysisRefusals.note,
        ruleVersion: callAnalysisRefusals.ruleVersion,
        attempts: callAnalysisRefusals.attempts,
        firstRefusedAt: callAnalysisRefusals.firstRefusedAt,
        lastRefusedAt: callAnalysisRefusals.lastRefusedAt,
      })
      .from(callAnalysisRefusals)
      .where(
        and(
          eq(callAnalysisRefusals.organizationId, organizationId),
          gte(callAnalysisRefusals.lastRefusedAt, since),
        ),
      )
      .orderBy(desc(callAnalysisRefusals.lastRefusedAt))
      .limit(Math.min(Math.max(Math.trunc(limit), 1), 200));

    return rows;
  }

  private decisionFor(
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
}
