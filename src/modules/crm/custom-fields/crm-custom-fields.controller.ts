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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { CrmCustomFieldsService } from "./crm-custom-fields.service";
import {
  createCustomFieldSchema,
  customFieldsListSchema,
  updateCustomFieldSchema,
  type CreateCustomFieldInput,
  type CustomFieldsListInput,
  type UpdateCustomFieldInput,
} from "./dto/crm-custom-fields.schemas";

const fieldIdParams = z.object({ fieldId: z.coerce.number().int().positive() }).strict();

/**
 * Custom field definitions are a module-owned surface, so they live in the
 * module's own settings (root CLAUDE.md §8) rather than at the global
 * `/settings/*` path they were served from.
 *
 * The keys move with the route. `settings:custom-fields:*` is held by ORG_ADMIN
 * and OWNER only — no seeded rung, no template — so a `CRM_MODULE_ADMIN` could
 * not open CRM's own custom-fields screen without borrowing organisation
 * administration. `crm:custom-fields:*` sits in the `crm` namespace, which means
 * `moduleScopedPermissions("crm")` picks it up with no extra-keys entry:
 * `CRM_MODULE_ADMIN` receives both, `CRM_MODULE_MEMBER` receives the view key,
 * and `RoleGrantReconcilerService` delivers them to organisations that already
 * exist. The old paths survive one release on
 * `SettingsDeprecatedRoutesController`, still gated on the old keys so no
 * ORG_ADMIN loses a screen mid-release.
 */
@RequireModule("crm")
@Controller("crm/settings/custom-fields")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmCustomFieldsController {
  constructor(private readonly customFields: CrmCustomFieldsService) {}

  @Get()
  @RequirePermission("crm:custom-fields:view")
  @Validate({ query: customFieldsListSchema })
  listCustomFields(
    @Query() query: CustomFieldsListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.listCustomFields(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  @Idempotent("crm.customField.create")
  @RequirePermission("crm:custom-fields:manage")
  @Validate({ body: createCustomFieldSchema })
  createCustomField(
    @Body() body: CreateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.createCustomField(u.orgId, u.userId, body);
  }

  @Patch(":fieldId")
  @RequirePermission("crm:custom-fields:manage")
  @Validate({ params: fieldIdParams, body: updateCustomFieldSchema })
  updateCustomField(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @Body() body: UpdateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.updateCustomField(u.orgId, fieldId, body);
  }

  @Delete(":fieldId")
  @RequirePermission("crm:custom-fields:manage")
  @Validate({ params: fieldIdParams })
  deleteCustomField(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.deleteCustomField(u.orgId, fieldId);
  }
}
