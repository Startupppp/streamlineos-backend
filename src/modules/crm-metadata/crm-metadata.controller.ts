import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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
  listPipelines(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(listPipelinesSchema)) _: unknown,
  ) {
    return this.svc.listPipelines(u.orgId);
  }

  @Post("pipelines")
  @RequirePermission("crm:settings:manage")
  createPipeline(
    @Body(new ZodValidationPipe(createPipelineSchema)) body: CreatePipelineInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createPipeline(u, body);
  }

  @Patch("pipelines/:pipelineId")
  @RequirePermission("crm:settings:manage")
  updatePipeline(
    @Param("pipelineId") pipelineId: string,
    @Body(new ZodValidationPipe(updatePipelineSchema)) body: UpdatePipelineInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updatePipeline(u, pipelineId, body);
  }

  @Delete("pipelines/:pipelineId")
  @RequirePermission("crm:settings:manage")
  deletePipeline(
    @Param("pipelineId") pipelineId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deletePipeline(u, pipelineId);
  }

  @Get("pipelines/:pipelineId/stages")
  @RequirePermission("crm:settings:view")
  listStages(
    @Param("pipelineId") pipelineId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listStages(u.orgId, pipelineId);
  }

  @Post("pipelines/:pipelineId/stages")
  @RequirePermission("crm:settings:manage")
  createStage(
    @Param("pipelineId") pipelineId: string,
    @Body(new ZodValidationPipe(createStageSchema)) body: CreateStageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createStage(u, pipelineId, body);
  }

  @Post("pipelines/:pipelineId/stages/reorder")
  @RequirePermission("crm:settings:manage")
  reorderStages(
    @Param("pipelineId") pipelineId: string,
    @Body(new ZodValidationPipe(reorderStagesSchema)) body: ReorderStagesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.reorderStages(u, pipelineId, body);
  }

  @Patch("stages/:stageId")
  @RequirePermission("crm:settings:manage")
  updateStage(
    @Param("stageId") stageId: string,
    @Body(new ZodValidationPipe(updateStageSchema)) body: UpdateStageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateStage(u, stageId, body);
  }

  @Delete("stages/:stageId")
  @RequirePermission("crm:settings:manage")
  deleteStage(
    @Param("stageId") stageId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteStage(u, stageId);
  }

  @Get("options/:optionType")
  @RequirePermission("crm:leads:view")
  listOptions(
    @Param("optionType", new ZodValidationPipe(optionTypeSchema)) optionType: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listOptions(u.orgId, optionType);
  }

  @Post("options/:optionType")
  @RequirePermission("crm:settings:manage")
  createOption(
    @Param("optionType", new ZodValidationPipe(optionTypeSchema)) optionType: string,
    @Body(new ZodValidationPipe(createOptionSchema)) body: CreateOptionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createOption(u, optionType, body);
  }

  @Patch("options/:optionType/:optionId")
  @RequirePermission("crm:settings:manage")
  updateOption(
    @Param("optionType", new ZodValidationPipe(optionTypeSchema)) optionType: string,
    @Param("optionId") optionId: string,
    @Body(new ZodValidationPipe(updateOptionSchema)) body: UpdateOptionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateOption(u, optionType, optionId, body);
  }

  @Delete("options/:optionType/:optionId")
  @RequirePermission("crm:settings:manage")
  deleteOption(
    @Param("optionType", new ZodValidationPipe(optionTypeSchema)) optionType: string,
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
  createValidationRule(
    @Body(new ZodValidationPipe(createValidationRuleSchema)) body: CreateValidationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.validationRulesSvc.create(u, body);
  }

  @Patch("validation-rules/:ruleId")
  @RequirePermission("crm:settings:manage")
  updateValidationRule(
    @Param("ruleId") ruleId: string,
    @Body(new ZodValidationPipe(updateValidationRuleSchema)) body: UpdateValidationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.validationRulesSvc.update(u, ruleId, body);
  }

  @Delete("validation-rules/:ruleId")
  @RequirePermission("crm:settings:manage")
  deleteValidationRule(
    @Param("ruleId") ruleId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.validationRulesSvc.delete(u, ruleId);
  }

  @Post("validation-rules/test")
  @RequirePermission("crm:settings:view")
  testValidationRule(
    @Body(new ZodValidationPipe(testValidationSchema)) body: TestValidationInput,
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
  createBlueprint(
    @Body(new ZodValidationPipe(createBlueprintSchema)) body: CreateBlueprintInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.create(u, body);
  }

  @Patch("blueprints/:blueprintId")
  @RequirePermission("crm:settings:manage")
  updateBlueprint(
    @Param("blueprintId") blueprintId: string,
    @Body(new ZodValidationPipe(updateBlueprintSchema)) body: UpdateBlueprintInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.update(u, blueprintId, body);
  }

  @Delete("blueprints/:blueprintId")
  @RequirePermission("crm:settings:manage")
  deleteBlueprint(
    @Param("blueprintId") blueprintId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.delete(u, blueprintId);
  }

  @Post("blueprints/:blueprintId/test-transition")
  @RequirePermission("crm:settings:view")
  testBlueprintTransition(
    @Param("blueprintId") blueprintId: string,
    @Body(new ZodValidationPipe(testTransitionSchema)) body: TestTransitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.testTransition(u.orgId, blueprintId, body.fromStageKey, body.toStageKey, body.record);
  }

  @Post("blueprints/:blueprintId/test")
  @RequirePermission("crm:settings:view")
  testBlueprintTransitionAlias(
    @Param("blueprintId") blueprintId: string,
    @Body(new ZodValidationPipe(testTransitionSchema)) body: TestTransitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.testTransition(u.orgId, blueprintId, body.fromStageKey, body.toStageKey, body.record);
  }

  @Get("blueprints/:blueprintId/transitions")
  @RequirePermission("crm:settings:view")
  listBlueprintTransitions(
    @Param("blueprintId") blueprintId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.listTransitions(u.orgId, blueprintId);
  }

  @Post("blueprints/:blueprintId/transitions")
  @RequirePermission("crm:settings:manage")
  createBlueprintTransition(
    @Param("blueprintId") blueprintId: string,
    @Body(new ZodValidationPipe(createTransitionSchema)) body: CreateTransitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.createTransition(u, blueprintId, body);
  }

  @Patch("blueprints/:blueprintId/transitions/:transitionId")
  @RequirePermission("crm:settings:manage")
  updateBlueprintTransition(
    @Param("blueprintId") blueprintId: string,
    @Param("transitionId") transitionId: string,
    @Body(new ZodValidationPipe(updateTransitionSchema)) body: UpdateTransitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.updateTransition(u, blueprintId, transitionId, body);
  }

  @Delete("blueprints/:blueprintId/transitions/:transitionId")
  @RequirePermission("crm:settings:manage")
  deleteBlueprintTransition(
    @Param("blueprintId") blueprintId: string,
    @Param("transitionId") transitionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.blueprintsSvc.deleteTransition(u, blueprintId, transitionId);
  }
}
