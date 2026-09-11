import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  surveyBuilderSnapshotSchema,
  surveySectionRowSchema,
  surveyQuestionSchema,
  surveyLogicRuleRowSchema,
  surveyLogicRuleListSchema,
  successSchema as builderSuccessSchema,
} from "./dto/survey-builder-response.schemas";
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

@RequireModule("surveys")
@Controller("surveys/:surveyId")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SurveyBuilderController {
  constructor(
    private readonly builder: SurveyBuilderService,
    private readonly logic: SurveyLogicService,
  ) {}

  @Get("builder")
  @RequirePermission("surveys:view")
  @Validate({ params: surveyIdParams })
  @ResponseSchema(surveyBuilderSnapshotSchema)
  getBuilder(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.builder.getBuilder(u.orgId, surveyId);
  }

  @Post("sections")
  @HttpCode(201)
  @RequirePermission("surveys:update")
  @Validate({ params: surveyIdParams, body: createSectionSchema })
  @ResponseSchema(surveySectionRowSchema)
  createSection(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: CreateSectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.createSection(u.orgId, surveyId, body);
  }

  @Patch("sections/:sectionId")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyAndSectionIdParams, body: patchSectionSchema })
  @ResponseSchema(surveySectionRowSchema)
  patchSection(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("sectionId", ParseIntPipe) sectionId: number,
    @Body() body: PatchSectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.patchSection(u.orgId, surveyId, sectionId, body);
  }

  @Delete("sections/:sectionId")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyAndSectionIdParams })
  @ResponseSchema(builderSuccessSchema)
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
  @Validate({ params: surveyIdParams, body: createQuestionSchema })
  @ResponseSchema(surveyQuestionSchema)
  createQuestion(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: CreateQuestionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.createQuestion(u.orgId, surveyId, body);
  }

  @Patch("questions/:questionId")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyAndQuestionIdParams, body: patchQuestionSchema })
  @ResponseSchema(surveyQuestionSchema)
  patchQuestion(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("questionId", ParseIntPipe) questionId: number,
    @Body() body: PatchQuestionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.patchQuestion(u.orgId, surveyId, questionId, body);
  }

  @Delete("questions/:questionId")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyAndQuestionIdParams })
  @ResponseSchema(builderSuccessSchema)
  deleteQuestion(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("questionId", ParseIntPipe) questionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.deleteQuestion(u.orgId, surveyId, questionId);
  }

  @Post("questions/:questionId/duplicate")
  @BodylessAction()
  @RequirePermission("surveys:update")
  @Validate({ params: surveyAndQuestionIdParams })
  @ResponseSchema(surveyQuestionSchema)
  duplicateQuestion(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("questionId", ParseIntPipe) questionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.duplicateQuestion(u.orgId, surveyId, questionId);
  }

  @Patch("reorder")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyIdParams, body: reorderSchema })
  @ResponseSchema(builderSuccessSchema)
  reorder(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: ReorderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.builder.reorder(u.orgId, surveyId, body);
  }

  @Get("logic")
  @RequirePermission("surveys:view")
  @Validate({ params: surveyIdParams })
  @ResponseSchema(surveyLogicRuleListSchema)
  listLogic(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.logic.list(u.orgId, surveyId);
  }

  @Post("logic")
  @HttpCode(201)
  @RequirePermission("surveys:update")
  @Validate({ params: surveyIdParams, body: createLogicRuleSchema })
  @ResponseSchema(surveyLogicRuleRowSchema)
  createLogic(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: CreateLogicRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.logic.create(u.orgId, surveyId, body);
  }

  @Patch("logic/:ruleId")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyAndRuleIdParams, body: patchLogicRuleSchema })
  @ResponseSchema(surveyLogicRuleRowSchema)
  patchLogic(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body() body: PatchLogicRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.logic.patch(u.orgId, surveyId, ruleId, body);
  }

  @Delete("logic/:ruleId")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyAndRuleIdParams })
  @ResponseSchema(builderSuccessSchema)
  deleteLogic(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.logic.delete(u.orgId, surveyId, ruleId);
  }
}
