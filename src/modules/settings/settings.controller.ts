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
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { SettingsService } from "./settings.service";
import { SettingsAutomationsService } from "./settings-automations.service";
import { SettingsCustomFieldsService } from "./settings-custom-fields.service";
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
  listAutomationsQuerySchema,
  type CreateApiKeyInput,
  type CreateAutomationInput,
  type CreateCustomFieldInput,
  type CreateGitConnectionInput,
  type CustomFieldsListInput,
  type FeatureFlagInput,
  type ListAutomationsQueryInput,
  type UpdateAutomationInput,
  type UpdateCustomFieldInput,
  type UpdateGitConnectionInput,
  type UpdateUserRoleInput,
  settingsProvenanceQuerySchema,
  type SettingsProvenanceQuery,
} from "./dto/settings.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const keyIdParams = z.object({ keyId: z.string().min(1) }).strict();
const ruleIdParams = z.object({ ruleId: z.coerce.number().int().positive() }).strict();
const fieldIdParams = z.object({ fieldId: z.coerce.number().int().positive() }).strict();
const connectionIdParams = z.object({ connectionId: z.coerce.number().int().positive() }).strict();
const userIdParams = z.object({ userId: z.string().min(1) }).strict();

@Controller("settings")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly automations: SettingsAutomationsService,
    private readonly customFields: SettingsCustomFieldsService,
  ) {}

  @RequirePermission("settings:view")
  @Get("provenance")
  @Validate({ query: settingsProvenanceQuerySchema })
  getProvenance(
    @Query() query: SettingsProvenanceQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.getSectionProvenance(u.orgId, query.sections);
  }

  @RequirePermission("settings:view")
  @Get("permissions")
  getPermissions() {
    return this.settings.getPermissions();
  }

  @RequirePermission("settings:manage")
  @Get("ai-usage")
  getAiUsage(@CurrentUser() u: CurrentUserContext) {
    return this.settings.getAiUsage(u);
  }

  @RequirePermission("settings:api-tokens:read")
  @Get("api-keys")
  listApiKeys(@CurrentUser() u: CurrentUserContext) {
    return this.settings.listApiKeys(u);
  }

  @RequirePermission("settings:api-tokens:write")
  @Post("api-keys")
  @HttpCode(201)
  @Validate({ body: createApiKeySchema })
  createApiKey(
    @Body() body: CreateApiKeyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.createApiKey(u, body);
  }

  @RequirePermission("settings:api-tokens:write")
  @Delete("api-keys/:keyId")
  @Validate({ params: keyIdParams })
  revokeApiKey(
    @Param("keyId") keyId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.revokeApiKey(u, keyId);
  }

  @Get("automations")
  @RequirePermission("settings:automations:view")
  @Validate({ query: listAutomationsQuerySchema })
  listAutomations(
    @Query() query: ListAutomationsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.listAutomations(u.orgId, query);
  }

  @Post("automations")
  @HttpCode(201)
  @RequirePermission("settings:automations:manage")
  @Validate({ body: createAutomationSchema })
  createAutomation(
    @Body() body: CreateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.createAutomation(u.orgId, u.userId, body);
  }

  @Get("automations/:ruleId")
  @RequirePermission("settings:automations:view")
  @Validate({ params: ruleIdParams })
  getAutomation(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.getAutomation(u.orgId, ruleId);
  }

  @Patch("automations/:ruleId")
  @RequirePermission("settings:automations:manage")
  @Validate({ params: ruleIdParams, body: updateAutomationSchema })
  updateAutomation(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body() body: UpdateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.updateAutomation(u.orgId, ruleId, body);
  }

  @Delete("automations/:ruleId")
  @RequirePermission("settings:automations:manage")
  @Validate({ params: ruleIdParams })
  deleteAutomation(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.deleteAutomation(u.orgId, ruleId);
  }

  @Get("automations/:ruleId/runs")
  @RequirePermission("settings:automations:view")
  @Validate({ params: ruleIdParams })
  listAutomationRuns(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.listAutomationRuns(u.orgId, ruleId);
  }

  @Get("custom-fields")
  @RequirePermission("settings:custom-fields:manage")
  @Validate({ query: customFieldsListSchema })
  listCustomFields(
    @Query() query: CustomFieldsListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.listCustomFields(u.orgId, query.entityType);
  }

  @Post("custom-fields")
  @HttpCode(201)
  @RequirePermission("settings:custom-fields:manage")
  @Validate({ body: createCustomFieldSchema })
  createCustomField(
    @Body() body: CreateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.createCustomField(u.orgId, u.userId, body);
  }

  @Patch("custom-fields/:fieldId")
  @RequirePermission("settings:custom-fields:manage")
  @Validate({ params: fieldIdParams, body: updateCustomFieldSchema })
  updateCustomField(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @Body() body: UpdateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.updateCustomField(u.orgId, fieldId, body);
  }

  @Delete("custom-fields/:fieldId")
  @RequirePermission("settings:custom-fields:manage")
  @Validate({ params: fieldIdParams })
  deleteCustomField(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.deleteCustomField(u.orgId, fieldId);
  }

  @RequirePermission("settings:view")
  @Get("feature-flags")
  getFeatureFlags(@CurrentUser() u: CurrentUserContext) {
    return this.settings.getFeatureFlags(u.orgId);
  }

  @RequirePermission("settings:manage")
  @Patch("feature-flags")
  @Validate({ body: featureFlagSchema })
  updateFeatureFlag(
    @Body() body: FeatureFlagInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateFeatureFlag(u, body);
  }

  @Get("integrations/git")
  @RequirePermission("settings:manage")
  listGitConnections(@CurrentUser() u: CurrentUserContext) {
    return this.settings.listGitConnections(u.orgId);
  }

  @Post("integrations/git")
  @HttpCode(201)
  @RequirePermission("settings:manage")
  @Validate({ body: createGitConnectionSchema })
  createGitConnection(
    @Body() body: CreateGitConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.createGitConnection(u.orgId, u.userId, body);
  }

  @Patch("integrations/git/:connectionId")
  @RequirePermission("settings:manage")
  @Validate({ params: connectionIdParams, body: updateGitConnectionSchema })
  updateGitConnection(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @Body() body: UpdateGitConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateGitConnection(u.orgId, connectionId, body);
  }

  @Delete("integrations/git/:connectionId")
  @RequirePermission("settings:manage")
  @Validate({ params: connectionIdParams })
  deleteGitConnection(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.deleteGitConnection(u.orgId, connectionId);
  }

  @RequirePermission("settings:rbac:manage")
  @Post("users/:userId/role")
  @Validate({ params: userIdParams, body: updateUserRoleSchema })
  updateUserRole(
    @Param("userId") userId: string,
    @Body() body: UpdateUserRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateUserRole(u, userId, body.role);
  }
}
