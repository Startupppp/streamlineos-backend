import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { NurtureSequencesService } from "./nurture-sequences.service";
import {
  createNurtureSequenceSchema,
  enrolInNurtureSequenceSchema,
  listNurtureEnrollmentsQuerySchema,
  listNurtureSequencesQuerySchema,
  replaceNurtureStepsSchema,
  updateNurtureSequenceSchema,
  type CreateNurtureSequenceInput,
  type EnrolInNurtureSequenceInput,
  type ListNurtureEnrollmentsQuery,
  type ListNurtureSequencesQuery,
  type ReplaceNurtureStepsInput,
  type UpdateNurtureSequenceInput,
} from "./dto/nurture.schemas";

/**
 * Authoring a cadence, and putting a customer into one.
 *
 * Under `crm/autonomy` rather than beside `crm/sequences`, because the two are
 * different engines over different tables and a shared prefix would invite the
 * assumption that a step means the same thing in both. It does not:
 * `crm/automation-studio`'s step carries a subject and a body and sends them,
 * and a step here carries a wait and nothing else — the message is
 * `composeAndHold`'s to write, judge and hold. `nurture-sequences.ts` has the
 * full argument.
 *
 * Gated on `crm:autonomy:view` and `crm:autonomy:manage`, the same pair
 * `OutboundController` and `AutonomyReviewController` use, and for the same
 * reason `OutboundController` sets out: enrolling somebody schedules autonomous
 * messages, which is precisely what `manage` already governs, and a key of its
 * own would need a catalogue entry in both repos plus a backfill for every
 * organisation that already exists — an uncatalogued key is a silent
 * 403-by-signup-date.
 *
 * There is no route here that sends a step, skips a wait or shortens a hold. The
 * sweep is the only thing that advances a cadence and `composeAndHold` is the
 * only thing that writes a message; an endpoint that did either would make the
 * guardrails optional for whoever knew about it.
 */
@Controller("crm/autonomy/nurture")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class NurtureSequencesController {
  constructor(private readonly sequences: NurtureSequencesService) {}

  @Get("sequences")
  @RequirePermission("crm:autonomy:view")
  list(
    @Query(new ZodValidationPipe(listNurtureSequencesQuerySchema)) query: ListNurtureSequencesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.list(u.orgId, query);
  }

  @Post("sequences")
  @HttpCode(201)
  @Idempotent("crm.autonomy.nurture-sequence-create")
  @RequirePermission("crm:autonomy:manage")
  create(
    @Body(new ZodValidationPipe(createNurtureSequenceSchema)) body: CreateNurtureSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.create(u.orgId, u.userId, body);
  }

  @Get("sequences/:nurtureSequenceId")
  @RequirePermission("crm:autonomy:view")
  getOne(
    @Param("nurtureSequenceId") nurtureSequenceId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.getOne(u.orgId, nurtureSequenceId);
  }

  @Patch("sequences/:nurtureSequenceId")
  @Idempotent("crm.autonomy.nurture-sequence-update")
  @RequirePermission("crm:autonomy:manage")
  update(
    @Param("nurtureSequenceId") nurtureSequenceId: string,
    @Body(new ZodValidationPipe(updateNurtureSequenceSchema)) body: UpdateNurtureSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.update(u.orgId, nurtureSequenceId, body);
  }

  @Delete("sequences/:nurtureSequenceId")
  @RequirePermission("crm:autonomy:manage")
  remove(
    @Param("nurtureSequenceId") nurtureSequenceId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.remove(u.orgId, nurtureSequenceId);
  }

  /**
   * `PUT`, because the body is the entire cadence rather than a change to it —
   * step numbers have to be dense and no per-step edit can promise that without
   * a read-modify-write two concurrent editors would interleave into a gap.
   */
  @Put("sequences/:nurtureSequenceId/steps")
  @Idempotent("crm.autonomy.nurture-steps-replace")
  @RequirePermission("crm:autonomy:manage")
  replaceSteps(
    @Param("nurtureSequenceId") nurtureSequenceId: string,
    @Body(new ZodValidationPipe(replaceNurtureStepsSchema)) body: ReplaceNurtureStepsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.replaceSteps(u.orgId, nurtureSequenceId, body);
  }

  @Get("sequences/:nurtureSequenceId/enrollments")
  @RequirePermission("crm:autonomy:view")
  listEnrollments(
    @Param("nurtureSequenceId") nurtureSequenceId: string,
    @Query(new ZodValidationPipe(listNurtureEnrollmentsQuerySchema))
    query: ListNurtureEnrollmentsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.listEnrollments(u.orgId, nurtureSequenceId, query);
  }

  /**
   * Idempotent, because a retried POST must not become two enrolments.
   *
   * `uniq_crm_nurture_enrollments_live_party` catches the duplicate too, but it
   * protects one *party* rather than one request: a client retrying a timeout
   * would get a 409 saying the customer is already enrolled, which is true and
   * useless — it cannot tell that from somebody else having enrolled them.
   */
  @Post("sequences/:nurtureSequenceId/enrollments")
  @HttpCode(201)
  @Idempotent("crm.autonomy.nurture-enrol")
  @RequirePermission("crm:autonomy:manage")
  enrol(
    @Param("nurtureSequenceId") nurtureSequenceId: string,
    @Body(new ZodValidationPipe(enrolInNurtureSequenceSchema)) body: EnrolInNurtureSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.enrol(u.orgId, nurtureSequenceId, u.userId, body);
  }

  @Delete("sequences/:nurtureSequenceId/enrollments/:nurtureEnrollmentId")
  @RequirePermission("crm:autonomy:manage")
  unenrol(
    @Param("nurtureSequenceId") nurtureSequenceId: string,
    @Param("nurtureEnrollmentId") nurtureEnrollmentId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.unenrol(u.orgId, nurtureSequenceId, nurtureEnrollmentId);
  }
}
