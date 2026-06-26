import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { hasRoleOrPrivileged } from "../../common/auth/role-access";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RecruitmentAutomationService } from "./recruitment-automation.service";
import { RECRUITMENT_MANAGER_ROLES } from "./recruitment-roles";
import {
  createAutomationSchema,
  createSequenceSchema,
  enrollSequenceSchema,
  updateAutomationSchema,
  updateSequenceSchema,
  type CreateAutomationInput,
  type CreateSequenceInput,
  type EnrollSequenceInput,
  type UpdateAutomationInput,
  type UpdateSequenceInput,
} from "./dto/automation.schemas";

@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard)
export class RecruitmentAutomationController {
  constructor(private readonly automation: RecruitmentAutomationService) {}

  @Get("automations")
  listAutomations(@CurrentUser() u: CurrentUserContext) {
    return this.automation.listAutomations(u.orgId);
  }

  @Post("automations")
  @HttpCode(201)
  createAutomation(
    @Body(new ZodValidationPipe(createAutomationSchema)) body: CreateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, RECRUITMENT_MANAGER_ROLES))
      throw new ForbiddenException("Forbidden");
    return this.automation.createAutomation(u.orgId, u.userId, body);
  }

  @Patch("automations/:automationId")
  updateAutomation(
    @Param("automationId", ParseIntPipe) automationId: number,
    @Body(new ZodValidationPipe(updateAutomationSchema)) body: UpdateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, RECRUITMENT_MANAGER_ROLES))
      throw new ForbiddenException("Forbidden");
    return this.automation.updateAutomation(u.orgId, automationId, body);
  }

  @Delete("automations/:automationId")
  deleteAutomation(
    @Param("automationId", ParseIntPipe) automationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, RECRUITMENT_MANAGER_ROLES))
      throw new ForbiddenException("Forbidden");
    return this.automation.deleteAutomation(u.orgId, automationId);
  }

  @Get("messages/threads")
  listMessageThreads(@CurrentUser() u: CurrentUserContext) {
    return this.automation.listMessageThreads(u.orgId);
  }

  @Patch("messages/:messageId")
  markMessageRead(
    @Param("messageId", ParseIntPipe) messageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.markMessageRead(u.orgId, messageId);
  }

  @Get("email-sequences")
  listSequences(@CurrentUser() u: CurrentUserContext) {
    return this.automation.listSequences(u.orgId);
  }

  @Post("email-sequences")
  @HttpCode(201)
  createSequence(
    @Body(new ZodValidationPipe(createSequenceSchema)) body: CreateSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, RECRUITMENT_MANAGER_ROLES))
      throw new ForbiddenException("Forbidden");
    return this.automation.createSequence(u.orgId, u.userId, body);
  }

  @Get("email-sequences/:sequenceId")
  getSequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.getSequence(u.orgId, sequenceId);
  }

  @Patch("email-sequences/:sequenceId")
  updateSequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @Body(new ZodValidationPipe(updateSequenceSchema)) body: UpdateSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, RECRUITMENT_MANAGER_ROLES))
      throw new ForbiddenException("Forbidden");
    return this.automation.updateSequence(u.orgId, sequenceId, body);
  }

  @Delete("email-sequences/:sequenceId")
  deleteSequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, RECRUITMENT_MANAGER_ROLES))
      throw new ForbiddenException("Forbidden");
    return this.automation.deleteSequence(u.orgId, sequenceId);
  }

  @Post("email-sequences/:sequenceId/enroll")
  enrollSequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @Body(new ZodValidationPipe(enrollSequenceSchema)) body: EnrollSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, RECRUITMENT_MANAGER_ROLES))
      throw new ForbiddenException("Forbidden");
    return this.automation.enrollSequence(u.orgId, sequenceId, body);
  }
}
