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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import {
  hrFieldDefSchema,
  customFieldEntityValuesSchema,
  customFieldFilterIdsSchema,
} from "./dto/core-response.schemas";

const fieldIdParams = z.object({ fieldId: z.coerce.number().int().positive() }).strict();
const entityTypeentityIdParams = z.object({ entityType: z.string().min(1), entityId: z.string().min(1) }).strict();
const entityTypeParams = z.object({ entityType: z.string().min(1) }).strict();

@RequireModule("hr")
@Controller("hr/custom-fields")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrCustomFieldsController {
  constructor(
    private readonly svc: HrCustomFieldsService,
    private readonly access: AccessService,
  ) {}

  @Get("definitions")
  @ResponseSchema(z.array(hrFieldDefSchema))
  @RequirePermission("hr:custom-fields:manage")
  listDefinitions(
    @Query("entityType") entityType: string = "employee",
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listDefinitions(u.orgId, entityType);
  }

  @Post("definitions")
  @HttpCode(201)
  @ResponseSchema(hrFieldDefSchema)
  @RequirePermission("hr:custom-fields:manage")
  @Validate({ body: createCustomFieldSchema })
  createDefinition(
    @Body() body: CreateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createDefinition(u.orgId, body);
  }

  @Patch("definitions/:fieldId")
  @ResponseSchema(hrFieldDefSchema)
  @RequirePermission("hr:custom-fields:manage")
  @Validate({ params: fieldIdParams, body: updateCustomFieldSchema })
  updateDefinition(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @Body() body: UpdateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateDefinition(u.orgId, fieldId, body);
  }

  @Delete("definitions/:fieldId")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("hr:custom-fields:manage")
  @Validate({ params: fieldIdParams })
  deleteDefinition(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteDefinition(u.orgId, fieldId);
  }

  @Get(":entityType/:entityId/values")
  @ResponseSchema(customFieldEntityValuesSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ params: entityTypeentityIdParams })
  async getValues(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveEmployeesScope(this.access, u);
    return this.svc.getEntityValues(read, entityType, entityId, false);
  }

  @Get(":entityType/:entityId/values/sensitive")
  @ResponseSchema(customFieldEntityValuesSchema)
  @RequirePermission("hr:sensitive:view")
  @Validate({ params: entityTypeentityIdParams })
  async getValuesSensitive(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveEmployeesScope(this.access, u);
    return this.svc.getEntityValues(read, entityType, entityId, true);
  }

  @Put(":entityType/:entityId/values")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:employees:update")
  @Validate({ params: entityTypeentityIdParams, body: upsertCustomFieldValuesSchema })
  async upsertValues(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @Body() body: UpsertCustomFieldValuesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveEmployeesManageScope(this.access, u);
    return this.svc.upsertEntityValues(read, entityType, entityId, body, false);
  }

  @Put(":entityType/:entityId/values/sensitive")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:sensitive:manage")
  @Validate({ params: entityTypeentityIdParams, body: upsertCustomFieldValuesSchema })
  async upsertValuesSensitive(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @Body() body: UpsertCustomFieldValuesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveEmployeesManageScope(this.access, u);
    return this.svc.upsertEntityValues(read, entityType, entityId, body, true);
  }

  @Get(":entityType/filter")
  @ResponseSchema(customFieldFilterIdsSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ params: entityTypeParams, query: filterByCustomFieldQuerySchema })
  async filterByField(
    @Param("entityType") entityType: string,
    @Query() query: FilterByCustomFieldQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveEmployeesScope(this.access, u);
    let value: unknown = undefined;
    if (query.value !== undefined) {
      try {
        value = JSON.parse(query.value);
      } catch {
        throw new BadRequestException("value must be valid JSON");
      }
    }
    const ids = await this.svc.filterByCustomField(
      read,
      entityType,
      query.fieldKey,
      value,
    );
    return { ids };
  }
}
