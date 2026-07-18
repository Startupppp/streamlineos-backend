import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrInterviewQuestionsService } from "./hr-interview-questions.service";
import {
  createInterviewQuestionSchema,
  interviewQuestionListQuerySchema,
  updateInterviewQuestionSchema,
  type CreateInterviewQuestionInput,
  type InterviewQuestionListQuery,
  type UpdateInterviewQuestionInput,
} from "./dto/interview-questions.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/interview-questions")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrInterviewQuestionsController {
  constructor(private readonly interviewQuestions: HrInterviewQuestionsService) {}

  @Get()
  @RequirePermission("hr:employees:view")
  list(
    @Query(new ZodValidationPipe(interviewQuestionListQuerySchema)) query: InterviewQuestionListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.interviewQuestions.list(u.orgId, query);
  }

  @Post()
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createInterviewQuestionSchema)) body: CreateInterviewQuestionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.interviewQuestions.create(u.orgId, u.userId, body);
  }

  @Patch(":questionId")
  @RequirePermission("hr:employees:manage")
  async update(
    @Param("questionId", ParseIntPipe) questionId: number,
    @Body(new ZodValidationPipe(updateInterviewQuestionSchema)) body: UpdateInterviewQuestionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.interviewQuestions.getById(u.orgId, questionId);
    if (!existing) throw new NotFoundException("Question not found");
    return this.interviewQuestions.update(u.orgId, questionId, body);
  }

  @Delete(":questionId")
  @HttpCode(204)
  @RequirePermission("hr:employees:manage")
  async remove(
    @Param("questionId", ParseIntPipe) questionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.interviewQuestions.getById(u.orgId, questionId);
    if (!existing) throw new NotFoundException("Question not found");
    return this.interviewQuestions.softDelete(u.orgId, questionId);
  }
}
