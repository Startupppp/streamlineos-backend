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
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RecruitmentAutomationService } from "./recruitment-automation.service";
import { AccessService } from "../access/access.service";
import {
  createAutomationSchema,
  createSequenceSchema,
  enrollSequenceSchema,
  messageListSchema,
  sendMessageSchema,
  updateAutomationSchema,
  updateSequenceSchema,
  type CreateAutomationInput,
  type CreateSequenceInput,
  type EnrollSequenceInput,
  type MessageListInput,
  type SendMessageInput,
  type UpdateAutomationInput,
  type UpdateSequenceInput,
} from "./dto/automation.schemas";

@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard)
export class RecruitmentAutomationController {
  constructor(
    private readonly automation: RecruitmentAutomationService,
    private readonly access: AccessService,
  ) {}

  @Get("automations")
  listAutomations(@CurrentUser() u: CurrentUserContext) {
    return this.automation.listAutomations(u.orgId);
  }

  @Post("automations")
  @HttpCode(201)
  async createAutomation(
    @Body(new ZodValidationPipe(createAutomationSchema)) body: CreateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.automation.createAutomation(u.orgId, u.userId, body);
  }

  @Patch("automations/:automationId")
  async updateAutomation(
    @Param("automationId", ParseIntPipe) automationId: number,
    @Body(new ZodValidationPipe(updateAutomationSchema)) body: UpdateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.automation.updateAutomation(u.orgId, automationId, body);
  }

  @Delete("automations/:automationId")
  async deleteAutomation(
    @Param("automationId", ParseIntPipe) automationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.automation.deleteAutomation(u.orgId, automationId);
  }

  @Get("messages")
  listMessages(
    @Query(new ZodValidationPipe(messageListSchema)) query: MessageListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.listMessages(u.orgId, query);
  }

  @Post("messages")
  @HttpCode(201)
  sendMessage(
    @Body(new ZodValidationPipe(sendMessageSchema)) body: SendMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.sendMessage(u.orgId, u.userId, body);
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
  async createSequence(
    @Body(new ZodValidationPipe(createSequenceSchema)) body: CreateSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
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
  async updateSequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @Body(new ZodValidationPipe(updateSequenceSchema)) body: UpdateSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.automation.updateSequence(u.orgId, sequenceId, body);
  }

  @Delete("email-sequences/:sequenceId")
  async deleteSequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.automation.deleteSequence(u.orgId, sequenceId);
  }

  @Post("email-sequences/:sequenceId/enroll")
  async enrollSequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @Body(new ZodValidationPipe(enrollSequenceSchema)) body: EnrollSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.automation.enrollSequence(u.orgId, sequenceId, body);
  }
}
