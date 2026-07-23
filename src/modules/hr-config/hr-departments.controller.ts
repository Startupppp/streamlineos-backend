import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrDepartmentsService } from "./hr-departments.service";
import { createDepartmentSchema, type CreateDepartmentInput } from "./dto/departments.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/departments")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrDepartmentsController {
  constructor(private readonly departments: HrDepartmentsService) {}

  @Get()
  @RequirePermission("hr:employees:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.departments.list(u.orgId);
  }

  @Get("legacy")
  @RequirePermission("hr:employees:view")
  listLegacy(@CurrentUser() u: CurrentUserContext) {
    return this.departments.listLegacy(u.orgId);
  }

  @Post()
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createDepartmentSchema)) body: CreateDepartmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.departments.create(u.orgId, u.userId, body.name);
  }
}
