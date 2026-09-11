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
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { Deprecated } from "../../common/deprecation/deprecated.decorator";
import { SETTINGS_ALIAS_SUNSET } from "./settings-route-deprecation";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  aiUsageResponseSchema,
  gitConnectionListResponseSchema,
  gitConnectionCreateResponseSchema,
  gitConnectionUpdateResponseSchema,
  gitConnectionDeleteResponseSchema,
  updateUserRoleResponseSchema,
  customFieldListResponseSchema,
  customFieldResponseSchema,
  customFieldDeleteResponseSchema,
} from "./dto/settings-response.schemas";
import { SettingsService } from "./settings.service";
import { AiUsageService } from "../ai/usage/ai-usage.service";
import { GitConnectionsService } from "../integrations/git/git-connections.service";
import { CrmCustomFieldsService } from "../crm/custom-fields/crm-custom-fields.service";
import {
  createGitConnectionSchema,
  updateGitConnectionSchema,
  type CreateGitConnectionInput,
  type UpdateGitConnectionInput,
} from "../integrations/git/dto/git-connections.schemas";
import {
  createCustomFieldSchema,
  customFieldsListSchema,
  updateCustomFieldSchema,
  type CreateCustomFieldInput,
  type CustomFieldsListInput,
  type UpdateCustomFieldInput,
} from "../crm/custom-fields/dto/crm-custom-fields.schemas";
import {
  updateUserRoleSchema,
  type UpdateUserRoleInput,
} from "./dto/settings.schemas";

const connectionIdParams = z
  .object({ connectionId: z.coerce.number().int().positive() })
  .strict();
const userIdParams = z.object({ userId: z.string().min(1) }).strict();
const fieldIdParams = z.object({ fieldId: z.coerce.number().int().positive() }).strict();

/** The alias answers with a bare array, as it always has; the cap is the platform page cap. */
const GIT_CONNECTION_ALIAS_PAGE_SIZE = 100;

/**
 * What is still served at the global `/settings` path and should not be.
 *
 * Global settings hold organization configuration and access governance only
 * (root CLAUDE.md §8). Every route here is a module-owned or operational
 * surface that has moved to its owning module; the old path stays, delegating
 * to the same service, so a shipped client keeps working for one release.
 * `@Deprecated` makes the window observable — `Deprecation`, `Sunset` and a
 * `Link` to the canonical path on every response, and `deprecated: true` plus
 * `x-sunset` on the operation.
 *
 * Keeping them in one file rather than scattered through `SettingsController`
 * is the point: this list is exactly the debt, and it should only ever shrink.
 */
@Controller("settings")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SettingsDeprecatedRoutesController {
  constructor(
    private readonly settings: SettingsService,
    private readonly aiUsage: AiUsageService,
    private readonly gitConnections: GitConnectionsService,
    private readonly customFields: CrmCustomFieldsService,
  ) {}

  @RequirePermission("ai:usage:view")
  @ResponseSchema(aiUsageResponseSchema)
  @Get("ai-usage")
  @Deprecated({ sunset: SETTINGS_ALIAS_SUNSET, link: "/ai/usage" })
  getAiUsage(@CurrentUser() u: CurrentUserContext) {
    return this.aiUsage.getOrgUsage(u);
  }

  @Get("integrations/git")
  @ResponseSchema(gitConnectionListResponseSchema)
  @RequirePermission("integrations:git:view")
  @Deprecated({ sunset: SETTINGS_ALIAS_SUNSET, link: "/integrations/git/connections" })
  async listGitConnections(@CurrentUser() u: CurrentUserContext) {
    const page = await this.gitConnections.listConnections(u.orgId, {
      limit: GIT_CONNECTION_ALIAS_PAGE_SIZE,
    });
    return page.data;
  }

  @Post("integrations/git")
  @ResponseSchema(gitConnectionCreateResponseSchema)
  @HttpCode(201)
  @Idempotent("settings.gitConnection.create")
  @RequirePermission("integrations:git:manage")
  @Deprecated({ sunset: SETTINGS_ALIAS_SUNSET, link: "/integrations/git/connections" })
  @Validate({ body: createGitConnectionSchema })
  createGitConnection(
    @Body() body: CreateGitConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.gitConnections.createConnection(u.orgId, u.userId, body);
  }

  @Patch("integrations/git/:connectionId")
  @ResponseSchema(gitConnectionUpdateResponseSchema)
  @RequirePermission("integrations:git:manage")
  @Deprecated({
    sunset: SETTINGS_ALIAS_SUNSET,
    link: "/integrations/git/connections/:connectionId",
  })
  @Validate({ params: connectionIdParams, body: updateGitConnectionSchema })
  updateGitConnection(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @Body() body: UpdateGitConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.gitConnections.updateConnection(u.orgId, connectionId, body);
  }

  @Delete("integrations/git/:connectionId")
  @ResponseSchema(gitConnectionDeleteResponseSchema)
  @RequirePermission("integrations:git:manage")
  @Deprecated({
    sunset: SETTINGS_ALIAS_SUNSET,
    link: "/integrations/git/connections/:connectionId",
  })
  @Validate({ params: connectionIdParams })
  deleteGitConnection(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.gitConnections.deleteConnection(u.orgId, connectionId);
  }

  @RequirePermission("settings:rbac:manage")
  @ResponseSchema(updateUserRoleResponseSchema)
  @Post("users/:userId/role")
  @Deprecated({ sunset: SETTINGS_ALIAS_SUNSET, link: "/organization/members/:memberId" })
  @Idempotent("settings.userRole.update")
  @Validate({ params: userIdParams, body: updateUserRoleSchema })
  updateUserRole(
    @Param("userId") userId: string,
    @Body() body: UpdateUserRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateUserRole(u, userId, body.role);
  }

  /*
   * The four custom-field routes keep the OLD keys, not the new `crm:*` pair.
   * `settings:custom-fields:*` is what ORG_ADMIN and OWNER actually hold today,
   * and re-gating the alias on a key only a CRM rung carries would take the
   * screen away from the very roles that can reach it now — a regression dressed
   * as a move. The canonical `/crm/settings/custom-fields` routes carry
   * `crm:custom-fields:*`, so a `CRM_MODULE_ADMIN` gains the surface without
   * anyone losing it.
   */
  @Get("custom-fields")
  @ResponseSchema(customFieldListResponseSchema)
  @RequirePermission("settings:custom-fields:view")
  @Deprecated({ sunset: SETTINGS_ALIAS_SUNSET, link: "/crm/settings/custom-fields" })
  @Validate({ query: customFieldsListSchema })
  listCustomFields(
    @Query() query: CustomFieldsListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.listCustomFields(u.orgId, query);
  }

  @Post("custom-fields")
  @ResponseSchema(customFieldResponseSchema)
  @HttpCode(201)
  @Idempotent("settings.customField.create")
  @RequirePermission("settings:custom-fields:manage")
  @Deprecated({ sunset: SETTINGS_ALIAS_SUNSET, link: "/crm/settings/custom-fields" })
  @Validate({ body: createCustomFieldSchema })
  createCustomField(
    @Body() body: CreateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.createCustomField(u.orgId, u.userId, body);
  }

  @Patch("custom-fields/:fieldId")
  @ResponseSchema(customFieldResponseSchema)
  @RequirePermission("settings:custom-fields:manage")
  @Deprecated({
    sunset: SETTINGS_ALIAS_SUNSET,
    link: "/crm/settings/custom-fields/:fieldId",
  })
  @Validate({ params: fieldIdParams, body: updateCustomFieldSchema })
  updateCustomField(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @Body() body: UpdateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.updateCustomField(u.orgId, fieldId, body);
  }

  @Delete("custom-fields/:fieldId")
  @ResponseSchema(customFieldDeleteResponseSchema)
  @RequirePermission("settings:custom-fields:manage")
  @Deprecated({
    sunset: SETTINGS_ALIAS_SUNSET,
    link: "/crm/settings/custom-fields/:fieldId",
  })
  @Validate({ params: fieldIdParams })
  deleteCustomField(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.deleteCustomField(u.orgId, fieldId);
  }
}
