import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { crmNurtureEnrollments, crmNurtureSequences } from "../../../db/schema";
import type { CursorPage } from "../../../common/pagination/cursor";
import { getPostgresErrorCode } from "../../../common/db/postgres-error";
import type {
  CreateNurtureSequenceInput,
  EnrolInNurtureSequenceInput,
  ListNurtureEnrollmentsQuery,
  ListNurtureSequencesQuery,
  ReplaceNurtureStepsInput,
  UpdateNurtureSequenceInput,
} from "./dto/nurture.schemas";
import { enrolInSequence, listEnrollmentsPage, unenrolFromSequence } from "./lib/nurture-enrolments";
import { countSteps, requireSequence } from "./lib/nurture-lookups";
import { getSequenceWithSteps, listSequencesPage } from "./lib/nurture-sequence-reads";
import { listSequenceSteps, replaceSequenceSteps } from "./lib/nurture-steps";
import type {
  NurtureEnrollmentView,
  NurtureSequenceSummary,
  NurtureStepView,
} from "./nurture-sequences.types";

export type {
  NurtureEnrollmentView,
  NurtureSequenceSummary,
  NurtureStepView,
} from "./nurture-sequences.types";

const UNIQUE_VIOLATION = "23505";

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
 *
 * The writes to a sequence stay here. Reading sequences is
 * `lib/nurture-sequence-reads.ts`, the cadence is `lib/nurture-steps.ts`,
 * enrolment is `lib/nurture-enrolments.ts`, and the existence checks all of
 * them lean on are `lib/nurture-lookups.ts`.
 */
@Injectable()
export class NurtureSequencesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  // ── Sequences ─────────────────────────────────────────────────────────────

  async list(
    organizationId: string,
    query: ListNurtureSequencesQuery,
  ): Promise<CursorPage<NurtureSequenceSummary>> {
    return listSequencesPage(this.db, organizationId, query);
  }

  async getOne(
    organizationId: string,
    nurtureSequenceId: string,
  ): Promise<{ sequence: NurtureSequenceSummary; steps: NurtureStepView[] }> {
    return getSequenceWithSteps(this.db, organizationId, nurtureSequenceId);
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
    await requireSequence(this.db, organizationId, nurtureSequenceId);

    /**
     * A sequence with no steps may not be activated.
     *
     * `resolveCadence` answers `no-steps` for it, so every enrolment made while
     * it was active would exit on its first wake — an operator would see a
     * sequence reporting itself as running and a list of enrolments that all
     * ended, with nothing saying the cadence was empty.
     */
    if (input.status === "active") {
      const steps = await countSteps(this.db, organizationId, [nurtureSequenceId]);
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

      const steps = await countSteps(this.db, organizationId, [nurtureSequenceId]);
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
    await requireSequence(this.db, organizationId, nurtureSequenceId);
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
    return listSequenceSteps(this.db, organizationId, nurtureSequenceId);
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
    return replaceSequenceSteps(this.db, organizationId, nurtureSequenceId, input);
  }

  // ── Enrolments ────────────────────────────────────────────────────────────

  async listEnrollments(
    organizationId: string,
    nurtureSequenceId: string,
    query: ListNurtureEnrollmentsQuery,
  ): Promise<CursorPage<NurtureEnrollmentView>> {
    return listEnrollmentsPage(this.db, organizationId, nurtureSequenceId, query);
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
    return enrolInSequence(this.db, organizationId, nurtureSequenceId, enrolledByUserId, input);
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
    return unenrolFromSequence(this.db, organizationId, nurtureSequenceId, nurtureEnrollmentId);
  }
}
