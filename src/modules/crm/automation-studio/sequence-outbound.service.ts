import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { activities } from "../../../db/schema/crm/activities";
import { autonomousDecisions } from "../../../db/schema/crm/autonomous-decisions";
import { autonomyHolds } from "../../../db/schema/crm/autonomy-holds";
import {
  crmOutboundClassStops,
  crmOutboundMessages,
} from "../../../db/schema/crm/outbound";
import { organizations } from "../../../db/schema/common/auth";
import { buildDecision } from "../../autonomy/decision-record";
import { decisionKindFor, type OutboundClass, trackFor } from "../../autonomy/outbound-classes";
import type { DealState } from "../../autonomy/outbound-eligibility";
import type { ConsentStatus, SendTimeFacts } from "../../autonomy/send-guardrails";
import { CrmConsentService } from "../consent/crm-consent.service";
import { SEQUENCE_HOLD_SECONDS } from "./sequence-step";

/**
 * The facts a sequence step needs before it may send, and the held row it
 * becomes when it may.
 *
 * Phase 5, ticket 17. This service exists because `crm_outbound_messages`,
 * `autonomy_holds` and `evaluateGuardrails` were all built in earlier phases and
 * nothing in `src/modules` wrote to any of them. The held-outbound model was
 * complete and unreachable; the sequences runner — the loop that sends the most
 * messages to the coldest audience on the least-watched schedule — went straight
 * to the mailer.
 *
 * Being precise about what was and was not missing, because an overstated
 * finding is its own kind of lie:
 *
 * Consent and suppression WERE applied. `CrmOutboundEmailService.send` calls
 * `suppressedEmails` on every recipient, so an opt-out was honoured. What it
 * could not do is honour a per-party frequency cap, because it is handed
 * addresses rather than parties, and an address is not a person — a customer
 * with a work address and a personal one gets one message on each while every
 * cap reports itself as respected. That is why `crm_outbound_messages.party_id`
 * exists and why the cap is read from it.
 *
 * What was genuinely absent: the frequency cap, working hours, the hold window
 * that makes a send cancellable, the class stop, the decision record, and — the
 * one the ticket calls the most damaging behaviour in this category — the reply
 * exit.
 */
@Injectable()
export class SequenceOutboundService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly consent: CrmConsentService,
  ) {}

  /**
   * A snapshot of everything that decides whether this message may leave.
   *
   * Taken as late as possible, in the same tick that would send, because every
   * fact here can change between drafting and sending — which is the whole
   * argument of `send-guardrails.ts`. A snapshot taken when the sequence was
   * enrolled would be a fortnight stale on step four.
   */
  async sendTimeFacts(input: {
    readonly orgId: string;
    readonly partyId: string;
    readonly recipientEmail: string;
    readonly outboundClass: OutboundClass;
    readonly dealState: DealState;
    readonly draftedAt: Date;
    readonly deferralsSoFar: number;
    readonly now: Date;
  }): Promise<SendTimeFacts> {
    const [suppressed, recentSends, classStopped, lastInbound, tenantTimezone] =
      await Promise.all([
        this.consent.suppressedEmails(input.orgId, [input.recipientEmail]),
        this.recentSendsToParty(input.orgId, input.partyId),
        this.classStopped(input.orgId, input.partyId, input.outboundClass),
        this.lastInboundFrom(input.orgId, input.partyId),
        this.tenantTimezone(input.orgId),
      ]);

    const blocked = suppressed.has(input.recipientEmail.trim().toLowerCase());

    /*
      `suppressedEmails` unions an explicit opt-out with the erasure-surviving
      suppression list, and does not say which one matched. Reported as
      `suppressed` rather than `OPTED_OUT` because the guardrails check
      suppression first and both block absolutely — reporting the wrong one of
      two blocks that produce the same outcome would put a wrong reason in the
      ledger, and the ledger is what somebody reads when a customer asks why they
      were mailed.
    */
    const consent: ConsentStatus = "UNKNOWN";

    return {
      now: input.now,
      outboundClass: input.outboundClass,
      consent,
      consentExpiresAt: null,
      suppressed: blocked,
      classStopped,
      recentSendsToParty: recentSends,
      /*
        No party timezone column exists yet, so every send resolves to the
        tenant's. `resolveTimezone` already prefers the party's where one is
        recorded, so this becomes correct without a change here the day that
        column arrives — and until then the tenant's working day is a far better
        guess at a customer's than midnight in Greenwich.
      */
      partyTimezone: null,
      tenantTimezone,
      repliedAt: lastInbound,
      draftedAt: input.draftedAt,
      dealState: input.dealState,
      deferralsSoFar: input.deferralsSoFar,
    };
  }

  /**
   * Everything the system has sent this party, newest first, across every loop.
   *
   * Per party rather than per address and per loop rather than per class, which
   * is the point of the cap: four loops each politely sending one message is
   * four messages to somebody who asked for none, and each loop can show that it
   * behaved. `idx_crm_outbound_party_recent` is partial on `sent` for this read.
   */
  private async recentSendsToParty(orgId: string, partyId: string): Promise<Date[]> {
    const rows = await this.db
      .select({ sentAt: crmOutboundMessages.sentAt })
      .from(crmOutboundMessages)
      .where(
        and(
          eq(crmOutboundMessages.organizationId, orgId),
          eq(crmOutboundMessages.partyId, partyId),
          eq(crmOutboundMessages.status, "sent"),
        ),
      )
      .orderBy(desc(crmOutboundMessages.sentAt))
      .limit(50);
    return rows.flatMap((row) => (row.sentAt ? [row.sentAt] : []));
  }

  /** A human stopped this class of message to this party and nobody released it. */
  private async classStopped(
    orgId: string,
    partyId: string,
    outboundClass: OutboundClass,
  ): Promise<boolean> {
    const rows = await this.db
      .select({ id: crmOutboundClassStops.outboundClassStopId })
      .from(crmOutboundClassStops)
      .where(
        and(
          eq(crmOutboundClassStops.organizationId, orgId),
          eq(crmOutboundClassStops.partyId, partyId),
          eq(crmOutboundClassStops.outboundClass, outboundClass),
          isNull(crmOutboundClassStops.releasedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * When this party last said something to us.
   *
   * Read from the unified timeline rather than from a per-channel table, because
   * a reply on WhatsApp has to exit an email sequence — a person who has
   * answered has answered, and which app they used is our problem rather than
   * theirs. `actor_kind = 'human'` with no actor user id is the timeline's shape
   * for an inbound message: a person acted, and the person was not one of ours.
   */
  async lastInboundFrom(orgId: string, partyId: string): Promise<Date | null> {
    const rows = await this.db
      .select({ occurredAt: activities.occurredAt })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, orgId),
          eq(activities.partyId, partyId),
          eq(activities.actorKind, "human"),
          isNull(activities.actorUserId),
          isNull(activities.deletedAt),
        ),
      )
      .orderBy(desc(activities.occurredAt))
      .limit(1);
    return rows[0]?.occurredAt ?? null;
  }

  private async tenantTimezone(orgId: string): Promise<string> {
    const rows = await this.db
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    return rows[0]?.timezone ?? "UTC";
  }

  /**
   * The step becomes a held message: recorded, decided, and cancellable.
   *
   * Three rows rather than one, and each is load-bearing.
   *
   * `crm_outbound_messages` is the message. It exists from this moment rather
   * than from the moment it leaves, because everything interesting happens in
   * between — the hold, the person who stopped it, the guardrail that refused it
   * at send time — and a table recording only successful sends answers none of
   * the questions anybody asks it.
   *
   * `autonomous_decisions` is the decision, recorded as `held` rather than
   * `applied`: it has not happened yet, and a feed saying "sent" for something
   * still waiting is reading a lie to a reviewer.
   *
   * `autonomy_holds` is the window. Its `outbound_message_id` arm already exists
   * — ticket 07 of an earlier phase widened the table past quotes — so a
   * sequence step needs no new hold kind, no new column and no second hold
   * model. That is the first criterion satisfied by reuse rather than by
   * building the thing the ticket warns against.
   *
   * The unique index on live holds per message is the concurrency control: two
   * ticks racing on the same enrollment produce one hold and one conflict, not
   * two messages.
   */
  async holdStep(input: {
    readonly orgId: string;
    readonly partyId: string;
    readonly contactId: number | null;
    readonly dealId: string | null;
    readonly outboundClass: OutboundClass;
    readonly subject: string;
    readonly body: string;
    readonly timezoneUsed: string;
    readonly timezoneSource: "party" | "tenant";
    readonly deferralsSoFar: number;
    readonly now: Date;
  }): Promise<{ readonly outboundMessageId: string; readonly holdUntil: Date }> {
    const holdUntil = new Date(input.now.getTime() + SEQUENCE_HOLD_SECONDS * 1000);
    const kind = decisionKindFor(input.outboundClass);

    const [decision] = await this.db
      .insert(autonomousDecisions)
      /*
        `buildDecision` rather than a hand-written row, because it derives
        `reversibility` from the kind. Writing the row by hand means choosing
        that class at each call site, and a sequence step recorded as `instant`
        would offer a reviewer an undo for a message that has left the building.
      */
      .values(
        buildDecision({
          organizationId: input.orgId,
          kind,
          // Not `applied`: it has not left yet, and the feed must not say it has.
          outcome: "held",
          triggerType: "sequence",
          triggerId: input.dealId,
          dealId: input.dealId,
          partyId: input.partyId,
          confidence: null,
          decision: { holdUntil: holdUntil.toISOString(), outboundClass: input.outboundClass },
          summary: `Sequence step: ${input.subject}`,
        }),
      )
      .returning({ id: autonomousDecisions.autonomousDecisionId });

    if (!decision) throw new Error("could not record the decision to send");

    const [message] = await this.db
      .insert(crmOutboundMessages)
      .values({
        organizationId: input.orgId,
        partyId: input.partyId,
        contactId: input.contactId,
        dealId: input.dealId,
        outboundClass: input.outboundClass,
        track: trackFor(input.outboundClass),
        channel: "email",
        subject: input.subject,
        body: input.body,
        status: "held",
        workingHourDeferrals: input.deferralsSoFar,
        timezoneUsed: input.timezoneUsed,
        timezoneSource: input.timezoneSource,
        autonomousDecisionId: decision.id,
      })
      .returning({ id: crmOutboundMessages.outboundMessageId });

    if (!message) throw new Error("could not record the message");

    await this.db.insert(autonomyHolds).values({
      organizationId: input.orgId,
      autonomousDecisionId: decision.id,
      kind,
      outboundMessageId: message.id,
      holdUntil,
    });

    return { outboundMessageId: message.id, holdUntil };
  }

  /**
   * A step the guardrails refused, recorded rather than dropped.
   *
   * A refusal that leaves no row is indistinguishable from a step that never ran,
   * and the two need different answers when somebody asks why a customer stopped
   * hearing from us. The `blocked` status and `blocked_reason` column exist for
   * exactly this and had no writer.
   */
  async recordBlocked(input: {
    readonly orgId: string;
    readonly partyId: string;
    readonly dealId: string | null;
    readonly outboundClass: OutboundClass;
    readonly subject: string;
    readonly reason: string;
  }): Promise<void> {
    /*
      A blocked message carries a decision row like any other, because
      `crm_outbound_messages.autonomous_decision_id` is NOT NULL — and that
      constraint is right. Deciding not to send is a decision the system made on
      the tenant's behalf, and it is the one a person most often needs explained:
      "why did this customer stop hearing from us" is answered by the outcome and
      the reason together, and a message row pointing at nothing answers half of
      it.

      `skipped` rather than `failed`. Nothing went wrong — a guardrail did
      exactly what it exists to do, and recording that as a failure would put it
      in the same bucket as a mailer outage on whatever dashboard counts them.
    */
    const [decision] = await this.db
      .insert(autonomousDecisions)
      .values(
        buildDecision({
          organizationId: input.orgId,
          kind: decisionKindFor(input.outboundClass),
          outcome: "skipped",
          triggerType: "sequence",
          triggerId: input.dealId,
          dealId: input.dealId,
          partyId: input.partyId,
          confidence: null,
          decision: { blockedReason: input.reason },
          summary: `Sequence step withheld: ${input.reason}`,
        }),
      )
      .returning({ id: autonomousDecisions.autonomousDecisionId });

    if (!decision) throw new Error("could not record the decision to withhold");

    await this.db.insert(crmOutboundMessages).values({
      organizationId: input.orgId,
      partyId: input.partyId,
      dealId: input.dealId,
      outboundClass: input.outboundClass,
      track: trackFor(input.outboundClass),
      channel: "email",
      subject: input.subject,
      body: "",
      status: "blocked",
      blockedReason: input.reason,
      autonomousDecisionId: decision.id,
    });
  }
}
