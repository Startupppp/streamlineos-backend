import { ConflictException, Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, desc, eq, gte, isNull, isNotNull, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  autonomousDecisions,
  autonomyHolds,
  autonomySwitches,
  businessParties,
  crmColdOutboundSettings,
  crmContactChannelConsent,
  crmOutboundClassStops,
  crmOutboundMessages,
  crmPipelineStages,
  crmSendingDomains,
  crmSuppressionHashes,
  contactPartyMap,
  deals,
  organizations,
  partyContacts,
  relationshipStates,
  users,
} from "../../db/schema";
import { getOrgAdminUserIds } from "../../common/tenant/org-admin-recipients";
import { startRun } from "../../common/workflow/workflow-store";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { EmailSuppressionService, canonicalEmail } from "../email/email-suppression.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AutonomyScoringService } from "./autonomy-scoring.service";
import { buildDecision, capText, RECORDED_CONVERSATION_CHARS, redactForModel, shouldAct } from "./decision-record";
import { clampHoldWindow } from "./hold-window";
import { resolveSwitch, switchesFor, type SwitchRow } from "./kill-switch";
import { decisionKindFor, OUTBOUND_CLASS_LABELS, trackFor, type OutboundClass } from "./outbound-classes";
import {
  buildOutboundPrompt,
  draftRefusalSummary,
  judgeDraft,
  outboundDraftSchema,
  OUTBOUND_FEATURE,
  OUTBOUND_PROMPT_KEY,
  OUTBOUND_PROMPT_VERSION,
  OUTBOUND_SYSTEM_PROMPT,
  type OutboundDraft,
} from "./outbound-draft";
import {
  judgeOutbound,
  outboundRefusalSummary,
  type DealState,
  type RelationshipSnapshot,
} from "./outbound-eligibility";
import type { ColdTrackFacts } from "./cold-outbound-gate";
import type { SendTimeFacts } from "./send-guardrails";

/**
 * The name the placer and the runner both use. Declared here, beside the
 * placement, for the reason `HOLD_WORKFLOW` is declared beside `holdQuoteSend`:
 * a run started under one string and handled under another is dead-lettered,
 * and two constants in two files are two things that can drift.
 */
export const OUTBOUND_WORKFLOW = "crm.autonomy-outbound";

/**
 * Deciding to write to a customer, and reading the world again when it leaves.
 *
 * This is the seam between the six pure modules in this directory and the
 * database. Every judgement lives in one of those files as a pure function of an
 * explicit snapshot; everything here is the reading that builds a snapshot and
 * the writing that records what the judgement decided. Nothing in this file
 * decides anything, which is what keeps the rules arguable without a database.
 *
 * The one property worth stating twice: `sendTimeFacts` is NOT called from
 * `composeAndHold`. Its whole reason to exist is to be called at the far end of
 * the hold window, inside the step that claims the send — see
 * `send-guardrails.ts`, whose first paragraph is the argument. A caller that
 * took the snapshot when it drafted would be enforcing a reading of the world
 * from an hour ago at the only moment that matters, and every one of these
 * facts — a reply, an unsubscribe, a colleague's mail, the clock — is one that
 * changes inside that hour.
 */
@Injectable()
export class OutboundService {
  private readonly logger = new Logger("Outbound");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly scoring: AutonomyScoringService,
    private readonly notifications: NotificationsService,
    private readonly suppression: EmailSuppressionService,
  ) {}

  // ── Compose time ──────────────────────────────────────────────────────────

  /**
   * Decide whether to write to somebody, write it, and start the interval in
   * which a human can stop it.
   *
   * The order is the ticket, and it runs cheapest-refusal-first: the relationship
   * is judged before a provider is paid, the draft is judged before a row is
   * written, and the confidence threshold is applied before anything is held.
   * Every one of those exits records a decision — a skip nobody wrote down is
   * indistinguishable from a loop that never ran, and the correction rate needs
   * a denominator that includes the messages there was nothing to say in.
   *
   * There is no approval step. The decision is recorded as `held` rather than
   * `applied` because it has not happened yet; a reviewer seeing "sent" for
   * something still waiting would be reading a lie.
   */
  async composeAndHold(input: {
    organizationId: string;
    partyId: string;
    dealId?: string | null;
  }): Promise<ComposeOutcome> {
    const { organizationId, partyId } = input;
    const context = await this.loadComposeContext(organizationId, partyId, input.dealId ?? null);

    if (!context) return { held: false, stage: "eligibility", reason: "That customer is not on file." };

    const verdict = judgeOutbound(context.snapshot);

    if (!verdict.act) {
      const summary = outboundRefusalSummary(verdict.reason);
      await this.recordRefusal(organizationId, input, "outbound.sent", summary);
      return { held: false, stage: "eligibility", reason: summary };
    }

    const outboundClass = verdict.outboundClass;
    const kind = decisionKindFor(outboundClass);

    /**
     * The kill switch is read here as well as on wake, and the two readings do
     * different jobs.
     *
     * On wake it stops a message that was already decided. Here it stops the
     * provider call that would have decided one — an operator who has switched
     * outbound off should not still be paying for drafts nobody may send. The
     * wake-time read stays authoritative, because a switch thrown during the
     * hold window is exactly the case this one cannot see.
     */
    if (!(await this.switchAllows(organizationId, outboundClass))) {
      const summary = "Autonomous sending is switched off; nothing was drafted.";
      await this.recordRefusal(organizationId, input, kind, summary);
      return { held: false, stage: "eligibility", reason: summary };
    }

    /**
     * `judgeDraft`'s `no-sender-name` refusal, made before the money is spent.
     *
     * It would refuse the draft anyway — there is no salesperson to write as —
     * and the only difference between checking here and letting it fail there is
     * a provider call the tenant is billed for on every sweep over a party
     * nobody owns. The check is duplicated rather than moved: `judgeDraft` is
     * the authority and stays the last gate, because a second caller assembling
     * its own context must not be able to skip it.
     */
    if (!context.senderName.trim()) {
      const summary = "Nobody here is on the deal to write as, so nothing was drafted.";
      await this.recordRefusal(organizationId, input, kind, summary);
      return { held: false, stage: "draft", reason: summary };
    }

    /**
     * Redacted before the prompt is built, not after.
     *
     * Permission data must never reach a provider and no model output may
     * influence an authorization decision. Nothing assembled here is
     * permission-shaped by construction; this is the line that catches the field
     * somebody adds to `loadComposeContext` later without thinking.
     */
    const { context: safe, removed } = redactForModel({
      recipientName: context.recipientName,
      senderName: context.senderName,
      companyName: context.companyName,
      dealName: context.dealName,
      agreedNextStep: context.agreedNextStep,
      conversation: context.conversation,
    });

    if (removed.length > 0)
      this.logger.warn(`outbound: stripped ${removed.length} forbidden field(s) before inference`);

    const conversation = (safe.conversation as string) ?? "";
    const recipientName = (safe.recipientName as string) ?? "";
    const senderName = (safe.senderName as string) ?? "";

    const result = await this.gateway.invokeStructuredWithUsage<OutboundDraft>({
      actor: { orgId: organizationId, userId: null },
      feature: OUTBOUND_FEATURE,
      // Writing four sentences to somebody we already know is the small model's
      // job. Nothing here escalates: a message that needs frontier reasoning is
      // a message that needs a person.
      tier: "fast",
      schema: outboundDraftSchema,
      charge: true,
      prompt: {
        system: OUTBOUND_SYSTEM_PROMPT,
        user: buildOutboundPrompt({
          outboundClass,
          recipientName,
          senderName,
          companyName: (safe.companyName as string | null) ?? null,
          dealName: (safe.dealName as string | null) ?? null,
          agreedNextStep: (safe.agreedNextStep as string | null) ?? null,
          daysSinceLastContact: context.daysSinceLastContact,
          conversation,
        }),
        promptKey: OUTBOUND_PROMPT_KEY,
        promptVersion: OUTBOUND_PROMPT_VERSION,
      },
    });

    if (!result.ok) {
      // The gateway has already released its reservation. This only records that
      // a decision was attempted, so a provider outage reads as a visible run of
      // failures rather than as silence.
      await this.recordRefusal(
        organizationId,
        input,
        kind,
        `Drafting did not complete: ${result.kind}.`,
        "failed",
      );
      return { held: false, stage: "draft", reason: "Drafting did not complete." };
    }

    const judged = judgeDraft(result.data, { recipientName, senderName, conversation });

    if (!judged.ok) {
      const summary = draftRefusalSummary(judged.reason);
      await this.recordRefusal(organizationId, input, kind, summary, "skipped", {
        model: result.aiUsage.model,
        confidence: result.data.confidence,
      });
      return { held: false, stage: "draft", reason: summary };
    }

    const draft = judged.draft;

    /**
     * The threshold, applied after the draft rather than before it.
     *
     * It cannot be applied earlier: the confidence is the model's own, and there
     * is nothing to threshold until it has answered. `decision-record.ts` sets
     * cold higher than engaged, which is why the kind is derived from the class
     * rather than fixed.
     */
    if (!shouldAct(kind, draft.confidence)) {
      const summary = `Drafted a ${OUTBOUND_CLASS_LABELS[outboundClass].toLowerCase()} but was not confident enough to send it.`;
      await this.recordRefusal(organizationId, input, kind, summary, "skipped", {
        model: result.aiUsage.model,
        confidence: draft.confidence,
      });
      return { held: false, stage: "confidence", reason: summary };
    }

    return this.holdOutboundSend({
      organizationId,
      partyId,
      dealId: input.dealId ?? null,
      contactId: context.contactId,
      outboundClass,
      draft,
      model: result.aiUsage.model,
      reason: verdict.reason,
    });
  }

  /**
   * Write the message down and start its clock.
   *
   * Three rows in one order that is not arbitrary. The ledger row first, because
   * `crm_outbound_messages.autonomous_decision_id` is NOT NULL and the ledger is
   * the record that must exist even if everything after it fails. The message
   * second, because the hold points at it. The hold last, because the moment it
   * exists the window has started and a human may cancel it.
   */
  private async holdOutboundSend(input: {
    organizationId: string;
    partyId: string;
    dealId: string | null;
    contactId: number | null;
    outboundClass: OutboundClass;
    draft: OutboundDraft;
    model: string | null;
    reason: string;
  }): Promise<ComposeOutcome> {
    const { organizationId, outboundClass, draft } = input;
    const kind = decisionKindFor(outboundClass);
    const settings = await this.scoring.settingsFor(organizationId);
    const windowSeconds = clampHoldWindow(settings.holdWindowSeconds);
    const holdUntil = new Date(Date.now() + windowSeconds * 1000);

    const [decision] = await this.db
      .insert(autonomousDecisions)
      .values(
        buildDecision({
          organizationId,
          kind,
          // Not `applied`: it has not left yet, and the feed must not say it has.
          outcome: "held",
          triggerType: "party",
          triggerId: input.partyId,
          partyId: input.partyId,
          dealId: input.dealId,
          model: input.model,
          promptVersion: String(OUTBOUND_PROMPT_VERSION),
          confidence: draft.confidence,
          inputs: { why: input.reason, outboundClass },
          decision: { outboundClass, holdUntil: holdUntil.toISOString() },
          summary: draft.summary,
        }),
      )
      .returning({ id: autonomousDecisions.autonomousDecisionId });

    if (!decision) throw new ConflictException("Could not record the decision to send.");

    const [message] = await this.db
      .insert(crmOutboundMessages)
      .values({
        organizationId,
        partyId: input.partyId,
        contactId: input.contactId,
        dealId: input.dealId,
        outboundClass,
        // Derived, never passed in. `chk_crm_outbound_messages_track` refuses a
        // row whose track disagrees with its class, because a `cold_outreach`
        // filed as `engaged` slips past the cold gate's own daily count.
        track: trackFor(outboundClass),
        subject: draft.subject,
        body: draft.body,
        status: "drafted",
        autonomousDecisionId: decision.id,
        model: input.model,
        promptVersion: String(OUTBOUND_PROMPT_VERSION),
      })
      .returning({ id: crmOutboundMessages.outboundMessageId });

    if (!message) throw new ConflictException("Could not record the drafted message.");

    let hold;
    try {
      [hold] = await this.db
        .insert(autonomyHolds)
        .values({
          organizationId,
          autonomousDecisionId: decision.id,
          /**
           * The same value, narrowed rather than re-derived.
           *
           * `decisionKindFor` returns the whole `DecisionKind` union while
           * `autonomy_holds.kind` declares only the three kinds that can wait,
           * and TypeScript cannot see that this class can only produce two of
           * them. Deriving the hold's kind from the track a second time would be
           * a second mapping from class to kind, and two of those are two things
           * that can disagree — which is the failure `outbound-classes.ts`
           * writes `TRACK` as a total map to prevent.
           */
          kind: kind as "outbound.sent" | "cold_outbound.sent",
          outboundMessageId: message.id,
          holdUntil,
        })
        .returning({ id: autonomyHolds.autonomyHoldId });
    } catch (error) {
      // `uniq_autonomy_holds_live_outbound`. A second decision to send the same
      // draft while one is already waiting is a duplicate, not a race to win.
      if (isUniqueViolation(error))
        throw new ConflictException("That message is already waiting to send.");
      throw error;
    }

    if (!hold) throw new ConflictException("Could not place the hold.");

    const runId = await startRun(this.db, {
      organizationId,
      workflowName: OUTBOUND_WORKFLOW,
      input: { autonomyHoldId: hold.id, outboundMessageId: message.id },
      causationEventId: hold.id,
      correlationId: `outbound:${message.id}`,
    });

    await this.db
      .update(autonomyHolds)
      .set({ workflowRunId: runId })
      .where(
        and(
          eq(autonomyHolds.organizationId, organizationId),
          eq(autonomyHolds.autonomyHoldId, hold.id),
        ),
      );

    await this.db
      .update(crmOutboundMessages)
      .set({ status: "held" })
      .where(
        and(
          eq(crmOutboundMessages.organizationId, organizationId),
          eq(crmOutboundMessages.outboundMessageId, message.id),
        ),
      );

    await this.notifyPending(organizationId, {
      holdId: hold.id,
      dealId: input.dealId,
      subject: draft.subject,
      outboundClass,
      windowSeconds,
    });

    return {
      held: true,
      outboundMessageId: message.id,
      autonomyHoldId: hold.id,
      decisionId: decision.id,
      outboundClass,
      holdUntil,
      windowSeconds,
    };
  }

  // ── Send time ─────────────────────────────────────────────────────────────

  /**
   * The world, read as late as it can be read.
   *
   * Called from inside the claim step and nowhere else. Every field below can
   * change during the hold window, and the whole point of `send-guardrails.ts`
   * is to be given the values that are true at the instant of the send rather
   * than the ones that were true when the draft was written.
   *
   * `partyTimezone` is null today and honestly so: nothing in `business_parties`
   * or `party_contacts` records one, so `resolveTimezone` falls through to the
   * tenant's zone and reports `tenant` as the source. That is the correct
   * behaviour rather than a stub — the alternative, guessing from an address,
   * would produce a confident wrong answer and a message at four in the morning.
   */
  async sendTimeFacts(
    organizationId: string,
    message: {
      outboundMessageId: string;
      partyId: string;
      contactId: number | null;
      dealId: string | null;
      outboundClass: OutboundClass;
      draftedAt: Date;
      workingHourDeferrals: number;
      recipientEmail: string | null;
    },
  ): Promise<SendTimeFacts> {
    const now = new Date();

    const [consent] = message.contactId
      ? await this.db
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

    const [stop] = await this.db
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
    const sends = await this.db
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

    const [relationship] = await this.db
      .select({ lastInboundAt: relationshipStates.lastInboundAt })
      .from(relationshipStates)
      .where(
        and(
          eq(relationshipStates.organizationId, organizationId),
          eq(relationshipStates.partyId, message.partyId),
        ),
      )
      .limit(1);

    const [org] = await this.db
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    return {
      now,
      outboundClass: message.outboundClass,
      consent: toConsentStatus(consent?.status),
      consentExpiresAt: consent?.expiresAt ?? null,
      suppressed: await this.isSuppressed(organizationId, message.recipientEmail),
      classStopped: Boolean(stop),
      recentSendsToParty: sends.flatMap((row) => (row.sentAt ? [row.sentAt] : [])),
      partyTimezone: null,
      tenantTimezone: org?.timezone ?? FALLBACK_TIMEZONE,
      repliedAt: relationship?.lastInboundAt ?? null,
      draftedAt: message.draftedAt,
      dealState: await this.dealState(organizationId, message.dealId),
      deferralsSoFar: message.workingHourDeferrals,
    };
  }

  /**
   * The cold track's own facts, read at send time for the same reason.
   *
   * A domain's warm-up day advances while a message waits, and its bounce rate
   * is the number that decides whether the track pauses itself — reading either
   * at compose time would gate on yesterday.
   */
  async coldTrackFacts(organizationId: string): Promise<ColdTrackFacts> {
    const now = new Date();

    const [settings] = await this.db
      .select({
        enabled: crmColdOutboundSettings.enabled,
        pausedAt: crmColdOutboundSettings.pausedAt,
      })
      .from(crmColdOutboundSettings)
      .where(eq(crmColdOutboundSettings.organizationId, organizationId))
      .limit(1);

    const domains = await this.db
      .select({
        domain: crmSendingDomains.domain,
        purpose: crmSendingDomains.purpose,
        verifiedAt: crmSendingDomains.verifiedAt,
        warmupStartedAt: crmSendingDomains.warmupStartedAt,
      })
      .from(crmSendingDomains)
      .where(eq(crmSendingDomains.organizationId, organizationId));

    const cold = domains.find((row) => row.purpose === "cold") ?? null;
    const transactional = domains.find((row) => row.purpose === "transactional") ?? null;

    const dayStart = new Date(now.getTime() - DAY_MS);
    const [today] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(crmOutboundMessages)
      .where(
        and(
          eq(crmOutboundMessages.organizationId, organizationId),
          eq(crmOutboundMessages.track, "cold"),
          eq(crmOutboundMessages.status, "sent"),
          gte(crmOutboundMessages.sentAt, dayStart),
        ),
      );

    return {
      now,
      // The absence of a row and `enabled = false` mean the same thing, which is
      // the property `crm_cold_outbound_settings` was designed around: a tenant
      // that has never heard of this feature must be indistinguishable from one
      // that turned it off.
      enabled: settings?.enabled ?? false,
      pausedAt: settings?.pausedAt ?? null,
      domain: cold
        ? {
            domain: cold.domain,
            purpose: "cold",
            verifiedAt: cold.verifiedAt,
            warmupStartedAt: cold.warmupStartedAt,
          }
        : null,
      transactionalDomain: transactional?.domain ?? null,
      sentToday: today?.count ?? 0,
      /**
       * Zero, and stated rather than faked.
       *
       * Bounce and complaint counts come from the provider's webhooks, which are
       * reconciled against `recipient_email` in `email_webhook` — a seam this
       * module does not own and no cold campaign has yet produced a row in.
       * `COLD_MIN_VOLUME_FOR_RATES` is what makes zeroes safe here: below fifty
       * sends the gate refuses to read the rates as evidence at all, so a
       * hard-coded zero cannot let a burning domain through — it can only fail
       * to catch one, and only above fifty cold sends, which nothing can reach
       * until the cold track has an entry point.
       */
      recentSends: 0,
      recentBounces: 0,
      recentComplaints: 0,
    };
  }

  /**
   * The address, resolved at send time rather than copied from the draft.
   *
   * A contact who changed their mail during the hold window must not receive it
   * at the old one. The party's primary contact first, the party's own address
   * as the fallback, and null when there is neither — which the guardrails
   * cannot express, so the workflow treats it as a send failure rather than a
   * block.
   *
   * Keyed on the party rather than on `crm_outbound_messages.contact_id`,
   * deliberately. That column holds the LEGACY integer contact id, which exists
   * for the consent tables that are still keyed on it; `party_contacts` is the
   * party-native record and is where an address change actually lands.
   */
  async resolveRecipient(organizationId: string, partyId: string): Promise<string | null> {
    const [contact] = await this.db
      .select({ email: partyContacts.email })
      .from(partyContacts)
      .where(
        and(
          eq(partyContacts.organizationId, organizationId),
          eq(partyContacts.partyId, partyId),
          isNull(partyContacts.deletedAt),
          isNotNull(partyContacts.email),
        ),
      )
      .orderBy(desc(partyContacts.isPrimary))
      .limit(1);

    if (contact?.email?.trim()) return contact.email.trim();

    const [party] = await this.db
      .select({ email: businessParties.email })
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          eq(businessParties.partyId, partyId),
        ),
      )
      .limit(1);

    return party?.email?.trim() || null;
  }

  /** Whether the kill switch for this class allows anything at all. */
  async switchAllows(organizationId: string, outboundClass: OutboundClass): Promise<boolean> {
    const rows = await this.db
      .select({
        organizationId: autonomySwitches.organizationId,
        kind: autonomySwitches.kind,
        enabled: autonomySwitches.enabled,
        reason: autonomySwitches.reason,
      })
      .from(autonomySwitches)
      // Scoped like every sibling call site. `switchesFor` discards the rest in
      // JS and RLS discards them in production, so this is not a leak — but an
      // unscoped read drags every tenant's switches back on every send.
      .where(
        or(
          isNull(autonomySwitches.organizationId),
          eq(autonomySwitches.organizationId, organizationId),
        ),
      );

    return resolveSwitch(
      organizationId,
      decisionKindFor(outboundClass),
      switchesFor(organizationId, rows as SwitchRow[]),
    ).allowed;
  }

  /**
   * The track stops itself, and only a person starts it again.
   *
   * Written from `pauseTrack`, which `evaluateColdGate` returns for exactly two
   * reasons — a bounce rate and a complaint rate. A pause that expired on its
   * own would resume sending into whatever caused it.
   */
  async pauseColdTrack(organizationId: string, reason: string): Promise<void> {
    await this.db
      .insert(crmColdOutboundSettings)
      .values({ organizationId, enabled: false, pausedAt: new Date(), pauseReason: reason })
      .onConflictDoUpdate({
        target: crmColdOutboundSettings.organizationId,
        set: { pausedAt: new Date(), pauseReason: reason },
        // Only if it is not already paused: re-stamping would move the moment
        // the track stopped, and that timestamp is what an operator reads to
        // find out what was in flight when it did.
        setWhere: isNull(crmColdOutboundSettings.pausedAt),
      });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Everything compose time needs, in one read per table.
   *
   * Explicit joins rather than the relational include API: `db/schema` re-exports
   * every module's tables through one barrel, and a relational query here would
   * pull the whole graph in to resolve names it does not use.
   *
   * THE DEAL IS THE ANCHOR, and that is a real limit rather than an accident.
   * The deal supplies the salesperson to write as, the name of the thing being
   * discussed, what was agreed, and the only conversation this module can reach
   * without taking a dependency on `activities` and `thread-window.ts`. A party
   * with no deal therefore produces no message — which means `judgeOutbound`'s
   * `check_in` branch, the one that fires on a long silence with nothing open,
   * cannot be reached from this caller today even though the pure module answers
   * it correctly. Stated rather than papered over: signing a message with the
   * organisation's name would contradict the prompt's own premise, which is one
   * salesperson writing to a customer they already know.
   */
  private async loadComposeContext(
    organizationId: string,
    partyId: string,
    dealId: string | null,
  ): Promise<ComposeContext | null> {
    const [party] = await this.db
      .select({ name: businessParties.name, companyName: businessParties.companyName })
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          eq(businessParties.partyId, partyId),
        ),
      )
      .limit(1);

    if (!party) return null;

    const [relationship] = await this.db
      .select({
        lastInboundAt: relationshipStates.lastInboundAt,
        lastOutboundAt: relationshipStates.lastOutboundAt,
        awaitingReplySince: relationshipStates.awaitingReplySince,
      })
      .from(relationshipStates)
      .where(
        and(
          eq(relationshipStates.organizationId, organizationId),
          eq(relationshipStates.partyId, partyId),
        ),
      )
      .limit(1);

    const [lastAutonomous] = await this.db
      .select({ sentAt: crmOutboundMessages.sentAt })
      .from(crmOutboundMessages)
      .where(
        and(
          eq(crmOutboundMessages.organizationId, organizationId),
          eq(crmOutboundMessages.partyId, partyId),
          eq(crmOutboundMessages.status, "sent"),
        ),
      )
      .orderBy(desc(crmOutboundMessages.sentAt))
      .limit(1);

    const deal = dealId ? await this.loadDeal(organizationId, dealId) : null;
    const recipient = await this.resolveRecipient(organizationId, partyId);

    /**
     * The legacy integer id, carried so consent is reachable at send time.
     *
     * `crm_contact_channel_consent` is keyed on `contact_id` and its party
     * column is an additive expand that nothing populates for every row yet, so
     * resolving the number here is what makes `SendTimeFacts.consent` something
     * other than a permanent UNKNOWN. Null where the party was never a contact —
     * a lead minted straight into `business_parties`, for instance — and UNKNOWN
     * is then the honest answer rather than a lookup that silently found nothing.
     */
    const [mapped] = await this.db
      .select({ contactId: contactPartyMap.contactId })
      .from(contactPartyMap)
      .where(
        and(
          eq(contactPartyMap.organizationId, organizationId),
          eq(contactPartyMap.partyId, partyId),
        ),
      )
      .limit(1);
    const now = new Date();

    const snapshot: RelationshipSnapshot = {
      now,
      lastInboundAt: relationship?.lastInboundAt ?? null,
      lastOutboundAt: relationship?.lastOutboundAt ?? null,
      lastAutonomousOutboundAt: lastAutonomous?.sentAt ?? null,
      dealState: deal?.state ?? "none",
      /**
       * `awaiting_reply_since` records when the ball entered THEIR court, so a
       * value means it is theirs and a null means it is ours. `awaitingUs` is
       * the opposite question, which is why this is negated rather than copied —
       * getting it the wrong way round would make the loop chase people who are
       * waiting on us, which is the one refusal `outbound-eligibility.ts` calls
       * "the-ball-is-ours".
       */
      awaitingUs: !relationship?.awaitingReplySince,
      nextStepDueAt: deal?.followUpDate ?? null,
      /**
       * False, and honestly so. "They asked to meet and nothing is booked" is a
       * fact about the conversation that nothing in the CRM records as a field;
       * inferring it from the deal's next step would put a meeting request in
       * front of somebody who never asked for one, which is worse than the
       * follow-up they get instead.
       */
      meetingRequested: false,
      hasReachableAddress: Boolean(recipient),
    };

    return {
      snapshot,
      contactId: mapped?.contactId ?? null,
      recipientName: party.name,
      senderName: deal?.senderName ?? "",
      companyName: party.companyName ?? null,
      dealName: deal?.name ?? null,
      agreedNextStep: capText(deal?.nextStep ?? null, AGREED_NEXT_STEP_CHARS),
      daysSinceLastContact: daysBetween(relationship?.lastOutboundAt ?? null, now),
      conversation: capText(deal?.notes ?? null, RECORDED_CONVERSATION_CHARS),
    };
  }

  private async loadDeal(organizationId: string, dealId: string) {
    const numeric = Number(dealId);
    if (!Number.isInteger(numeric)) return null;

    const [row] = await this.db
      .select({
        name: deals.name,
        stage: deals.stage,
        stageType: crmPipelineStages.stageType,
        nextStep: deals.nextStep,
        notes: deals.notes,
        followUpDate: deals.followUpDate,
        senderName: users.name,
      })
      .from(deals)
      .leftJoin(
        crmPipelineStages,
        and(
          eq(crmPipelineStages.orgId, deals.orgId),
          eq(crmPipelineStages.pipelineId, deals.pipelineId),
          eq(crmPipelineStages.key, deals.stage),
        ),
      )
      .leftJoin(users, eq(users.id, deals.assignedToId))
      .where(
        and(eq(deals.orgId, organizationId), eq(deals.id, numeric), isNull(deals.deletedAt)),
      )
      .limit(1);

    if (!row) return null;
    return { ...row, senderName: row.senderName ?? "", state: toDealState(row.stageType) };
  }

  private async dealState(organizationId: string, dealId: string | null): Promise<DealState> {
    if (!dealId) return "none";
    const deal = await this.loadDeal(organizationId, dealId);
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
  private async isSuppressed(organizationId: string, address: string | null): Promise<boolean> {
    if (!address) return false;

    const canonical = canonicalEmail(address);
    if (!canonical) return false;

    const platform = await this.suppression.findSuppressed([canonical], organizationId);
    if (platform.size > 0) return true;

    const [tenant] = await this.db
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

  private async recordRefusal(
    organizationId: string,
    input: { partyId: string; dealId?: string | null },
    kind: ReturnType<typeof decisionKindFor>,
    summary: string,
    outcome: "skipped" | "failed" = "skipped",
    extra: { model?: string | null; confidence?: number | null } = {},
  ): Promise<void> {
    await this.db.insert(autonomousDecisions).values(
      buildDecision({
        organizationId,
        kind,
        outcome,
        triggerType: "party",
        triggerId: input.partyId,
        partyId: input.partyId,
        dealId: input.dealId ?? null,
        model: extra.model ?? null,
        promptVersion: String(OUTBOUND_PROMPT_VERSION),
        confidence: extra.confidence ?? null,
        summary,
      }),
    );
  }

  /**
   * Tell somebody who could stop it, while there is still time.
   *
   * A hold nobody hears about is a delay, not a safeguard — and a failed
   * notification must not stop the hold existing, because the review feed still
   * shows it and a throw here would leave a message drafted with no clock.
   */
  private async notifyPending(
    organizationId: string,
    input: {
      holdId: string;
      dealId: string | null;
      subject: string;
      outboundClass: OutboundClass;
      windowSeconds: number;
    },
  ): Promise<void> {
    const deal = input.dealId ? await this.loadDealAssignee(organizationId, input.dealId) : null;
    const recipients = deal ? [deal] : await getOrgAdminUserIds(this.db, organizationId);

    if (recipients.length === 0) {
      this.logger.warn(
        `outbound hold ${input.holdId} has nobody to tell; it will send unannounced`,
      );
      return;
    }

    for (const userId of recipients) {
      try {
        await this.notifications.create({
          orgId: organizationId,
          userId,
          type: "WARNING",
          // High, because the entire value is that it is read before the window ends.
          priority: "HIGH",
          category: "SYSTEM",
          sourceModule: "crm",
          eventKey: "crm.autonomy.outbound-holding",
          entityType: "autonomy_hold",
          entityId: input.holdId,
          title: `A ${OUTBOUND_CLASS_LABELS[input.outboundClass].toLowerCase()} is about to send`,
          message: `"${input.subject}" sends in ${input.windowSeconds} seconds unless you stop it.`,
          link: `/crm/autonomy?holdId=${input.holdId}`,
        });
      } catch (error) {
        this.logger.error(
          `could not notify ${userId} about outbound hold ${input.holdId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async loadDealAssignee(organizationId: string, dealId: string): Promise<string | null> {
    const numeric = Number(dealId);
    if (!Number.isInteger(numeric)) return null;

    const [row] = await this.db
      .select({ assignedToId: deals.assignedToId })
      .from(deals)
      .where(and(eq(deals.orgId, organizationId), eq(deals.id, numeric)))
      .limit(1);

    return row?.assignedToId ?? null;
  }
}

// ── Shapes and small conversions ────────────────────────────────────────────

export type ComposeOutcome =
  | {
      readonly held: false;
      /** Where it stopped, so a caller can tell a refusal from an outage. */
      readonly stage: "eligibility" | "draft" | "confidence";
      readonly reason: string;
    }
  | {
      readonly held: true;
      readonly outboundMessageId: string;
      readonly autonomyHoldId: string;
      readonly decisionId: string;
      readonly outboundClass: OutboundClass;
      readonly holdUntil: Date;
      readonly windowSeconds: number;
    };

interface ComposeContext {
  readonly snapshot: RelationshipSnapshot;
  readonly contactId: number | null;
  readonly recipientName: string;
  readonly senderName: string;
  readonly companyName: string | null;
  readonly dealName: string | null;
  readonly agreedNextStep: string | null;
  readonly daysSinceLastContact: number | null;
  readonly conversation: string;
}

const DAY_MS = 86_400_000;

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

/** What the model may be told was agreed. Capped for the same reason the conversation is. */
const AGREED_NEXT_STEP_CHARS = 200;

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

/**
 * The tenant's own terminal stages, never the literal strings WON and LOST.
 *
 * A tenant whose closing stage is called `CLOSED_WON` would otherwise read as
 * open forever, and the loop would keep chasing a deal that closed last month.
 * A stage with no row — a deal on no pipeline — reads as open, because the
 * guardrail's job is to stop a send on a CLOSED deal and "unknown" is not that.
 */
function toDealState(stageType: string | null | undefined): DealState {
  if (stageType === "won") return "won";
  if (stageType === "lost") return "lost";
  return "open";
}

function daysBetween(from: Date | null, now: Date): number | null {
  if (!from) return null;
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS));
}

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}
