import {
  BadRequestException,
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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { HrCustomFieldsService } from "./hr-custom-fields.service";
import { AccessService } from "../../access/access.service";
import {
  resolveEmployeesManageScope,
  resolveEmployeesScope,
} from "../directory/employees-scope";
import {
  createCustomFieldSchema,
  filterByCustomFieldQuerySchema,
  updateCustomFieldSchema,
  upsertCustomFieldValuesSchema,
  type CreateCustomFieldInput,
  type FilterByCustomFieldQuery,
  type UpdateCustomFieldInput,
  type UpsertCustomFieldValuesInput,
} from "./dto/hr-custom-fields.schemas";

@RequireModule("hr")
@Controller("hr/custom-fields")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrCustomFieldsController {
  constructor(
    private readonly svc: HrCustomFieldsService,
    private readonly access: AccessService,
  ) {}

  @Get("definitions")
  @RequirePermission("hr:custom-fields:manage")
  listDefinitions(
    @Query("entityType") entityType: string = "employee",
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listDefinitions(u.orgId, entityType);
  }

  @Post("definitions")
  @HttpCode(201)
  @RequirePermission("hr:custom-fields:manage")
  createDefinition(
    @Body(new ZodValidationPipe(createCustomFieldSchema)) body: CreateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createDefinition(u.orgId, body);
  }

  @Patch("definitions/:fieldId")
  @RequirePermission("hr:custom-fields:manage")
  updateDefinition(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @Body(new ZodValidationPipe(updateCustomFieldSchema)) body: UpdateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateDefinition(u.orgId, fieldId, body);
  }

  @Delete("definitions/:fieldId")
  @HttpCode(204)
  @RequirePermission("hr:custom-fields:manage")
  deleteDefinition(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteDefinition(u.orgId, fieldId);
  }

  @Get(":entityType/:entityId/values")
  @RequirePermission("hr:employees:view")
  async getValues(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, u);
    return this.svc.getEntityValues(
      u.orgId,
      u.userId,
      scope,
      entityType,
      entityId,
      false,
    );
  }

  @Get(":entityType/:entityId/values/sensitive")
  @RequirePermission("hr:sensitive:view")
  async getValuesSensitive(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, u);
    return this.svc.getEntityValues(
      u.orgId,
      u.userId,
      scope,
      entityType,
      entityId,
      true,
    );
  }

  @Put(":entityType/:entityId/values")
  @RequirePermission("hr:employees:update")
  async upsertValues(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @Body(new ZodValidationPipe(upsertCustomFieldValuesSchema)) body: UpsertCustomFieldValuesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesManageScope(this.access, u);
    return this.svc.upsertEntityValues(
      u.orgId,
      u.userId,
      scope,
      entityType,
      entityId,
      body,
      false,
    );
  }

  @Put(":entityType/:entityId/values/sensitive")
  @RequirePermission("hr:sensitive:manage")
  async upsertValuesSensitive(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @Body(new ZodValidationPipe(upsertCustomFieldValuesSchema)) body: UpsertCustomFieldValuesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesManageScope(this.access, u);
    return this.svc.upsertEntityValues(
      u.orgId,
      u.userId,
      scope,
      entityType,
      entityId,
      body,
      true,
    );
  }

  @Get(":entityType/filter")
  @RequirePermission("hr:employees:view")
  async filterByField(
    @Param("entityType") entityType: string,
    @Query(new ZodValidationPipe(filterByCustomFieldQuerySchema)) query: FilterByCustomFieldQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, u);
    let value: unknown = undefined;
    if (query.value !== undefined) {
      try {
        value = JSON.parse(query.value);
      } catch {
        throw new BadRequestException("value must be valid JSON");
      }
    }
    const ids = await this.svc.filterByCustomField(
      u.orgId,
      u.userId,
      scope,
      entityType,
      query.fieldKey,
      value,
    );
    return { ids };
  }
}
