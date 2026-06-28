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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { requireAuthorize } from "../../common/access/authorize";
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
@UseGuards(JwtAuthGuard)
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
  listAutomations(@CurrentUser() u: CurrentUserContext) {
    requireAuthorize(u, { permission: "settings:automations:view", requiredModule: "settings" });
    return this.settings.listAutomations(u.orgId);
  }

  @Post("automations")
  @HttpCode(201)
  createAutomation(
    @Body(new ZodValidationPipe(createAutomationSchema)) body: CreateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "settings:automations:manage", requiredModule: "settings" });
    return this.settings.createAutomation(u.orgId, u.userId, body);
  }

  @Get("automations/:ruleId")
  getAutomation(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "settings:automations:view", requiredModule: "settings" });
    return this.settings.getAutomation(u.orgId, ruleId);
  }

  @Patch("automations/:ruleId")
  updateAutomation(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(updateAutomationSchema)) body: UpdateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "settings:automations:manage", requiredModule: "settings" });
    return this.settings.updateAutomation(u.orgId, ruleId, body);
  }

  @Delete("automations/:ruleId")
  deleteAutomation(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "settings:automations:manage", requiredModule: "settings" });
    return this.settings.deleteAutomation(u.orgId, ruleId);
  }

  @Get("automations/:ruleId/runs")
  listAutomationRuns(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "settings:automations:view", requiredModule: "settings" });
    return this.settings.listAutomationRuns(u.orgId, ruleId);
  }

  @Get("custom-fields")
  listCustomFields(
    @Query(new ZodValidationPipe(customFieldsListSchema)) query: CustomFieldsListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "settings:custom-fields:manage", requiredModule: "settings" });
    return this.settings.listCustomFields(u.orgId, query.entityType);
  }

  @Post("custom-fields")
  @HttpCode(201)
  createCustomField(
    @Body(new ZodValidationPipe(createCustomFieldSchema)) body: CreateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "settings:custom-fields:manage", requiredModule: "settings" });
    return this.settings.createCustomField(u.orgId, u.userId, body);
  }

  @Patch("custom-fields/:fieldId")
  updateCustomField(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @Body(new ZodValidationPipe(updateCustomFieldSchema)) body: UpdateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "settings:custom-fields:manage", requiredModule: "settings" });
    return this.settings.updateCustomField(u.orgId, fieldId, body);
  }

  @Delete("custom-fields/:fieldId")
  deleteCustomField(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "settings:custom-fields:manage", requiredModule: "settings" });
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
  listGitConnections(@CurrentUser() u: CurrentUserContext) {
    requireAuthorize(u, { permission: "settings:integrations:manage", requiredModule: "settings" });
    return this.settings.listGitConnections(u.orgId);
  }

  @Post("integrations/git")
  @HttpCode(201)
  createGitConnection(
    @Body(new ZodValidationPipe(createGitConnectionSchema)) body: CreateGitConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "settings:integrations:manage", requiredModule: "settings" });
    return this.settings.createGitConnection(u.orgId, u.userId, body);
  }

  @Patch("integrations/git/:connectionId")
  updateGitConnection(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @Body(new ZodValidationPipe(updateGitConnectionSchema)) body: UpdateGitConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "settings:integrations:manage", requiredModule: "settings" });
    return this.settings.updateGitConnection(u.orgId, connectionId, body);
  }

  @Delete("integrations/git/:connectionId")
  deleteGitConnection(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "settings:integrations:manage", requiredModule: "settings" });
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
