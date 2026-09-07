import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RecruitmentAutomationService } from "./recruitment-automation.service";
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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  pipelineAutomationSchema,
  pipelineAutomationWithCreatorSchema,
  candidateMessageSchema,
  candidateMessageRawSchema,
  messageThreadItemSchema,
  emailSequenceWithStepsSchema,
  emailSequenceListItemSchema,
  emailSequenceDetailSchema,
  enrollSequenceResponseSchema,
  successSchema,
} from "./dto/recruitment-response.schemas";

const automationIdParams = z.object({ automationId: z.coerce.number().int().positive() }).strict();
const messageIdParams = z.object({ messageId: z.coerce.number().int().positive() }).strict();
const sequenceIdParams = z.object({ sequenceId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentAutomationController {
  constructor(private readonly automation: RecruitmentAutomationService) {}

  @Get("automations")
  @ResponseSchema(z.array(pipelineAutomationWithCreatorSchema))
  @RequirePermission("hr:employees:view")
  listAutomations(@CurrentUser() u: CurrentUserContext) {
    return this.automation.listAutomations(u.orgId);
  }

  @Post("automations")
  @HttpCode(201)
  @ResponseSchema(pipelineAutomationSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ body: createAutomationSchema })
  createAutomation(
    @Body() body: CreateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.createAutomation(u.orgId, u.userId, body);
  }

  @Patch("automations/:automationId")
  @ResponseSchema(pipelineAutomationSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: automationIdParams, body: updateAutomationSchema })
  updateAutomation(
    @Param("automationId", ParseIntPipe) automationId: number,
    @Body() body: UpdateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.updateAutomation(u.orgId, automationId, body);
  }

  @Delete("automations/:automationId")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: automationIdParams })
  deleteAutomation(
    @Param("automationId", ParseIntPipe) automationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.deleteAutomation(u.orgId, automationId);
  }

  @Get("messages")
  @ResponseSchema(z.array(candidateMessageSchema))
  @RequirePermission("hr:employees:view")
  @Validate({ query: messageListSchema })
  listMessages(
    @Query() query: MessageListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.listMessages(u.orgId, query);
  }

  @Post("messages")
  @HttpCode(201)
  @ResponseSchema(candidateMessageRawSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ body: sendMessageSchema })
  sendMessage(
    @Body() body: SendMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.sendMessage(u.orgId, u.userId, body);
  }

  @Get("messages/threads")
  @ResponseSchema(z.array(messageThreadItemSchema))
  @RequirePermission("hr:employees:view")
  listMessageThreads(@CurrentUser() u: CurrentUserContext) {
    return this.automation.listMessageThreads(u.orgId);
  }

  @Patch("messages/:messageId")
  @BodylessAction()
  @ResponseSchema(candidateMessageRawSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ params: messageIdParams })
  markMessageRead(
    @Param("messageId", ParseIntPipe) messageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.markMessageRead(u.orgId, messageId);
  }

  @Get("email-sequences")
  @ResponseSchema(z.array(emailSequenceListItemSchema))
  @RequirePermission("hr:employees:view")
  listSequences(@CurrentUser() u: CurrentUserContext) {
    return this.automation.listSequences(u.orgId);
  }

  @Post("email-sequences")
  @HttpCode(201)
  @ResponseSchema(emailSequenceWithStepsSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ body: createSequenceSchema })
  createSequence(
    @Body() body: CreateSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.createSequence(u.orgId, u.userId, body);
  }

  @Get("email-sequences/:sequenceId")
  @ResponseSchema(emailSequenceDetailSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ params: sequenceIdParams })
  getSequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.getSequence(u.orgId, sequenceId);
  }

  @Patch("email-sequences/:sequenceId")
  @ResponseSchema(emailSequenceWithStepsSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: sequenceIdParams, body: updateSequenceSchema })
  updateSequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @Body() body: UpdateSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.updateSequence(u.orgId, sequenceId, body);
  }

  @Delete("email-sequences/:sequenceId")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: sequenceIdParams })
  deleteSequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.deleteSequence(u.orgId, sequenceId);
  }

  @Post("email-sequences/:sequenceId/enroll")
  @ResponseSchema(enrollSequenceResponseSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: sequenceIdParams, body: enrollSequenceSchema })
  enrollSequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @Body() body: EnrollSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.enrollSequence(u.orgId, sequenceId, body);
  }
}
