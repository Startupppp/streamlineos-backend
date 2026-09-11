import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { HrDepartmentsService } from "./hr-departments.service";
import { createDepartmentSchema, type CreateDepartmentInput } from "./dto/departments.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";
import { departmentItemSchema } from "./dto/config-response.schemas";

@RequireModule("hr")
@Controller("hr/departments")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrDepartmentsController {
  constructor(private readonly departments: HrDepartmentsService) {}

  @Get()
  @ResponseSchema(z.array(departmentItemSchema))
  @RequirePermission("hr:employees:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.departments.list(u.orgId);
  }

  @Post()
  @ResponseSchema(departmentItemSchema)
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  @Validate({ body: createDepartmentSchema })
  create(
    @Body() body: CreateDepartmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.departments.create(u.orgId, u.userId, body.name);
  }
}
