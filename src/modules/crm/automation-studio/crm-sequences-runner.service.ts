import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, isNotNull, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { crmSequenceEnrollments, crmSequenceSteps, crmSequences, deals, tasks } from "../../../db/schema";
import { businessParties, leadPartyMap } from "../../../db/schema/party";
import { PARTY_OF_LEAD } from "../crm-party-reads";
import { logger } from "../../../common/logger/logger.service";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { CrmOutboundEmailService } from "../consent/crm-outbound-email.service";
import { resolveTimezone } from "../../autonomy/send-guardrails";
import type { OutboundClass } from "../../autonomy/outbound-classes";
import { SequenceOutboundService } from "./sequence-outbound.service";
import { evaluateSequenceTick, readStepConfig, stepSends } from "./sequence-step";

interface FlushResult {
  processed: number;
  advanced: number;
  stopped: number;
}

@Injectable()
export class CrmSequencesRunnerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: CrmOutboundEmailService,
    private readonly outbound: SequenceOutboundService,
  ) {}

  /**
   * What class of message a sequence step is — derived, never declared.
   *
   * The obvious implementation reads a class off `step.config`, and it is the
   * bypass ticket 17's sixth criterion is about. `cold_outreach` runs on the
   * cold track, which carries the domain-reputation guardrails: a paused
   * sending domain, bounce and complaint thresholds, a separate kill switch. A
   * genuinely cold campaign labelled `follow_up` by whoever built the sequence
   * escapes every one of them, and nothing about the label is checkable.
   *
   * So the class follows from the relationship rather than from an author's
   * word for it. Somebody who has ever written to us is somebody we are
   * following up with; somebody who has not is somebody we are contacting cold,
   * whatever the sequence is called. That reading cannot be gamed from a
   * configuration column, and it errs towards the stricter track when the
   * relationship is unknown — which is the direction to err in, because being
   * wrong the other way burns a sending domain shared by every tenant.
   */
  private outboundClassFor(hasHeardFromThem: boolean): OutboundClass {
    return hasHeardFromThem ? "follow_up" : "cold_outreach";
  }

  private evaluateStopOn(
    stopOn: Record<string, unknown>,
    enrollment: { orgId: string; entityType: string; entityId: string },
    convertedLeadKeys: Set<string>,
  ): { stop: boolean; reason: string } {
    if (stopOn["converted"] === true) {
      if (enrollment.entityType === "lead") {
        const key = `${enrollment.orgId}:${parseInt(enrollment.entityId, 10)}`;
        if (convertedLeadKeys.has(key)) return { stop: true, reason: "stopOn_converted" };
      } else {
        return { stop: false, reason: "stopOn_converted_unsupported_entity" };
      }
    }

    /*
      `replied` is deliberately NOT handled here any more.

      It used to be, in the worst possible way: it was listed as "unsupported",
      logged at warn level, and ignored — so a tenant ticked "stop when they
      reply", the UI accepted it, the database stored it, and the next message
      went out anyway. Ticket 17 calls automation that talks over a person the
      single most damaging behaviour in this category, and it was configurable,
      switched on, and inert.

      It is not handled here because it is no longer a setting. A reply exits
      every sequence, whatever `stopOn` says, and that is decided in
      `evaluateSequenceTick` before a step is even selected. Leaving it as an
      option would mean a tenant could turn it off, which the sixth criterion
      forbids and which nobody should want.

      `meeting_booked` remains genuinely unimplemented, and says so.
    */
    if (stopOn["meeting_booked"] === true)
      logger.warn("crm-sequences-runner: stopOn.meeting_booked is not implemented", {});

    return { stop: false, reason: "" };
  }

  async flushDueEnrollments(now = new Date()): Promise<FlushResult> {
    const enrollments = await this.db
      .select({
        id: crmSequenceEnrollments.id,
        orgId: crmSequenceEnrollments.orgId,
        sequenceId: crmSequenceEnrollments.sequenceId,
        entityType: crmSequenceEnrollments.entityType,
        entityId: crmSequenceEnrollments.entityId,
        currentStep: crmSequenceEnrollments.currentStep,
        status: crmSequenceEnrollments.status,
        stopReason: crmSequenceEnrollments.stopReason,
        /*
          When this enrolment began, which is what a reply is judged against.
          A reply that predates the enrolment is what caused it, not an answer
          to it — see the `>` in `evaluateSequenceTick`.
        */
        createdAt: crmSequenceEnrollments.createdAt,
      })
      .from(crmSequenceEnrollments)
      .where(
        and(
          eq(crmSequenceEnrollments.status, "active"),
          lte(crmSequenceEnrollments.nextRunAt, now),
          isNull(crmSequenceEnrollments.stopReason),
        ),
      )
      .limit(200);

    if (enrollments.length === 0) return { processed: 0, advanced: 0, stopped: 0 };

    const uniqueSequenceIds = [...new Set(enrollments.map((e) => e.sequenceId))];
    const orgIds = [...new Set(enrollments.map((e) => e.orgId))];

    /*
      Narrowed from "every sequence in the database" to the ones these
      enrolments actually belong to.

      The previous read had no organisation predicate and no sequence predicate:
      it loaded every non-deleted `crm_sequences` row across every tenant on the
      platform, on every tick, to build a lookup for at most two hundred
      enrolments. That is a cross-tenant read whose only defence was that the
      map was keyed by id — and it grew linearly with the customer base.
    */
    const seqRows = await this.db
      .select({ id: crmSequences.id, stopOn: crmSequences.stopOn, isActive: crmSequences.isActive })
      .from(crmSequences)
      .where(
        and(
          inArray(crmSequences.orgId, orgIds),
          inArray(crmSequences.id, uniqueSequenceIds),
          isNull(crmSequences.deletedAt),
        ),
      );
    const seqStopOnMap = new Map(seqRows.map((s) => [s.id, s.stopOn]));
    /*
      A sequence somebody switched off, or deleted, stops sending. Absent from
      this set means either — and both should end the enrolment rather than
      leave it running against a sequence nobody can see any more.
    */
    const activeSequenceIds = new Set(seqRows.filter((s) => s.isActive).map((s) => s.id));
    const allStepRows = await this.db
      .select()
      .from(crmSequenceSteps)
      .where(inArray(crmSequenceSteps.sequenceId, uniqueSequenceIds))
      .orderBy(crmSequenceSteps.sortOrder);

    const stepsMap = new Map<
      (typeof crmSequenceSteps.$inferSelect)["sequenceId"],
      (typeof crmSequenceSteps.$inferSelect)[]
    >();
    for (const step of allStepRows) {
      const arr = stepsMap.get(step.sequenceId) ?? [];
      arr.push(step);
      stepsMap.set(step.sequenceId, arr);
    }

    const convertedLeadKeys = new Set<string>();
    const leadCheckIds: number[] = [];
    for (const enrollment of enrollments) {
      const rawStopOn = seqStopOnMap.get(enrollment.sequenceId);
      if (!rawStopOn || typeof rawStopOn !== "object") continue;
      if ((rawStopOn as Record<string, unknown>)["converted"] !== true) continue;
      if (enrollment.entityType !== "lead") continue;
      const leadId = parseInt(enrollment.entityId, 10);
      if (Number.isFinite(leadId)) leadCheckIds.push(leadId);
    }

    /*
      The party behind each enrolment, which is what the frequency cap is keyed
      on — an address is not a person, and a customer with a work address and a
      personal one would otherwise receive one message on each while every cap
      reported itself as respected.

      Both reads are issued unconditionally when there are candidates, and both
      are set-based. An enrolment whose party cannot be resolved is not sent to:
      a send that cannot be capped is a send that has left the guardrails, and
      failing closed makes the gap visible in the ledger rather than quietly
      exempting whichever entity types the maps do not cover.
    */
    const partyByEnrollment = new Map<string, string>();

    const leadEnrollments = enrollments.filter((e) => e.entityType === "lead");
    const leadIds = leadEnrollments
      .map((e) => parseInt(e.entityId, 10))
      .filter((id) => Number.isFinite(id));
    if (leadIds.length > 0) {
      const rows = await this.db
        .select({
          organizationId: leadPartyMap.organizationId,
          leadId: leadPartyMap.leadId,
          partyId: leadPartyMap.partyId,
        })
        .from(leadPartyMap)
        .where(
          and(inArray(leadPartyMap.organizationId, orgIds), inArray(leadPartyMap.leadId, leadIds)),
        );
      const byKey = new Map(rows.map((r) => [`${r.organizationId}:${r.leadId}`, r.partyId]));
      for (const enrollment of leadEnrollments) {
        const party = byKey.get(`${enrollment.orgId}:${parseInt(enrollment.entityId, 10)}`);
        if (party) partyByEnrollment.set(enrollment.id, party);
      }
    }

    const dealEnrollments = enrollments.filter((e) => e.entityType === "deal");
    const dealIds = dealEnrollments
      .map((e) => parseInt(e.entityId, 10))
      .filter((id) => Number.isFinite(id));
    if (dealIds.length > 0) {
      // `deals.party_id` rather than a map table: a deal carries its party
      // directly, so there is no legacy indirection to go through.
      const rows = await this.db
        .select({ orgId: deals.orgId, id: deals.id, partyId: deals.partyId })
        .from(deals)
        .where(and(inArray(deals.orgId, orgIds), inArray(deals.id, dealIds)));
      const byKey = new Map(rows.flatMap((r) => (r.partyId ? [[`${r.orgId}:${r.id}`, r.partyId] as const] : [])));
      for (const enrollment of dealEnrollments) {
        const party = byKey.get(`${enrollment.orgId}:${parseInt(enrollment.entityId, 10)}`);
        if (party) partyByEnrollment.set(enrollment.id, party);
      }
    }

    if (leadCheckIds.length > 0) {
      const rows = await this.db
        .select({ organizationId: leadPartyMap.organizationId, leadId: leadPartyMap.leadId })
        .from(leadPartyMap)
        .innerJoin(businessParties, PARTY_OF_LEAD)
        .where(and(inArray(leadPartyMap.leadId, leadCheckIds), isNotNull(businessParties.convertedAt)));
      for (const row of rows) {
        convertedLeadKeys.add(`${row.organizationId}:${row.leadId}`);
      }
    }

    let advanced = 0;
    let stopped = 0;

    for (const enrollment of enrollments) {
      try {
        const rawStopOn = seqStopOnMap.get(enrollment.sequenceId);
        if (rawStopOn && typeof rawStopOn === "object") {
          const { stop, reason } = this.evaluateStopOn(
            rawStopOn as Record<string, unknown>,
            enrollment,
            convertedLeadKeys,
          );
          if (stop) {
            await this.db
              .update(crmSequenceEnrollments)
              .set({ status: "stopped", stopReason: reason, updatedAt: new Date() })
              .where(eq(crmSequenceEnrollments.id, enrollment.id));
            stopped++;
            continue;
          }
        }

        const steps = stepsMap.get(enrollment.sequenceId) ?? [];
        const step = steps[enrollment.currentStep];

        if (!step) {
          await this.db
            .update(crmSequenceEnrollments)
            .set({ status: "completed", updatedAt: new Date() })
            .where(eq(crmSequenceEnrollments.id, enrollment.id));
          stopped++;
          continue;
        }

        /*
          Ticket 17. Every step is now decided before it acts, through the same
          guardrails every other outbound loop consults — which until this change
          was no loop at all: `evaluateGuardrails`, `crm_outbound_messages` and
          `autonomy_holds` were all built and had no production caller.
        */
        const partyId = partyByEnrollment.get(enrollment.id) ?? null;
        const config = readStepConfig(step.config);
        const recipient = typeof config.to === "string" ? config.to.trim() : "";
        const subject = typeof config.subject === "string" ? config.subject : "";
        const sends = stepSends(step.stepType);

        let sendFacts = null;
        let heardFromThem = false;
        if (sends) {
          /*
            A send we cannot attribute to a party is a send we cannot cap, and
            the frequency cap is per party across every loop. Blocking is the
            fail-closed direction and it makes the gap visible in the ledger
            rather than silently exempting whichever entity types the party map
            does not cover yet.
          */
          if (!partyId || !recipient) {
            stopped++;
            await this.db
              .update(crmSequenceEnrollments)
              .set({
                status: "stopped",
                stopReason: partyId ? "no_recipient_address" : "no_party_for_enrollment",
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(crmSequenceEnrollments.orgId, enrollment.orgId),
                  eq(crmSequenceEnrollments.id, enrollment.id),
                ),
              );
            continue;
          }

          const lastInbound = await this.outbound.lastInboundFrom(enrollment.orgId, partyId);
          heardFromThem = lastInbound !== null;
          sendFacts = await this.outbound.sendTimeFacts({
            orgId: enrollment.orgId,
            partyId,
            recipientEmail: recipient,
            outboundClass: this.outboundClassFor(heardFromThem),
            dealState: "open",
            draftedAt: enrollment.createdAt,
            deferralsSoFar: 0,
            now,
          });
        }

        const tick = evaluateSequenceTick(
          {
            now,
            sequenceActive: activeSequenceIds.has(enrollment.sequenceId),
            repliedAt: sendFacts?.repliedAt ?? null,
            enrolledAt: enrollment.createdAt,
            converted: convertedLeadKeys.has(
              `${enrollment.orgId}:${parseInt(enrollment.entityId, 10)}`,
            ),
            stepType: step.stepType,
          },
          sendFacts,
        );

        if (tick.kind === "exit") {
          await this.db
            .update(crmSequenceEnrollments)
            .set({
              status: tick.reason === "completed" ? "completed" : "stopped",
              stopReason: tick.reason,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(crmSequenceEnrollments.orgId, enrollment.orgId),
                eq(crmSequenceEnrollments.id, enrollment.id),
              ),
            );
          stopped++;
          continue;
        }

        if (tick.kind === "defer") {
          // The clock, not the recipient. The step stays where it is and is
          // retried when the recipient's working day opens.
          await this.db
            .update(crmSequenceEnrollments)
            .set({ nextRunAt: tick.notBefore, updatedAt: new Date() })
            .where(
              and(
                eq(crmSequenceEnrollments.orgId, enrollment.orgId),
                eq(crmSequenceEnrollments.id, enrollment.id),
              ),
            );
          continue;
        }

        if (tick.kind === "skip-step" && partyId) {
          // Recorded rather than dropped: a refusal that leaves no row is
          // indistinguishable from a step that never ran, and the two need
          // different answers when somebody asks why a customer went quiet.
          await this.outbound.recordBlocked({
            orgId: enrollment.orgId,
            partyId,
            dealId: null,
            outboundClass: this.outboundClassFor(heardFromThem),
            subject,
            reason: tick.reason,
          });
        } else if (tick.kind === "hold-send" && partyId && sendFacts) {
          const zone = resolveTimezone(sendFacts);
          await this.outbound.holdStep({
            orgId: enrollment.orgId,
            partyId,
            contactId: null,
            dealId: null,
            outboundClass: this.outboundClassFor(heardFromThem),
            subject,
            body: typeof config.body === "string" ? config.body : "",
            timezoneUsed: zone.timeZone,
            timezoneSource: zone.source,
            deferralsSoFar: sendFacts.deferralsSoFar,
            now,
          });
        } else if (tick.kind === "internal-step") {
          await this.executeStep(enrollment.orgId, step, enrollment.entityType, enrollment.entityId);
        }

        const isLastStep = enrollment.currentStep >= steps.length - 1;

        if (isLastStep) {
          await this.db
            .update(crmSequenceEnrollments)
            .set({ status: "completed", updatedAt: new Date() })
            .where(eq(crmSequenceEnrollments.id, enrollment.id));
          stopped++;
        } else {
          const nextStep = steps[enrollment.currentStep + 1];
          const waitMs = (nextStep?.waitHours ?? 0) * 60 * 60 * 1000;
          const nextRunAt = new Date(now.getTime() + waitMs);
          await this.db
            .update(crmSequenceEnrollments)
            .set({ currentStep: enrollment.currentStep + 1, nextRunAt, updatedAt: new Date() })
            .where(eq(crmSequenceEnrollments.id, enrollment.id));
          advanced++;
        }
      } catch (err) {
        logger.error("crm-sequences-runner: enrollment step failed", {
          enrollmentId: enrollment.id,
          cause: err,
        });
        await this.db
          .update(crmSequenceEnrollments)
          .set({
            status: "failed",
            stopReason: err instanceof Error ? err.message : "step_error",
            updatedAt: new Date(),
          })
          .where(eq(crmSequenceEnrollments.id, enrollment.id))
          .catch(logSideEffectFailure("crm-sequences: enrollment-failed status persist", { enrollmentId: enrollment.id }));
        stopped++;
      }
    }

    return { processed: enrollments.length, advanced, stopped };
  }

  private async executeStep(
    orgId: string,
    step: typeof crmSequenceSteps.$inferSelect,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const cfg = step.config ?? {};
    switch (step.stepType) {
      case "email": {
        await this.email.send(orgId, {
          to: String(cfg["to"] ?? ""),
          subject: String(cfg["subject"] ?? ""),
          html: String(cfg["body"] ?? ""),
        });
        return;
      }
      case "call_task": {
        const dueInDays = typeof cfg["dueInDays"] === "number" ? cfg["dueInDays"] : 1;
        await this.db.insert(tasks).values({
          orgId,
          title: String(cfg["taskTitle"] ?? "Follow-up call"),
          entityType: entityType.toUpperCase() as "LEAD" | "DEAL" | "CONTACT",
          entityId: parseInt(entityId, 10),
          type: "CALL",
          assigneeId: typeof cfg["assigneeId"] === "string" ? cfg["assigneeId"] : null,
          dueDate: new Date(Date.now() + dueInDays * 86400000),
        });
        return;
      }
      case "whatsapp_task": {
        await this.db.insert(tasks).values({
          orgId,
          title: String(cfg["taskTitle"] ?? "WhatsApp follow-up"),
          entityType: entityType.toUpperCase() as "LEAD" | "DEAL" | "CONTACT",
          entityId: parseInt(entityId, 10),
          type: "WHATSAPP",
          assigneeId: typeof cfg["assigneeId"] === "string" ? cfg["assigneeId"] : null,
          dueDate: new Date(Date.now() + 86400000),
        });
        return;
      }
      case "wait":
        return;
      default:
        return;
    }
  }
}
