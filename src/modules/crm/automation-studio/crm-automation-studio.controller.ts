import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { CrmSequencesService } from "./crm-sequences.service";
import {
  createSequenceSchema,
  updateSequenceSchema,
  createSequenceStepSchema,
  reorderSequenceStepsSchema,
  enrollInSequenceSchema,
  type CreateSequenceInput,
  type UpdateSequenceInput,
  type CreateSequenceStepInput,
  type ReorderSequenceStepsInput,
  type EnrollInSequenceInput,
} from "./dto/automation-studio.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const sequenceIdParams = z.object({ sequenceId: z.string().min(1) }).strict();
const sequenceIdstepIdParams = z.object({ sequenceId: z.string().min(1), stepId: z.string().min(1) }).strict();
const sequenceIdenrollmentIdParams = z.object({ sequenceId: z.string().min(1), enrollmentId: z.string().min(1) }).strict();

@RequireModule("crm")
@Controller("crm/sequences")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmAutomationStudioController {
  constructor(private readonly sequences: CrmSequencesService) {}

  @Get()
  @RequirePermission("crm:sequences:manage")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.sequences.list(u.orgId);
  }

  @Post()
  @RequirePermission("crm:sequences:manage")
  @HttpCode(201)
  @Validate({ body: createSequenceSchema })
  create(
    @Body() body: CreateSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.create(u.orgId, body);
  }

  @Get(":sequenceId")
  @RequirePermission("crm:sequences:manage")
  @Validate({ params: sequenceIdParams })
  async getOne(
    @Param("sequenceId") sequenceId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sequences.getOne(u.orgId, sequenceId);
    if (!result) throw new NotFoundException("Sequence not found");
    return result;
  }

  @Patch(":sequenceId")
  @RequirePermission("crm:sequences:manage")
  @Validate({ params: sequenceIdParams, body: updateSequenceSchema })
  async update(
    @Param("sequenceId") sequenceId: string,
    @Body() body: UpdateSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sequences.update(u.orgId, sequenceId, body);
    if (!result) throw new NotFoundException("Sequence not found");
    return result;
  }

  @Delete(":sequenceId")
  @RequirePermission("crm:sequences:manage")
  @Validate({ params: sequenceIdParams })
  remove(
    @Param("sequenceId") sequenceId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.remove(u.orgId, sequenceId);
  }

  @Get(":sequenceId/steps")
  @RequirePermission("crm:sequences:manage")
  @Validate({ params: sequenceIdParams })
  listSteps(
    @Param("sequenceId") sequenceId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.listSteps(u.orgId, sequenceId);
  }

  @Post(":sequenceId/steps")
  @RequirePermission("crm:sequences:manage")
  @HttpCode(201)
  @Validate({ params: sequenceIdParams, body: createSequenceStepSchema })
  createStep(
    @Param("sequenceId") sequenceId: string,
    @Body() body: CreateSequenceStepInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.createStep(u.orgId, sequenceId, body);
  }

  @Delete(":sequenceId/steps/:stepId")
  @RequirePermission("crm:sequences:manage")
  @Validate({ params: sequenceIdstepIdParams })
  removeStep(
    @Param("sequenceId") sequenceId: string,
    @Param("stepId") stepId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.removeStep(u.orgId, sequenceId, stepId);
  }

  @Patch(":sequenceId/steps/reorder")
  @RequirePermission("crm:sequences:manage")
  @Validate({ params: sequenceIdParams, body: reorderSequenceStepsSchema })
  reorderSteps(
    @Param("sequenceId") sequenceId: string,
    @Body() body: ReorderSequenceStepsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.reorderSteps(u.orgId, sequenceId, body.order);
  }

  @Get(":sequenceId/enrollments")
  @RequirePermission("crm:sequences:manage")
  @Validate({ params: sequenceIdParams })
  listEnrollments(
    @Param("sequenceId") sequenceId: string,
    @Query("cursor") cursor: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.listEnrollments(u.orgId, sequenceId, cursor);
  }

  @Post(":sequenceId/enrollments")
  @RequirePermission("crm:sequences:manage")
  @HttpCode(201)
  @Idempotent("crm.sequence.enroll")
  @Validate({ params: sequenceIdParams, body: enrollInSequenceSchema })
  enroll(
    @Param("sequenceId") sequenceId: string,
    @Body() body: EnrollInSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.enroll(u.orgId, sequenceId, body);
  }

  @Patch(":sequenceId/enrollments/:enrollmentId/stop")
  @RequirePermission("crm:sequences:manage")
  @Validate({ params: sequenceIdenrollmentIdParams })
  stopEnrollment(
    @Param("sequenceId") sequenceId: string,
    @Param("enrollmentId") enrollmentId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.stopEnrollment(u.orgId, sequenceId, enrollmentId);
  }
}
