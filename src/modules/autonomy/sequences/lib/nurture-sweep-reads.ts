/**
 * The four reads a sweep tick needs, batched: the live enrolments with the
 * state of their sequence, the cadence behind them, when each last attempted a
 * step, and when each party last wrote back.
 *
 * Four statements per organisation per tick however many enrolments there
 * are; everything `NurtureStepSenderService.runDueStepsForOrg` decides after
 * them is pure.
 */
import { and, asc, eq, inArray, isNotNull, max } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.types";
import {
  crmNurtureEnrollments,
  crmNurtureSequenceSteps,
  crmNurtureSequences,
  crmNurtureStepAttempts,
  relationshipStates,
} from "../../../../db/schema";
import type { CadenceStep } from "../nurture-cadence";
import type { NurtureCandidate } from "../nurture-step-sender.types";

/**
 * How many live enrolments one organisation is examined for per tick.
 *
 * Examining is cheap — four batched reads, then pure functions — so this is a
 * page size rather than a bill. Oldest enrolment first, so a tenant over the cap
 * makes progress from the front rather than starving whoever has been waiting
 * longest.
 */
const PER_ORG_CANDIDATES = 200;

/**
 * Live enrolments with the state of the sequence behind them.
 *
 * Deliberately not filtered to active sequences. A paused or deleted one still
 * has to be looked at, because looking at it is how its enrolments exit — and
 * `resolveCadence` needs the sequence's status to say so with the right reason.
 */
export async function loadCandidates(db: Db, organizationId: string): Promise<NurtureCandidate[]> {
  return db
    .select({
      nurtureEnrollmentId: crmNurtureEnrollments.nurtureEnrollmentId,
      nurtureSequenceId: crmNurtureEnrollments.nurtureSequenceId,
      partyId: crmNurtureEnrollments.partyId,
      dealId: crmNurtureEnrollments.dealId,
      currentStep: crmNurtureEnrollments.currentStep,
      enrolledAt: crmNurtureEnrollments.enrolledAt,
      updatedAt: crmNurtureEnrollments.updatedAt,
      sequenceStatus: crmNurtureSequences.status,
      sequenceDeletedAt: crmNurtureSequences.deletedAt,
    })
    .from(crmNurtureEnrollments)
    .innerJoin(
      crmNurtureSequences,
      and(
        eq(crmNurtureSequences.nurtureSequenceId, crmNurtureEnrollments.nurtureSequenceId),
        eq(crmNurtureSequences.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(crmNurtureEnrollments.organizationId, organizationId),
        eq(crmNurtureEnrollments.status, "active"),
      ),
    )
    .orderBy(asc(crmNurtureEnrollments.enrolledAt))
    .limit(PER_ORG_CANDIDATES);
}

export async function loadSteps(
  db: Db,
  organizationId: string,
  candidates: readonly NurtureCandidate[],
): Promise<Map<string, CadenceStep[]>> {
  const sequenceIds = [...new Set(candidates.map((c) => c.nurtureSequenceId))];

  const rows = await db
    .select({
      nurtureSequenceId: crmNurtureSequenceSteps.nurtureSequenceId,
      stepNumber: crmNurtureSequenceSteps.stepNumber,
      waitHours: crmNurtureSequenceSteps.waitHours,
    })
    .from(crmNurtureSequenceSteps)
    .where(
      and(
        eq(crmNurtureSequenceSteps.organizationId, organizationId),
        inArray(crmNurtureSequenceSteps.nurtureSequenceId, sequenceIds),
      ),
    )
    .orderBy(asc(crmNurtureSequenceSteps.stepNumber));

  const bySequence = new Map<string, CadenceStep[]>();
  for (const row of rows) {
    const existing = bySequence.get(row.nurtureSequenceId);
    const step: CadenceStep = { stepNumber: row.stepNumber, waitHours: row.waitHours };
    if (existing) existing.push(step);
    else bySequence.set(row.nurtureSequenceId, [step]);
  }

  return bySequence;
}

/** When each enrolment last attempted anything, in one grouped read. */
export async function loadLastAttempts(
  db: Db,
  organizationId: string,
  candidates: readonly NurtureCandidate[],
): Promise<Map<string, Date>> {
  const rows = await db
    .select({
      nurtureEnrollmentId: crmNurtureStepAttempts.nurtureEnrollmentId,
      lastAt: max(crmNurtureStepAttempts.createdAt),
    })
    .from(crmNurtureStepAttempts)
    .where(
      and(
        eq(crmNurtureStepAttempts.organizationId, organizationId),
        inArray(
          crmNurtureStepAttempts.nurtureEnrollmentId,
          candidates.map((c) => c.nurtureEnrollmentId),
        ),
      ),
    )
    .groupBy(crmNurtureStepAttempts.nurtureEnrollmentId);

  const byEnrolment = new Map<string, Date>();
  for (const row of rows) if (row.lastAt) byEnrolment.set(row.nurtureEnrollmentId, row.lastAt);
  return byEnrolment;
}

/**
 * `relationship_states.last_inbound_at`, read directly and in one statement.
 *
 * The platform's existing answer to "have they said anything to us", and the
 * same column `OutboundService.sendTimeFacts` reads for its own reply
 * guardrail — `nurture-cadence.ts` names it explicitly rather than letting a
 * second definition of "a reply" grow beside it. Read here rather than through
 * `RelationshipStateService.read`, which answers for one anchor at a time and
 * would make a sweep over two hundred enrolments two hundred queries.
 */
export async function loadLastInbound(
  db: Db,
  organizationId: string,
  candidates: readonly NurtureCandidate[],
): Promise<Map<string, Date>> {
  const rows = await db
    .select({
      partyId: relationshipStates.partyId,
      lastInboundAt: relationshipStates.lastInboundAt,
    })
    .from(relationshipStates)
    .where(
      and(
        eq(relationshipStates.organizationId, organizationId),
        isNotNull(relationshipStates.partyId),
        isNotNull(relationshipStates.lastInboundAt),
        inArray(
          relationshipStates.partyId,
          candidates.map((c) => c.partyId),
        ),
      ),
    );

  const byParty = new Map<string, Date>();
  for (const row of rows) {
    if (!row.partyId || !row.lastInboundAt) continue;
    /**
     * The latest, where a party is anchored more than once.
     *
     * `relationship_states` is an exclusive arc — a row is anchored to a party
     * or to a deal — and nothing stops a party carrying several rows. Taking
     * whichever the scan returned last would make "have they replied" depend
     * on row order, and the safe reading of a reply is the most recent one.
     */
    const known = byParty.get(row.partyId);
    if (!known || row.lastInboundAt > known) byParty.set(row.partyId, row.lastInboundAt);
  }

  return byParty;
}
