import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import {
  businessParties,
  crmNurtureEnrollments,
  crmNurtureSequenceSteps,
  crmNurtureSequences,
  deals,
} from "../../../db/schema";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../common/pagination/cursor";
import { keysetBefore } from "../../../common/pagination/keyset";
import { getPostgresErrorCode } from "../../../common/db/postgres-error";
import { partyNamesFor } from "../../party/party-names";
import { clampWaitHours, stepNumbersAreDense } from "./nurture-cadence";
import type {
  CreateNurtureSequenceInput,
  EnrolInNurtureSequenceInput,
  ListNurtureEnrollmentsQuery,
  ListNurtureSequencesQuery,
  ReplaceNurtureStepsInput,
  UpdateNurtureSequenceInput,
} from "./dto/nurture.schemas";

const UNIQUE_VIOLATION = "23505";

export interface NurtureSequenceSummary {
  readonly nurtureSequenceId: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly stepCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NurtureStepView {
  readonly nurtureStepId: string;
  readonly stepNumber: number;
  /** As stored. `clampWaitHours` is what the sender actually waits — see below. */
  readonly waitHours: number;
}

export interface NurtureEnrollmentView {
  readonly nurtureEnrollmentId: string;
  readonly nurtureSequenceId: string;
  readonly partyId: string;
  /**
   * Resolved here rather than left to the caller.
   *
   * A screen may not render a raw id, so returning `partyId` alone forces every
   * caller to go and find the name — which is one request per row, or a
   * first-page lookup that silently degrades to "a customer you can't see" for
   * anybody further down the list. `partyNamesFor` answers the whole page in one
   * indexed query, which is what `autonomy-review.service.ts` already does for
   * the decision feed. Null only when the party is gone.
   */
  readonly partyName: string | null;
  readonly dealId: number | null;
  readonly dealName: string | null;
  readonly status: string;
  readonly currentStep: number;
  readonly exitReason: string | null;
  readonly exitedAt: Date | null;
  readonly enrolledAt: Date;
}

/**
 * The door into the nurture engine: authoring a cadence and putting somebody in
 * one.
 *
 * Everything here is bookkeeping. Not one method decides whether a message may
 * be sent, what it says, or when it is safe to say it — `nurture-cadence.ts`
 * owns the timing rules and `OutboundService.composeAndHold` owns every
 * judgement about the message itself. This service's whole job is to keep the
 * four tables truthful so those two can be trusted, which is why it refuses at
 * enrolment the states that would otherwise produce an enrolment guaranteed to
 * die on its first wake.
 */
@Injectable()
export class NurtureSequencesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  // ── Sequences ─────────────────────────────────────────────────────────────

  async list(
    organizationId: string,
    query: ListNurtureSequencesQuery,
  ): Promise<CursorPage<NurtureSequenceSummary>> {
    const position = decodeCursor(query.cursor);

    const rows = await this.db
      .select({
        nurtureSequenceId: crmNurtureSequences.nurtureSequenceId,
        name: crmNurtureSequences.name,
        description: crmNurtureSequences.description,
        status: crmNurtureSequences.status,
        createdAt: crmNurtureSequences.createdAt,
        updatedAt: crmNurtureSequences.updatedAt,
      })
      .from(crmNurtureSequences)
      .where(
        and(
          eq(crmNurtureSequences.organizationId, organizationId),
          isNull(crmNurtureSequences.deletedAt),
          query.status ? eq(crmNurtureSequences.status, query.status) : undefined,
          position
            ? keysetBefore(
                crmNurtureSequences.createdAt,
                crmNurtureSequences.nurtureSequenceId,
                position,
              )
            : undefined,
        ),
      )
      .orderBy(desc(crmNurtureSequences.createdAt), desc(crmNurtureSequences.nurtureSequenceId))
      .limit(query.limit + 1);

    /**
     * The step count in one grouped read over the page, not one read per row.
     *
     * A cadence rendered without its length is unreadable — "Post-demo" says
     * nothing about whether it is two touches or twelve — but asking per
     * sequence would make the list N+1 for a number that costs one query.
     */
    const stepCounts = await this.countSteps(
      organizationId,
      rows.map((row) => row.nurtureSequenceId),
    );

    return buildCursorPage(
      rows.map((row) => ({ ...row, stepCount: stepCounts.get(row.nurtureSequenceId) ?? 0 })),
      query.limit,
      (row) => ({ sortValue: row.createdAt.toISOString(), id: row.nurtureSequenceId }),
    );
  }

  async getOne(
    organizationId: string,
    nurtureSequenceId: string,
  ): Promise<{ sequence: NurtureSequenceSummary; steps: NurtureStepView[] }> {
    const sequence = await this.requireSequence(organizationId, nurtureSequenceId);
    const steps = await this.listSteps(organizationId, nurtureSequenceId);

    return {
      sequence: { ...sequence, stepCount: steps.length },
      steps,
    };
  }

  async create(
    organizationId: string,
    createdByUserId: string,
    input: CreateNurtureSequenceInput,
  ): Promise<NurtureSequenceSummary> {
    try {
      const [created] = await this.db
        .insert(crmNurtureSequences)
        .values({
          organizationId,
          name: input.name,
          description: input.description ?? null,
          createdByUserId,
        })
        .returning({
          nurtureSequenceId: crmNurtureSequences.nurtureSequenceId,
          name: crmNurtureSequences.name,
          description: crmNurtureSequences.description,
          status: crmNurtureSequences.status,
          createdAt: crmNurtureSequences.createdAt,
          updatedAt: crmNurtureSequences.updatedAt,
        });

      // A sequence is born `draft` with no steps; both are what `replaceSteps`
      // and the status change are for.
      return { ...created, stepCount: 0 };
    } catch (error) {
      /**
       * `uniq_crm_nurture_sequences_name`, reported as the conflict it is.
       *
       * The SQLSTATE is on `.cause` — Drizzle wraps the driver error, so the
       * `err.code === "23505"` written directly against the caught value is
       * always false and the conflict escapes as a 500.
       */
      if (getPostgresErrorCode(error) === UNIQUE_VIOLATION)
        throw new ConflictException("A sequence with that name already exists");
      throw error;
    }
  }

  async update(
    organizationId: string,
    nurtureSequenceId: string,
    input: UpdateNurtureSequenceInput,
  ): Promise<NurtureSequenceSummary> {
    await this.requireSequence(organizationId, nurtureSequenceId);

    /**
     * A sequence with no steps may not be activated.
     *
     * `resolveCadence` answers `no-steps` for it, so every enrolment made while
     * it was active would exit on its first wake — an operator would see a
     * sequence reporting itself as running and a list of enrolments that all
     * ended, with nothing saying the cadence was empty.
     */
    if (input.status === "active") {
      const steps = await this.countSteps(organizationId, [nurtureSequenceId]);
      if ((steps.get(nurtureSequenceId) ?? 0) === 0)
        throw new BadRequestException("Add at least one step before activating this sequence");
    }

    try {
      const [updated] = await this.db
        .update(crmNurtureSequences)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.status === undefined ? {} : { status: input.status }),
        })
        .where(
          and(
            eq(crmNurtureSequences.organizationId, organizationId),
            eq(crmNurtureSequences.nurtureSequenceId, nurtureSequenceId),
            isNull(crmNurtureSequences.deletedAt),
          ),
        )
        .returning({
          nurtureSequenceId: crmNurtureSequences.nurtureSequenceId,
          name: crmNurtureSequences.name,
          description: crmNurtureSequences.description,
          status: crmNurtureSequences.status,
          createdAt: crmNurtureSequences.createdAt,
          updatedAt: crmNurtureSequences.updatedAt,
        });

      if (!updated) throw new NotFoundException("Sequence not found");

      const steps = await this.countSteps(organizationId, [nurtureSequenceId]);
      return { ...updated, stepCount: steps.get(nurtureSequenceId) ?? 0 };
    } catch (error) {
      if (getPostgresErrorCode(error) === UNIQUE_VIOLATION)
        throw new ConflictException("A sequence with that name already exists");
      throw error;
    }
  }

  /**
   * Soft delete, and let go of the people it was holding.
   *
   * The exit is not deferred to the next wake even though `resolveCadence`
   * would answer `sequence-deleted` there. `uniq_crm_nurture_enrollments_live_party`
   * is a tenant-wide lock on the party — one live enrolment across every
   * sequence — so a deleted sequence's leftover enrolments would go on refusing
   * every attempt to nurture those people from anywhere else, for as long as
   * the cadence's remaining wait, with no surface saying why.
   */
  async remove(
    organizationId: string,
    nurtureSequenceId: string,
  ): Promise<{ deleted: true; exitedEnrollments: number }> {
    await this.requireSequence(organizationId, nurtureSequenceId);
    const now = new Date();

    return this.db.transaction(async (tx) => {
      const [deleted] = await tx
        .update(crmNurtureSequences)
        .set({ deletedAt: now })
        .where(
          and(
            eq(crmNurtureSequences.organizationId, organizationId),
            eq(crmNurtureSequences.nurtureSequenceId, nurtureSequenceId),
            isNull(crmNurtureSequences.deletedAt),
          ),
        )
        .returning({ id: crmNurtureSequences.nurtureSequenceId });

      if (!deleted) throw new NotFoundException("Sequence not found");

      const exited = await tx
        .update(crmNurtureEnrollments)
        .set({ status: "exited", exitReason: "sequence-deleted", exitedAt: now })
        .where(
          and(
            eq(crmNurtureEnrollments.organizationId, organizationId),
            eq(crmNurtureEnrollments.nurtureSequenceId, nurtureSequenceId),
            // Only the live ones. A row already `exited` carries somebody
            // else's reason — a reply, most importantly — and overwriting it
            // would lose the one fact the feature is measured on.
            eq(crmNurtureEnrollments.status, "active"),
          ),
        )
        .returning({ id: crmNurtureEnrollments.nurtureEnrollmentId });

      return { deleted: true as const, exitedEnrollments: exited.length };
    });
  }

  // ── Steps ─────────────────────────────────────────────────────────────────

  async listSteps(
    organizationId: string,
    nurtureSequenceId: string,
  ): Promise<NurtureStepView[]> {
    return this.db
      .select({
        nurtureStepId: crmNurtureSequenceSteps.nurtureStepId,
        stepNumber: crmNurtureSequenceSteps.stepNumber,
        waitHours: crmNurtureSequenceSteps.waitHours,
      })
      .from(crmNurtureSequenceSteps)
      .where(
        and(
          eq(crmNurtureSequenceSteps.organizationId, organizationId),
          eq(crmNurtureSequenceSteps.nurtureSequenceId, nurtureSequenceId),
        ),
      )
      .orderBy(asc(crmNurtureSequenceSteps.stepNumber));
  }

  /**
   * The whole cadence at once, replaced rather than edited.
   *
   * Step numbers come from the array's order, so density is a property of the
   * derivation rather than of the input — and `stepNumbersAreDense` is still
   * asserted, because that derivation is exactly the kind of thing a later edit
   * changes without noticing what depends on it. A gap makes `waitMsForStep`
   * return zero and the sender fire two messages back to back.
   */
  async replaceSteps(
    organizationId: string,
    nurtureSequenceId: string,
    input: ReplaceNurtureStepsInput,
  ): Promise<NurtureStepView[]> {
    await this.requireSequence(organizationId, nurtureSequenceId);

    const steps = input.steps.map((step, index) => ({
      stepNumber: index + 1,
      waitHours: step.waitHours,
    }));

    if (!stepNumbersAreDense(steps))
      throw new BadRequestException("Steps must be numbered from 1 with no gaps");

    return this.db.transaction(async (tx) => {
      /**
       * A hard DELETE, which the soft-delete default does not cover: a step is a
       * child row of the cadence with no history of its own, and the record that
       * a step happened lives in `crm_nurture_step_attempts` rather than here.
       */
      await tx
        .delete(crmNurtureSequenceSteps)
        .where(
          and(
            eq(crmNurtureSequenceSteps.organizationId, organizationId),
            eq(crmNurtureSequenceSteps.nurtureSequenceId, nurtureSequenceId),
          ),
        );

      if (steps.length === 0) return [];

      return tx
        .insert(crmNurtureSequenceSteps)
        .values(
          steps.map((step) => ({
            organizationId,
            nurtureSequenceId,
            stepNumber: step.stepNumber,
            /**
             * Clamped on the way in as well as on the way out.
             *
             * `waitMsForStep` clamps at read time because it has to — rows
             * written before the floor moved are still in the table — but a
             * value stored below the floor would show an operator a cadence
             * their sequence does not actually run.
             */
            waitHours: clampWaitHours(step.waitHours),
          })),
        )
        .returning({
          nurtureStepId: crmNurtureSequenceSteps.nurtureStepId,
          stepNumber: crmNurtureSequenceSteps.stepNumber,
          waitHours: crmNurtureSequenceSteps.waitHours,
        });
    });
  }

  // ── Enrolments ────────────────────────────────────────────────────────────

  async listEnrollments(
    organizationId: string,
    nurtureSequenceId: string,
    query: ListNurtureEnrollmentsQuery,
  ): Promise<CursorPage<NurtureEnrollmentView>> {
    await this.requireSequence(organizationId, nurtureSequenceId);
    const position = decodeCursor(query.cursor);

    const rows = await this.db
      .select({
        nurtureEnrollmentId: crmNurtureEnrollments.nurtureEnrollmentId,
        nurtureSequenceId: crmNurtureEnrollments.nurtureSequenceId,
        partyId: crmNurtureEnrollments.partyId,
        dealId: crmNurtureEnrollments.dealId,
        status: crmNurtureEnrollments.status,
        currentStep: crmNurtureEnrollments.currentStep,
        exitReason: crmNurtureEnrollments.exitReason,
        exitedAt: crmNurtureEnrollments.exitedAt,
        enrolledAt: crmNurtureEnrollments.enrolledAt,
      })
      .from(crmNurtureEnrollments)
      .where(
        and(
          eq(crmNurtureEnrollments.organizationId, organizationId),
          eq(crmNurtureEnrollments.nurtureSequenceId, nurtureSequenceId),
          query.status ? eq(crmNurtureEnrollments.status, query.status) : undefined,
          position
            ? keysetBefore(
                crmNurtureEnrollments.enrolledAt,
                crmNurtureEnrollments.nurtureEnrollmentId,
                position,
              )
            : undefined,
        ),
      )
      .orderBy(
        desc(crmNurtureEnrollments.enrolledAt),
        desc(crmNurtureEnrollments.nurtureEnrollmentId),
      )
      .limit(query.limit + 1);

    /**
     * Two lookups for the whole page, after the keyset read rather than joined
     * into it: a join would multiply nothing here, but it would put two more
     * tables inside the ordering the cursor depends on.
     */
    const [partyNames, dealNames] = await Promise.all([
      partyNamesFor(this.db, organizationId, rows.map((row) => row.partyId)),
      this.dealNamesFor(organizationId, rows.map((row) => row.dealId)),
    ]);

    const named = rows.map((row) => ({
      ...row,
      partyName: partyNames.get(row.partyId) ?? null,
      dealName: row.dealId === null ? null : (dealNames.get(row.dealId) ?? null),
    }));

    return buildCursorPage(named, query.limit, (row) => ({
      sortValue: row.enrolledAt.toISOString(),
      id: row.nurtureEnrollmentId,
    }));
  }

  /** Names for one page of enrolments. Soft-deleted deals still have a name. */
  private async dealNamesFor(
    organizationId: string,
    dealIds: readonly (number | null)[],
  ): Promise<Map<number, string>> {
    const ids = [...new Set(dealIds.filter((id): id is number => id !== null))];
    if (ids.length === 0) return new Map();

    const rows = await this.db
      .select({ id: deals.id, name: deals.name })
      .from(deals)
      .where(and(eq(deals.orgId, organizationId), inArray(deals.id, ids)));

    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /**
   * Put somebody into a cadence, having first refused the enrolments that could
   * only end badly.
   *
   * Each refusal below is a state `resolveCadence` would answer at the first
   * wake — `sequence-paused` for a draft or paused sequence, `no-steps` for an
   * empty one — and answering it here instead is the difference between telling
   * a person now and showing them an enrolment that quietly ended days later
   * for a reason they have to go and look up.
   */
  async enrol(
    organizationId: string,
    nurtureSequenceId: string,
    enrolledByUserId: string,
    input: EnrolInNurtureSequenceInput,
  ): Promise<NurtureEnrollmentView> {
    const sequence = await this.requireSequence(organizationId, nurtureSequenceId);

    if (sequence.status !== "active")
      throw new BadRequestException("Activate the sequence before enrolling anybody in it");

    const stepCounts = await this.countSteps(organizationId, [nurtureSequenceId]);
    if ((stepCounts.get(nurtureSequenceId) ?? 0) === 0)
      throw new BadRequestException("This sequence has no steps");

    await this.requireParty(organizationId, input.partyId);
    const dealId = input.dealId === undefined ? null : await this.requireDeal(organizationId, input.dealId);

    try {
      const [enrolled] = await this.db
        .insert(crmNurtureEnrollments)
        .values({
          organizationId,
          nurtureSequenceId,
          partyId: input.partyId,
          dealId,
          enrolledByUserId,
        })
        .returning({
          nurtureEnrollmentId: crmNurtureEnrollments.nurtureEnrollmentId,
          nurtureSequenceId: crmNurtureEnrollments.nurtureSequenceId,
          partyId: crmNurtureEnrollments.partyId,
          dealId: crmNurtureEnrollments.dealId,
          status: crmNurtureEnrollments.status,
          currentStep: crmNurtureEnrollments.currentStep,
          exitReason: crmNurtureEnrollments.exitReason,
          exitedAt: crmNurtureEnrollments.exitedAt,
          enrolledAt: crmNurtureEnrollments.enrolledAt,
        });

      return this.withNames(organizationId, enrolled);
    } catch (error) {
      /**
       * `uniq_crm_nurture_enrollments_live_party`: one live enrolment per party
       * across the whole tenant, refused here where a person can be told rather
       * than blunted later by the frequency cap.
       */
      if (getPostgresErrorCode(error) === UNIQUE_VIOLATION)
        throw new ConflictException("That customer is already in a nurture sequence");
      throw error;
    }
  }

  /**
   * Take somebody out by hand, recorded as `manual-stop`.
   *
   * Conditional on the enrolment still being active, for the reason
   * `SequenceReplyExitService` gives for the same predicate: a row that has
   * already exited carries a reason somebody or something else established, and
   * replacing `replied` with `manual-stop` loses the fact the tenant most needs.
   */
  async unenrol(
    organizationId: string,
    nurtureSequenceId: string,
    nurtureEnrollmentId: string,
  ): Promise<NurtureEnrollmentView> {
    const [updated] = await this.db
      .update(crmNurtureEnrollments)
      .set({ status: "exited", exitReason: "manual-stop", exitedAt: new Date() })
      .where(
        and(
          eq(crmNurtureEnrollments.organizationId, organizationId),
          eq(crmNurtureEnrollments.nurtureSequenceId, nurtureSequenceId),
          eq(crmNurtureEnrollments.nurtureEnrollmentId, nurtureEnrollmentId),
          eq(crmNurtureEnrollments.status, "active"),
        ),
      )
      .returning({
        nurtureEnrollmentId: crmNurtureEnrollments.nurtureEnrollmentId,
        nurtureSequenceId: crmNurtureEnrollments.nurtureSequenceId,
        partyId: crmNurtureEnrollments.partyId,
        dealId: crmNurtureEnrollments.dealId,
        status: crmNurtureEnrollments.status,
        currentStep: crmNurtureEnrollments.currentStep,
        exitReason: crmNurtureEnrollments.exitReason,
        exitedAt: crmNurtureEnrollments.exitedAt,
        enrolledAt: crmNurtureEnrollments.enrolledAt,
      });

    /**
     * 404 rather than 403 or 409, and for a row in another tenant that is the
     * whole point: a 403 on somebody else's identifier confirms it exists.
     * An enrolment that has already stopped reads the same way, which is
     * honest — there is no live enrolment here to stop.
     */
    if (!updated) throw new NotFoundException("No active enrolment to stop");

    return this.withNames(organizationId, updated);
  }

  /**
   * One enrolment's names. The page read resolves a whole page at once; this is
   * the single-row path, where two indexed lookups are cheaper than making the
   * caller go and find a name it will certainly need.
   */
  private async withNames(
    organizationId: string,
    row: Omit<NurtureEnrollmentView, "partyName" | "dealName">,
  ): Promise<NurtureEnrollmentView> {
    const [partyNames, dealNames] = await Promise.all([
      partyNamesFor(this.db, organizationId, [row.partyId]),
      this.dealNamesFor(organizationId, [row.dealId]),
    ]);

    return {
      ...row,
      partyName: partyNames.get(row.partyId) ?? null,
      dealName: row.dealId === null ? null : (dealNames.get(row.dealId) ?? null),
    };
  }

  // ── Reads the rest of this file leans on ──────────────────────────────────

  private async requireSequence(
    organizationId: string,
    nurtureSequenceId: string,
  ): Promise<Omit<NurtureSequenceSummary, "stepCount">> {
    const [sequence] = await this.db
      .select({
        nurtureSequenceId: crmNurtureSequences.nurtureSequenceId,
        name: crmNurtureSequences.name,
        description: crmNurtureSequences.description,
        status: crmNurtureSequences.status,
        createdAt: crmNurtureSequences.createdAt,
        updatedAt: crmNurtureSequences.updatedAt,
      })
      .from(crmNurtureSequences)
      .where(
        and(
          eq(crmNurtureSequences.organizationId, organizationId),
          eq(crmNurtureSequences.nurtureSequenceId, nurtureSequenceId),
          isNull(crmNurtureSequences.deletedAt),
        ),
      )
      .limit(1);

    if (!sequence) throw new NotFoundException("Sequence not found");
    return sequence;
  }

  private async requireParty(organizationId: string, partyId: string): Promise<void> {
    const [party] = await this.db
      .select({ partyId: businessParties.partyId })
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          eq(businessParties.partyId, partyId),
          isNull(businessParties.deletedAt),
        ),
      )
      .limit(1);

    if (!party) throw new NotFoundException("Customer not found");
  }

  /**
   * Resolves the wire's string to the integer the column holds.
   *
   * The existence check is not decoration: `deal_id` carries a foreign key, so
   * an unknown deal would fail on the insert as a `23503` and reach the caller
   * as a 500 rather than as the 404 it is.
   */
  private async requireDeal(organizationId: string, dealId: string): Promise<number> {
    const numeric = Number(dealId);

    const [deal] = await this.db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.orgId, organizationId), eq(deals.id, numeric), isNull(deals.deletedAt)))
      .limit(1);

    if (!deal) throw new NotFoundException("Deal not found");
    return deal.id;
  }

  private async countSteps(
    organizationId: string,
    nurtureSequenceIds: string[],
  ): Promise<Map<string, number>> {
    if (nurtureSequenceIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        nurtureSequenceId: crmNurtureSequenceSteps.nurtureSequenceId,
        steps: count(),
      })
      .from(crmNurtureSequenceSteps)
      .where(
        and(
          eq(crmNurtureSequenceSteps.organizationId, organizationId),
          inArray(crmNurtureSequenceSteps.nurtureSequenceId, nurtureSequenceIds),
        ),
      )
      .groupBy(crmNurtureSequenceSteps.nurtureSequenceId);

    return new Map(rows.map((row) => [row.nurtureSequenceId, Number(row.steps)]));
  }
}
