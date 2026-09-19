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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { HrInterviewQuestionsService } from "./hr-interview-questions.service";
import {
  createInterviewQuestionSchema,
  interviewQuestionListQuerySchema,
  updateInterviewQuestionSchema,
  type CreateInterviewQuestionInput,
  type InterviewQuestionListQuery,
  type UpdateInterviewQuestionInput,
} from "./dto/interview-questions.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { interviewQuestionRowSchema, successSchema } from "./dto/config-response.schemas";
import { z } from "zod";

const questionIdParams = z.object({ questionId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/interview-questions")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrInterviewQuestionsController {
  constructor(private readonly interviewQuestions: HrInterviewQuestionsService) {}

  @Get()
  @ResponseSchema(z.array(interviewQuestionRowSchema))
  @RequirePermission("hr:interviews:view")
  @Validate({ query: interviewQuestionListQuerySchema })
  list(
    @Query() query: InterviewQuestionListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.interviewQuestions.list(u.orgId, query);
  }

  @Post()
  @ResponseSchema(interviewQuestionRowSchema)
  @RequirePermission("hr:interviews:manage")
  @HttpCode(201)
  @Validate({ body: createInterviewQuestionSchema })
  create(
    @Body() body: CreateInterviewQuestionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.interviewQuestions.create(u.orgId, u.userId, body);
  }

  @Patch(":questionId")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: questionIdParams, body: updateInterviewQuestionSchema })
  async update(
    @Param("questionId", ParseIntPipe) questionId: number,
    @Body() body: UpdateInterviewQuestionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.interviewQuestions.getById(u.orgId, questionId);
    if (!existing) throw new NotFoundException("Question not found");
    return this.interviewQuestions.update(u.orgId, questionId, body);
  }

  @Delete(":questionId")
  @NoContentResponse()
  @HttpCode(204)
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: questionIdParams })
  async remove(
    @Param("questionId", ParseIntPipe) questionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.interviewQuestions.getById(u.orgId, questionId);
    if (!existing) throw new NotFoundException("Question not found");
    return this.interviewQuestions.softDelete(u.orgId, questionId);
  }
}
