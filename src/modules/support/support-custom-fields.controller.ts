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
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { SupportCustomFieldsService } from "./support-custom-fields.service";
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
  async createField(
    @Body(new ZodValidationPipe(createCustomFieldSchema)) body: CreateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.customFields.createField(u.orgId, body);
    await this.audit.record(u.orgId, u.userId, "custom_field", result.id, "created", body);
    return result;
  }

  @Patch("custom-fields/:id")
  @RequirePermission("support:settings:manage")
  async updateField(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateCustomFieldSchema)) body: UpdateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.customFields.updateField(u.orgId, id, body);
    await this.audit.record(u.orgId, u.userId, "custom_field", id, "updated", body);
    return result;
  }

  @Delete("custom-fields/:id")
  @RequirePermission("support:settings:manage")
  async deleteField(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    const result = await this.customFields.deleteField(u.orgId, id);
    await this.audit.record(u.orgId, u.userId, "custom_field", id, "deleted");
    return result;
  }

  @Get(":ticketId/custom-fields")
  @RequirePermission("support:tickets:view")
  getTicketFieldValues(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    return this.customFields.getFieldValues(u.orgId, ticketId);
  }
}
