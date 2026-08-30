import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CrmMetadataService } from "./crm-metadata.service";
import { CrmValidationRulesService } from "./crm-validation-rules.service";
import { CrmBlueprintsService } from "./crm-blueprints.service";
import {
  createPipelineSchema, updatePipelineSchema, createStageSchema, updateStageSchema,
  reorderStagesSchema, createOptionSchema, updateOptionSchema, optionTypeSchema,
  listPipelinesSchema,
  type CreatePipelineInput, type UpdatePipelineInput, type CreateStageInput,
  type UpdateStageInput, type ReorderStagesInput, type CreateOptionInput, type UpdateOptionInput,
} from "./dto/metadata.schemas";
import {
  createValidationRuleSchema, updateValidationRuleSchema, testValidationSchema,
  type CreateValidationRuleInput, type UpdateValidationRuleInput, type TestValidationInput,
} from "./dto/validation-rules.schemas";
import {
  createBlueprintSchema, updateBlueprintSchema, testTransitionSchema,
  createTransitionSchema, updateTransitionSchema,
  type CreateBlueprintInput, type UpdateBlueprintInput, type TestTransitionInput,
  type CreateTransitionInput, type UpdateTransitionInput,
} from "./dto/blueprints.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const pipelineIdParams = z.object({ pipelineId: z.string().min(1) }).strict();
const stageIdParams = z.object({ stageId: z.string().min(1) }).strict();
const optionTypeParams = z.object({ optionType: z.string().min(1) }).strict();
const optionTypeoptionIdParams = z.object({ optionType: z.string().min(1), optionId: z.string().min(1) }).strict();
const ruleIdParams = z.object({ ruleId: z.string().min(1) }).strict();
const blueprintIdParams = z.object({ blueprintId: z.string().min(1) }).strict();
const blueprintIdtransitionIdParams = z.object({ blueprintId: z.string().min(1), transitionId: z.string().min(1) }).strict();

@RequireModule("crm")
@Controller("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmMetadataController {
  constructor(
    private readonly svc: CrmMetadataService,
    private readonly validationRulesSvc: CrmValidationRulesService,
    private readonly blueprintsSvc: CrmBlueprintsService,
  ) {}

  @Get("metadata")
  @RequirePermission("crm:leads:view")
  getAggregate(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getAggregate(u.orgId);
  }

  @Get("pipelines")
  @RequirePermission("crm:settings:view")
  @Validate({ query: listPipelinesSchema })
  listPipelines(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listPipelines(u.orgId);
  }

  @Post("pipelines")
  @RequirePermission("crm:settings:manage")
  @Validate({ body: createPipelineSchema })
  createPipeline(
    @Body() body: CreatePipelineInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createPipeline(u, body);
  }

  @Patch("pipelines/:pipelineId")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: pipelineIdParams, body: updatePipelineSchema })
  updatePipeline(
    @Param("pipelineId") pipelineId: string,
    @Body() body: UpdatePipelineInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updatePipeline(u, pipelineId, body);
  }

  @Delete("pipelines/:pipelineId")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: pipelineIdParams })
  deletePipeline(
    @Param("pipelineId") pipelineId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deletePipeline(u, pipelineId);
  }

  @Get("pipelines/:pipelineId/stages")
  @RequirePermission("crm:settings:view")
  @Validate({ params: pipelineIdParams })
  listStages(
    @Param("pipelineId") pipelineId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listStages(u.orgId, pipelineId);
  }

  @Post("pipelines/:pipelineId/stages")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: pipelineIdParams, body: createStageSchema })
  createStage(
    @Param("pipelineId") pipelineId: string,
    @Body() body: CreateStageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createStage(u, pipelineId, body);
  }

  @Post("pipelines/:pipelineId/stages/reorder")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: pipelineIdParams, body: reorderStagesSchema })
  reorderStages(
    @Param("pipelineId") pipelineId: string,
    @Body() body: ReorderStagesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.reorderStages(u, pipelineId, body);
  }

  @Patch("stages/:stageId")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: stageIdParams, body: updateStageSchema })
  updateStage(
    @Param("stageId") stageId: string,
    @Body() body: UpdateStageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateStage(u, stageId, body);
  }

  @Delete("stages/:stageId")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: stageIdParams })
  deleteStage(
    @Param("stageId") stageId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteStage(u, stageId);
  }

  @Get("options/:optionType")
  @RequirePermission("crm:leads:view")
  @Validate({ params: optionTypeParams })
  listOptions(
    @Param("optionType") optionType: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listOptions(u.orgId, optionType);
  }

  @Post("options/:optionType")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: optionTypeParams, body: createOptionSchema })
  createOption(
    @Param("optionType") optionType: string,
    @Body() body: CreateOptionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createOption(u, optionType, body);
  }

  @Patch("options/:optionType/:optionId")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: optionTypeoptionIdParams, body: updateOptionSchema })
  updateOption(
    @Param("optionType") optionType: string,
    @Param("optionId") optionId: string,
    @Body() body: UpdateOptionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateOption(u, optionType, optionId, body);
  }

  @Delete("options/:optionType/:optionId")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: optionTypeoptionIdParams })
  deleteOption(
    @Param("optionType") optionType: string,
    @Param("optionId") optionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteOption(u, optionType, optionId);
  }

  @Get("validation-rules")
  @RequirePermission("crm:settings:view")
  listValidationRules(@CurrentUser() u: CurrentUserContext) {
    return this.validationRulesSvc.list(u.orgId);
  }

  @Post("validation-rules")
  @RequirePermission("crm:settings:manage")
  @Validate({ body: createValidationRuleSchema })
  createValidationRule(
    @Body() body: CreateValidationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.validationRulesSvc.create(u, body);
  }

  @Patch("validation-rules/:ruleId")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: ruleIdParams, body: updateValidationRuleSchema })
  updateValidationRule(
    @Param("ruleId") ruleId: string,
    @Body() body: UpdateValidationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.validationRulesSvc.update(u, ruleId, body);
  }

  @Delete("validation-rules/:ruleId")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: ruleIdParams })
  deleteValidationRule(
    @Param("ruleId") ruleId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.validationRulesSvc.delete(u, ruleId);
  }

  @Post("validation-rules/test")
  @RequirePermission("crm:settings:view")
  @Validate({ body: testValidationSchema })
  testValidationRule(
    @Body() body: TestValidationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.validationRulesSvc.testValidation(u, body);
  }

  @Get("blueprints")
  @RequirePermission("crm:settings:view")
  listBlueprints(@CurrentUser() u: CurrentUserContext) {
    return this.blueprintsSvc.list(u.orgId);
  }

  @Post("blueprints")
  @RequirePermission("crm:settings:manage")
  @Validate({ body: createBlueprintSchema })
  createBlueprint(
    @Body() body: CreateBlueprintInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.create(u, body);
  }

  @Patch("blueprints/:blueprintId")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: blueprintIdParams, body: updateBlueprintSchema })
  updateBlueprint(
    @Param("blueprintId") blueprintId: string,
    @Body() body: UpdateBlueprintInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.update(u, blueprintId, body);
  }

  @Delete("blueprints/:blueprintId")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: blueprintIdParams })
  deleteBlueprint(
    @Param("blueprintId") blueprintId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.delete(u, blueprintId);
  }

  @Post("blueprints/:blueprintId/test-transition")
  @RequirePermission("crm:settings:view")
  @Validate({ params: blueprintIdParams, body: testTransitionSchema })
  testBlueprintTransition(
    @Param("blueprintId") blueprintId: string,
    @Body() body: TestTransitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.testTransition(u.orgId, blueprintId, body.fromStageKey, body.toStageKey, body.record);
  }

  @Post("blueprints/:blueprintId/test")
  @RequirePermission("crm:settings:view")
  @Validate({ params: blueprintIdParams, body: testTransitionSchema })
  testBlueprintTransitionAlias(
    @Param("blueprintId") blueprintId: string,
    @Body() body: TestTransitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.testTransition(u.orgId, blueprintId, body.fromStageKey, body.toStageKey, body.record);
  }

  @Get("blueprints/:blueprintId/transitions")
  @RequirePermission("crm:settings:view")
  @Validate({ params: blueprintIdParams })
  listBlueprintTransitions(
    @Param("blueprintId") blueprintId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.listTransitions(u.orgId, blueprintId);
  }

  @Post("blueprints/:blueprintId/transitions")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: blueprintIdParams, body: createTransitionSchema })
  createBlueprintTransition(
    @Param("blueprintId") blueprintId: string,
    @Body() body: CreateTransitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.createTransition(u, blueprintId, body);
  }

  @Patch("blueprints/:blueprintId/transitions/:transitionId")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: blueprintIdtransitionIdParams, body: updateTransitionSchema })
  updateBlueprintTransition(
    @Param("blueprintId") blueprintId: string,
    @Param("transitionId") transitionId: string,
    @Body() body: UpdateTransitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.updateTransition(u, blueprintId, transitionId, body);
  }

  @Delete("blueprints/:blueprintId/transitions/:transitionId")
  @RequirePermission("crm:settings:manage")
  @Validate({ params: blueprintIdtransitionIdParams })
  deleteBlueprintTransition(
    @Param("blueprintId") blueprintId: string,
    @Param("transitionId") transitionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.deleteTransition(u, blueprintId, transitionId);
  }
}
