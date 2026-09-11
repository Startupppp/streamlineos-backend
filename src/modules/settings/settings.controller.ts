import {
  Body,
  Header,
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
import { NO_COMPRESSION_HEADER } from "../../common/http/compression.config";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { SettingsService } from "./settings.service";
import { SettingsAutomationsService } from "./settings-automations.service";
import {
  createApiKeySchema,
  createAutomationSchema,
  featureFlagSchema,
  updateAutomationSchema,
  listAutomationsQuerySchema,
  type CreateApiKeyInput,
  type CreateAutomationInput,
  type FeatureFlagInput,
  type ListAutomationsQueryInput,
  type UpdateAutomationInput,
  settingsProvenanceQuerySchema,
  type SettingsProvenanceQuery,
} from "./dto/settings.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  settingsProvenanceResponseSchema,
  apiKeyListResponseSchema,
  apiKeyCreateResponseSchema,
  apiKeyRevokeResponseSchema,
  automationListResponseSchema,
  automationResponseSchema,
  automationDeleteResponseSchema,
  automationRunsListResponseSchema,
  featureFlagsResponseSchema,
  updateFeatureFlagResponseSchema,
} from "./dto/settings-response.schemas";
import { z } from "zod";

const keyIdParams = z.object({ keyId: z.string().min(1) }).strict();
const ruleIdParams = z.object({ ruleId: z.coerce.number().int().positive() }).strict();

@Controller("settings")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly automations: SettingsAutomationsService,
  ) {}

  @RequirePermission("settings:view")
  @ResponseSchema(settingsProvenanceResponseSchema)
  @Get("provenance")
  @Validate({ query: settingsProvenanceQuerySchema })
  getProvenance(
    @Query() query: SettingsProvenanceQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.getSectionProvenance(u.orgId, query.sections);
  }

  @RequirePermission("settings:manage")
  @ResponseSchema(apiKeyListResponseSchema)
  @Get("api-keys")
  listApiKeys(@CurrentUser() u: CurrentUserContext) {
    return this.settings.listApiKeys(u);
  }

  @RequirePermission("settings:manage")
  @ResponseSchema(apiKeyCreateResponseSchema)
  @Post("api-keys")
  @HttpCode(201)
  @Idempotent("settings.apiKey.create")
  @Validate({ body: createApiKeySchema })
  // PRD-C089 (BREACH) — this body carries a credential and `app.enableCors({ credentials:
  // true })` is live, so a compressed length is a cross-origin size oracle.
  @Header(NO_COMPRESSION_HEADER, "1")
  createApiKey(
    @Body() body: CreateApiKeyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.createApiKey(u, body);
  }

  @RequirePermission("settings:manage")
  @ResponseSchema(apiKeyRevokeResponseSchema)
  @Delete("api-keys/:keyId")
  @Validate({ params: keyIdParams })
  revokeApiKey(
    @Param("keyId") keyId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.revokeApiKey(u, keyId);
  }

  @Get("automations")
  @ResponseSchema(automationListResponseSchema)
  @RequirePermission("settings:automations:view")
  @Validate({ query: listAutomationsQuerySchema })
  listAutomations(
    @Query() query: ListAutomationsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.listAutomations(u.orgId, query);
  }

  @Post("automations")
  @ResponseSchema(automationResponseSchema)
  @HttpCode(201)
  @Idempotent("settings.automation.create")
  @RequirePermission("settings:automations:manage")
  @Validate({ body: createAutomationSchema })
  createAutomation(
    @Body() body: CreateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.createAutomation(u.orgId, u.userId, body);
  }

  @Get("automations/:ruleId")
  @ResponseSchema(automationResponseSchema)
  @RequirePermission("settings:automations:view")
  @Validate({ params: ruleIdParams })
  getAutomation(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.getAutomation(u.orgId, ruleId);
  }

  @Patch("automations/:ruleId")
  @ResponseSchema(automationResponseSchema)
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
  @ResponseSchema(automationDeleteResponseSchema)
  @RequirePermission("settings:automations:manage")
  @Validate({ params: ruleIdParams })
  deleteAutomation(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.deleteAutomation(u.orgId, ruleId);
  }

  @Get("automations/:ruleId/runs")
  @ResponseSchema(automationRunsListResponseSchema)
  @RequirePermission("settings:automations:view")
  @Validate({ params: ruleIdParams })
  listAutomationRuns(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.listAutomationRuns(u.orgId, ruleId);
  }

  @RequirePermission("settings:view")
  @ResponseSchema(featureFlagsResponseSchema)
  @Get("feature-flags")
  getFeatureFlags(@CurrentUser() u: CurrentUserContext) {
    return this.settings.getFeatureFlags(u.orgId);
  }

  @RequirePermission("settings:manage")
  @ResponseSchema(updateFeatureFlagResponseSchema)
  @Patch("feature-flags")
  @Validate({ body: featureFlagSchema })
  updateFeatureFlag(
    @Body() body: FeatureFlagInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateFeatureFlag(u, body);
  }
}
