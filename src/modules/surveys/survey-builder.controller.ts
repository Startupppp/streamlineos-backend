import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SurveyBuilderService } from "./survey-builder.service";
import { SurveyLogicService } from "./survey-logic.service";
import {
  createSectionSchema,
  patchSectionSchema,
  createQuestionSchema,
  patchQuestionSchema,
  reorderSchema,
  createLogicRuleSchema,
  patchLogicRuleSchema,
  type CreateSectionInput,
  type PatchSectionInput,
  type CreateQuestionInput,
  type PatchQuestionInput,
  type ReorderInput,
  type CreateLogicRuleInput,
  type PatchLogicRuleInput,
} from "./dto/survey-builder.schemas";

const surveyIdParams = z.object({ surveyId: z.coerce.number().int().positive() }).strict();
const surveyAndSectionIdParams = z.object({ surveyId: z.coerce.number().int().positive(), sectionId: z.coerce.number().int().positive() }).strict();
const surveyAndQuestionIdParams = z.object({ surveyId: z.coerce.number().int().positive(), questionId: z.coerce.number().int().positive() }).strict();
const surveyAndRuleIdParams = z.object({ surveyId: z.coerce.number().int().positive(), ruleId: z.coerce.number().int().positive() }).strict();

@Controller("surveys/:surveyId")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SurveyBuilderController {
  constructor(
    private readonly builder: SurveyBuilderService,
    private readonly logic: SurveyLogicService,
  ) {}

  @Get("builder")
  @RequirePermission("surveys:view")
  @Validate({ params: surveyIdParams })
  getBuilder(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.builder.getBuilder(u.orgId, surveyId);
  }

  @Post("sections")
  @HttpCode(201)
  @RequirePermission("surveys:update")
  @Validate({ params: surveyIdParams })
  createSection(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body(new ZodValidationPipe(createSectionSchema)) body: CreateSectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.createSection(u.orgId, surveyId, body);
  }

  @Patch("sections/:sectionId")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyAndSectionIdParams })
  patchSection(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("sectionId", ParseIntPipe) sectionId: number,
    @Body(new ZodValidationPipe(patchSectionSchema)) body: PatchSectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.patchSection(u.orgId, surveyId, sectionId, body);
  }

  @Delete("sections/:sectionId")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyAndSectionIdParams })
  deleteSection(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("sectionId", ParseIntPipe) sectionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.deleteSection(u.orgId, surveyId, sectionId);
  }

  @Post("questions")
  @HttpCode(201)
  @RequirePermission("surveys:update")
  @Validate({ params: surveyIdParams })
  createQuestion(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body(new ZodValidationPipe(createQuestionSchema)) body: CreateQuestionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.createQuestion(u.orgId, surveyId, body);
  }

  @Patch("questions/:questionId")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyAndQuestionIdParams })
  patchQuestion(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("questionId", ParseIntPipe) questionId: number,
    @Body(new ZodValidationPipe(patchQuestionSchema)) body: PatchQuestionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.patchQuestion(u.orgId, surveyId, questionId, body);
  }

  @Delete("questions/:questionId")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyAndQuestionIdParams })
  deleteQuestion(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("questionId", ParseIntPipe) questionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.deleteQuestion(u.orgId, surveyId, questionId);
  }

  @Post("questions/:questionId/duplicate")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyAndQuestionIdParams })
  duplicateQuestion(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("questionId", ParseIntPipe) questionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.duplicateQuestion(u.orgId, surveyId, questionId);
  }

  @Patch("reorder")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyIdParams })
  reorder(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body(new ZodValidationPipe(reorderSchema)) body: ReorderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.reorder(u.orgId, surveyId, body);
  }

  @Get("logic")
  @RequirePermission("surveys:view")
  @Validate({ params: surveyIdParams })
  listLogic(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.logic.list(u.orgId, surveyId);
  }

  @Post("logic")
  @HttpCode(201)
  @RequirePermission("surveys:update")
  @Validate({ params: surveyIdParams })
  createLogic(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body(new ZodValidationPipe(createLogicRuleSchema)) body: CreateLogicRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.logic.create(u.orgId, surveyId, body);
  }

  @Patch("logic/:ruleId")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyAndRuleIdParams })
  patchLogic(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(patchLogicRuleSchema)) body: PatchLogicRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.logic.patch(u.orgId, surveyId, ruleId, body);
  }

  @Delete("logic/:ruleId")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyAndRuleIdParams })
  deleteLogic(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.logic.delete(u.orgId, surveyId, ruleId);
  }
}
