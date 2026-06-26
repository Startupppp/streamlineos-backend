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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SettingsService } from "./settings.service";
import {
  createApiKeySchema,
  createAutomationSchema,
  createCustomFieldSchema,
  createGitConnectionSchema,
  customFieldsListSchema,
  featureFlagSchema,
  updateAutomationSchema,
  updateCustomFieldSchema,
  updateGitConnectionSchema,
  updateUserRoleSchema,
  type CreateApiKeyInput,
  type CreateAutomationInput,
  type CreateCustomFieldInput,
  type CreateGitConnectionInput,
  type CustomFieldsListInput,
  type FeatureFlagInput,
  type UpdateAutomationInput,
  type UpdateCustomFieldInput,
  type UpdateGitConnectionInput,
  type UpdateUserRoleInput,
} from "./dto/settings.schemas";

@Controller("settings")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get("permissions")
  getPermissions() {
    return this.settings.getPermissions();
  }

  @Get("ai-usage")
  getAiUsage(@CurrentUser() u: CurrentUserContext) {
    return this.settings.getAiUsage(u);
  }

  @Get("api-keys")
  listApiKeys(@CurrentUser() u: CurrentUserContext) {
    return this.settings.listApiKeys(u);
  }

  @Post("api-keys")
  @HttpCode(201)
  createApiKey(
    @Body(new ZodValidationPipe(createApiKeySchema)) body: CreateApiKeyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.createApiKey(u, body);
  }

  @Delete("api-keys/:keyId")
  revokeApiKey(@Param("keyId") keyId: string, @CurrentUser() u: CurrentUserContext) {
    return this.settings.revokeApiKey(u, keyId);
  }

  @Get("automations")
  @CheckAbility("view", "settings:automations")
  listAutomations(@CurrentUser() u: CurrentUserContext) {
    return this.settings.listAutomations(u.orgId);
  }

  @Post("automations")
  @HttpCode(201)
  @CheckAbility("manage", "settings:automations")
  createAutomation(
    @Body(new ZodValidationPipe(createAutomationSchema)) body: CreateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.createAutomation(u.orgId, u.userId, body);
  }

  @Get("automations/:ruleId")
  @CheckAbility("view", "settings:automations")
  getAutomation(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.getAutomation(u.orgId, ruleId);
  }

  @Patch("automations/:ruleId")
  @CheckAbility("manage", "settings:automations")
  updateAutomation(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(updateAutomationSchema)) body: UpdateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateAutomation(u.orgId, ruleId, body);
  }

  @Delete("automations/:ruleId")
  @CheckAbility("manage", "settings:automations")
  deleteAutomation(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.deleteAutomation(u.orgId, ruleId);
  }

  @Get("automations/:ruleId/runs")
  @CheckAbility("view", "settings:automations")
  listAutomationRuns(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.listAutomationRuns(u.orgId, ruleId);
  }

  @Get("custom-fields")
  @CheckAbility("manage", "settings:custom-fields")
  listCustomFields(
    @Query(new ZodValidationPipe(customFieldsListSchema)) query: CustomFieldsListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.listCustomFields(u.orgId, query.entityType);
  }

  @Post("custom-fields")
  @HttpCode(201)
  @CheckAbility("manage", "settings:custom-fields")
  createCustomField(
    @Body(new ZodValidationPipe(createCustomFieldSchema)) body: CreateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.createCustomField(u.orgId, u.userId, body);
  }

  @Patch("custom-fields/:fieldId")
  @CheckAbility("manage", "settings:custom-fields")
  updateCustomField(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @Body(new ZodValidationPipe(updateCustomFieldSchema)) body: UpdateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateCustomField(u.orgId, fieldId, body);
  }

  @Delete("custom-fields/:fieldId")
  @CheckAbility("manage", "settings:custom-fields")
  deleteCustomField(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.deleteCustomField(u.orgId, fieldId);
  }

  @Get("feature-flags")
  getFeatureFlags(@CurrentUser() u: CurrentUserContext) {
    return this.settings.getFeatureFlags(u.orgId);
  }

  @Patch("feature-flags")
  updateFeatureFlag(
    @Body(new ZodValidationPipe(featureFlagSchema)) body: FeatureFlagInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateFeatureFlag(u, body);
  }

  @Get("integrations/git")
  @CheckAbility("manage", "settings")
  listGitConnections(@CurrentUser() u: CurrentUserContext) {
    return this.settings.listGitConnections(u.orgId);
  }

  @Post("integrations/git")
  @HttpCode(201)
  @CheckAbility("manage", "settings")
  createGitConnection(
    @Body(new ZodValidationPipe(createGitConnectionSchema)) body: CreateGitConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.createGitConnection(u.orgId, u.userId, body);
  }

  @Patch("integrations/git/:connectionId")
  @CheckAbility("manage", "settings")
  updateGitConnection(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @Body(new ZodValidationPipe(updateGitConnectionSchema)) body: UpdateGitConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateGitConnection(u.orgId, connectionId, body);
  }

  @Delete("integrations/git/:connectionId")
  @CheckAbility("manage", "settings")
  deleteGitConnection(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.deleteGitConnection(u.orgId, connectionId);
  }

  @Post("users/:userId/role")
  updateUserRole(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updateUserRoleSchema)) body: UpdateUserRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateUserRole(u, userId, body.role);
  }
}
