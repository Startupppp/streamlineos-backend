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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
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
  create(
    @Body(new ZodValidationPipe(createSequenceSchema)) body: CreateSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.create(u.orgId, body);
  }

  @Get(":sequenceId")
  @RequirePermission("crm:sequences:manage")
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
  async update(
    @Param("sequenceId") sequenceId: string,
    @Body(new ZodValidationPipe(updateSequenceSchema)) body: UpdateSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sequences.update(u.orgId, sequenceId, body);
    if (!result) throw new NotFoundException("Sequence not found");
    return result;
  }

  @Delete(":sequenceId")
  @RequirePermission("crm:sequences:manage")
  remove(
    @Param("sequenceId") sequenceId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.remove(u.orgId, sequenceId);
  }

  @Get(":sequenceId/steps")
  @RequirePermission("crm:sequences:manage")
  listSteps(
    @Param("sequenceId") sequenceId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.listSteps(u.orgId, sequenceId);
  }

  @Post(":sequenceId/steps")
  @RequirePermission("crm:sequences:manage")
  @HttpCode(201)
  createStep(
    @Param("sequenceId") sequenceId: string,
    @Body(new ZodValidationPipe(createSequenceStepSchema)) body: CreateSequenceStepInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.createStep(u.orgId, sequenceId, body);
  }

  @Delete(":sequenceId/steps/:stepId")
  @RequirePermission("crm:sequences:manage")
  removeStep(
    @Param("sequenceId") sequenceId: string,
    @Param("stepId") stepId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.removeStep(u.orgId, sequenceId, stepId);
  }

  @Patch(":sequenceId/steps/reorder")
  @RequirePermission("crm:sequences:manage")
  reorderSteps(
    @Param("sequenceId") sequenceId: string,
    @Body(new ZodValidationPipe(reorderSequenceStepsSchema)) body: ReorderSequenceStepsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.reorderSteps(u.orgId, sequenceId, body.order);
  }

  @Get(":sequenceId/enrollments")
  @RequirePermission("crm:sequences:manage")
  listEnrollments(
    @Param("sequenceId") sequenceId: string,
    @Query("page") page = "1",
    @CurrentUser() u: CurrentUserContext,
  ) {
    const pageNum = Math.max(1, Math.min(100, parseInt(page, 10) || 1));
    return this.sequences.listEnrollments(u.orgId, sequenceId, pageNum);
  }

  @Post(":sequenceId/enrollments")
  @RequirePermission("crm:sequences:manage")
  @HttpCode(201)
  @Idempotent("crm.sequence.enroll")
  enroll(
    @Param("sequenceId") sequenceId: string,
    @Body(new ZodValidationPipe(enrollInSequenceSchema)) body: EnrollInSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.enroll(u.orgId, sequenceId, body);
  }

  @Patch(":sequenceId/enrollments/:enrollmentId/stop")
  @RequirePermission("crm:sequences:manage")
  stopEnrollment(
    @Param("sequenceId") sequenceId: string,
    @Param("enrollmentId") enrollmentId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.stopEnrollment(u.orgId, sequenceId, enrollmentId);
  }
}
