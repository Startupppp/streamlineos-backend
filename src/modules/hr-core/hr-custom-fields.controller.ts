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
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrCustomFieldsService } from "./hr-custom-fields.service";
import {
  createCustomFieldSchema,
  updateCustomFieldSchema,
  upsertCustomFieldValuesSchema,
  type CreateCustomFieldInput,
  type UpdateCustomFieldInput,
  type UpsertCustomFieldValuesInput,
} from "./dto/hr-custom-fields.schemas";

@RequireModule("hr")
@Controller("hr/custom-fields")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrCustomFieldsController {
  constructor(private readonly svc: HrCustomFieldsService) {}

  @Get("definitions")
  @RequirePermission("hr:employees:view")
  listDefinitions(
    @Query("entityType") entityType: string = "employee",
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listDefinitions(u.orgId, entityType);
  }

  @Post("definitions")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  createDefinition(
    @Body(new ZodValidationPipe(createCustomFieldSchema)) body: CreateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createDefinition(u.orgId, body);
  }

  @Patch("definitions/:fieldId")
  @RequirePermission("hr:employees:manage")
  updateDefinition(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @Body(new ZodValidationPipe(updateCustomFieldSchema)) body: UpdateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateDefinition(u.orgId, fieldId, body);
  }

  @Delete("definitions/:fieldId")
  @HttpCode(204)
  @RequirePermission("hr:employees:manage")
  deleteDefinition(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteDefinition(u.orgId, fieldId);
  }

  @Get(":entityType/:entityId/values")
  @RequirePermission("hr:employees:view")
  getValues(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getEntityValues(u.orgId, entityType, entityId, false);
  }

  @Get(":entityType/:entityId/values/sensitive")
  @RequirePermission("hr:sensitive:view")
  getValuesSensitive(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getEntityValues(u.orgId, entityType, entityId, true);
  }

  @Put(":entityType/:entityId/values")
  @RequirePermission("hr:employees:update")
  upsertValues(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @Body(new ZodValidationPipe(upsertCustomFieldValuesSchema)) body: UpsertCustomFieldValuesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.upsertEntityValues(u.orgId, entityType, entityId, body, false);
  }

  @Put(":entityType/:entityId/values/sensitive")
  @RequirePermission("hr:sensitive:manage")
  upsertValuesSensitive(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @Body(new ZodValidationPipe(upsertCustomFieldValuesSchema)) body: UpsertCustomFieldValuesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.upsertEntityValues(u.orgId, entityType, entityId, body, true);
  }
}
