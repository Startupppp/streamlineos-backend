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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { z } from "zod";
import { Validate } from "../../../common/validation/validate.decorator";
import { SupportCustomFieldsService } from "./support-custom-fields.service";

const fieldIdParams = z.object({ fieldId: z.coerce.number().int().positive() }).strict();
const ticketIdParams = z.object({ ticketId: z.coerce.number().int().positive() }).strict();
import { SupportSettingsAuditService } from "./support-settings-audit.service";
import {
  createCustomFieldSchema,
  updateCustomFieldSchema,
  type CreateCustomFieldInput,
  type UpdateCustomFieldInput,
} from "./dto/support.schemas";

@RequireModule("support")
@Controller("support")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportCustomFieldsController {
  constructor(
    private readonly customFields: SupportCustomFieldsService,
    private readonly audit: SupportSettingsAuditService,
  ) {}

  @Get("custom-fields")
  @RequirePermission("support:tickets:view")
  listFields(@Query("activeOnly") activeOnly: string | undefined, @CurrentUser() u: CurrentUserContext) {
    return this.customFields.listFields(u.orgId, activeOnly === "true");
  }

  @Post("custom-fields")
  @RequirePermission("support:settings:manage")
  @HttpCode(201)
  @Validate({ body: createCustomFieldSchema })
  async createField(
    @Body() body: CreateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.customFields.createField(u.orgId, body);
    await this.audit.record(u.orgId, u.userId, "custom_field", result.id, "created", body);
    return result;
  }

  @Patch("custom-fields/:fieldId")
  @RequirePermission("support:settings:manage")
  @Validate({ params: fieldIdParams, body: updateCustomFieldSchema })
  async updateField(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @Body() body: UpdateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.customFields.updateField(u.orgId, fieldId, body);
    await this.audit.record(u.orgId, u.userId, "custom_field", fieldId, "updated", body);
    return result;
  }

  @Delete("custom-fields/:fieldId")
  @RequirePermission("support:settings:manage")
  @Validate({ params: fieldIdParams })
  async deleteField(@Param("fieldId", ParseIntPipe) fieldId: number, @CurrentUser() u: CurrentUserContext) {
    const result = await this.customFields.deleteField(u.orgId, fieldId);
    await this.audit.record(u.orgId, u.userId, "custom_field", fieldId, "deleted");
    return result;
  }

  @Get(":ticketId/custom-fields")
  @RequirePermission("support:tickets:view")
  @Validate({ params: ticketIdParams })
  getTicketFieldValues(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    return this.customFields.getFieldValues(u.orgId, ticketId);
  }
}
