import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { activities } from "../../db/schema";
import {
  callAnalysisRefusals,
  callRecordingConsent,
} from "../../db/schema/crm/call-analysis";
import { normaliseJurisdiction, type CallConsentVerdict } from "./call-recording-consent";
import type {
  AttestOutcome,
  CallConsentDecision,
  CallRecordingConsentAttestation,
  RefusalLedgerRow,
} from "./lib/call-recording-consent.types";
import { consentDecisionFor, decideCallConsentMany } from "./lib/call-recording-consent-snapshot";

export type {
  AttestOutcome,
  CallConsentDecision,
  CallRecordingConsentAttestation,
  RefusalLedgerRow,
} from "./lib/call-recording-consent.types";

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
 * The join to the standing record, and its one honest limit, are documented
 * on `decideCallConsentMany` in `lib/call-recording-consent-snapshot.ts`, which
 * holds the three reads and the fold. `decideMany` passes it this handle.
 */

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
    return consentDecisionFor(activityId, {
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
    return decideCallConsentMany(this.db, organizationId, activityIds);
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
}
